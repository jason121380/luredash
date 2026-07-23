from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from collections import Counter, deque
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, List
from zoneinfo import ZoneInfo
import asyncio
import random
import traceback
import base64
import hashlib
import hmac
import json
import math
import httpx
import os
from dotenv import load_dotenv
from pathlib import Path
from pydantic import BaseModel

import asyncpg

import uuid

import ezpay_client
import line_client

load_dotenv()

APP_ID = os.getenv("FB_APP_ID")
APP_SECRET = os.getenv("FB_APP_SECRET")
_ACCESS_TOKEN = os.getenv("FB_ACCESS_TOKEN")
API_VERSION = os.getenv("FB_API_VERSION", "v21.0")
BASE_URL = f"https://graph.facebook.com/{API_VERSION}"
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")

# Runtime token override (from FB Login). Legacy global — kept as a
# fallback for code paths that haven't been migrated to per-user tokens
# yet (notably the public `/r/<campaign_id>` share page, where the
# viewer has no session). Phase A is migrating callers to use the
# per-user `_user_token_cache` via the `_current_fb_user_id` contextvar.
_runtime_token: Optional[str] = None
# Per-user FB access tokens, loaded from `user_fb_tokens` PG table on
# lifespan startup and updated on every `/api/auth/token` POST. Each
# logged-in operator's FB calls are routed through THEIR OWN token via
# the `_current_fb_user_id` contextvar, so user A doesn't see user B's
# BMs / ad accounts (the "multi-tenant FB data isolation" goal).
_user_token_cache: dict[str, str] = {}

# Captured exception from DB initialisation (if any). Set in the
# lifespan startup try/except so `/api/_status` can surface it
# without operators needing to dig through Zeabur logs to find the
# "[startup] DB: FAILED" line.
_db_startup_error: Optional[str] = None
import contextvars

# Per-request context for "which FB user is currently making this
# call". Set by `_user_context_middleware` from `?fb_user_id=…` (or
# `x-fb-user-id` header), and by background tasks (scheduler, warm
# loop) from the channel-owner / config-owner of the work item being
# processed. Read by `get_token()` to look up the right per-user
# token. Default None means "no user context known" — `get_token()`
# falls back to the legacy global runtime token in that case (the
# share-page path).
_current_fb_user_id: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "current_fb_user_id", default=None
)
# 觸發來源 — propagates the "why are we making this FB call?" tag down
# from the entry point (route handler / scheduler tick / warm loop)
# so the ring buffer can surface it to the operator. Used purely for
# diagnostics; no behavior changes based on the source.
#
# Known values (frontend formats these in plain Chinese):
#   dashboard / report / breakdown / share-page / settings  — user views
#   warm                                                     — cache warm loop
#   line-push                                                — campaign LINE 推播 scheduler
#   security-push                                            — 安全監控自動掃 scheduler
#   security-probe                                           — legacy 安全監控 cheap probe 紀錄
#   security-test                                            — 推播設定 modal 的「測試」按鈕
#   history-warm                                             — 每月自動重熱上個月快照 scheduler
#   unknown                                                  — fallback (some helper that didn't tag)
_fb_call_source: contextvars.ContextVar[str] = contextvars.ContextVar(
    "fb_call_source", default="unknown"
)

# In-memory set of FB user ids that have successfully completed
# `POST /api/auth/token`. Persisted to `shared_settings._fb_known_users`
# so it survives restarts. Used by `_assert_known_user()` to reject
# read endpoints that take `fb_user_id` as a query param from
# unauthenticated callers — without it any visitor knowing a valid
# operator id could probe billing / AI 幕僚 endpoints.
_KNOWN_FB_USERS: "set[str]" = set()
# Shared httpx client (created in lifespan)
_http_client: Optional[httpx.AsyncClient] = None
# Shared asyncpg pool (created in lifespan when DATABASE_URL is set).
# None when running locally without a DB — the nickname endpoints return
# empty / 503 rather than crashing, so the rest of the app stays usable.
_db_pool: Optional[asyncpg.Pool] = None
DATABASE_URL = os.getenv("DATABASE_URL", "")
DEFAULT_PUBLIC_SITE_URL = "https://luredash.lure.com.tw"

# Limit concurrent outbound FB API calls. Keep this deliberately below
# "what the server can handle": FB BUCU is dominated by processing time
# on heavy insights edges, so fewer concurrent calls often lowers the
# throttle risk more than it hurts wall-clock latency. Override with
# FB_GLOBAL_CONCURRENCY only during controlled debugging.
def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


_SESSION_SECRET = os.getenv("SESSION_SECRET") or APP_SECRET or ""
_SESSION_TTL_SECONDS = _env_int("SESSION_TTL_SECONDS", 7 * 24 * 60 * 60)
_LEGACY_FB_USER_HEADER_AUTH = os.getenv("LEGACY_FB_USER_HEADER_AUTH", "0") == "1"
if not _SESSION_SECRET:
    print(
        "[startup] WARNING: SESSION_SECRET and FB_APP_SECRET are unset — "
        "signed sessions will be rejected. Set SESSION_SECRET in production.",
        flush=True,
    )
elif os.getenv("SESSION_SECRET") is None:
    print(
        "[startup] WARNING: SESSION_SECRET unset — using FB_APP_SECRET for session signing. "
        "Set a dedicated SESSION_SECRET before multi-user production.",
        flush=True,
    )

_FB_GLOBAL_CONCURRENCY = _env_int("FB_GLOBAL_CONCURRENCY", 12)
_fb_semaphore: asyncio.Semaphore = asyncio.Semaphore(_FB_GLOBAL_CONCURRENCY)

# Per-ad-account in-flight limiter. FB's 80004 throttle is computed
# per-ad-account, so even when the global _fb_semaphore is well below
# its 40-cap, 30 calls hitting the SAME account simultaneously can
# trip the throttle. 4 in-flight per account keeps us under the
# per-account ceiling on a Limited Access tier and effectively
# unlimited on Full Access. Only paths that start with `act_<id>`
# pass through this gate; single-entity by-id calls (campaigns /
# adsets / ads) bypass since the path doesn't reveal which account
# owns them and they're rarely the burst culprit.
_PER_ACCOUNT_CONCURRENCY = _env_int("FB_PER_ACCOUNT_CONCURRENCY", 2)
_per_account_semaphores: dict[str, asyncio.Semaphore] = {}
_OVERVIEW_ACCOUNT_CONCURRENCY = _env_int("OVERVIEW_ACCOUNT_CONCURRENCY", 4)

# Security monitor background work is extra conservative because it is
# not user-facing latency. It should never compete aggressively with
# the dashboard for FB quota.
_SECURITY_SCAN_CONCURRENCY = _env_int("SECURITY_SCAN_CONCURRENCY", 2)
_SECURITY_PUSH_MAX_CONFIGS_PER_TICK = _env_int("SECURITY_PUSH_MAX_CONFIGS_PER_TICK", 3)
_SECURITY_PUSH_ENRICH_CREATORS = os.getenv("SECURITY_PUSH_ENRICH_CREATORS", "0") == "1"
_SECURITY_PUSH_SCAN_CACHE_TTL_SECONDS = _env_int("SECURITY_PUSH_SCAN_CACHE_TTL_SECONDS", 120)


class _NullAsyncContext:
    """No-op async context manager used in place of the per-account
    semaphore for paths that don't carry an ad-account id. Keeps the
    `async with (sem if sem else _NULL_CTX)` site free of branching."""

    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *_exc: object) -> None:
        return None


_NULL_CTX = _NullAsyncContext()


def _extract_account_id_from_path(path: str) -> Optional[str]:
    """Pull `act_<id>` from a Graph API path. Returns None when the
    path doesn't start with an account prefix (e.g. /me, /<page_id>,
    /<campaign_id>/adsets — the parent account isn't directly
    addressable from the path)."""
    if not path or not path.startswith("act_"):
        return None
    head = path.split("/", 1)[0]
    return head if head.startswith("act_") else None


def _account_semaphore(account_id: str) -> asyncio.Semaphore:
    sem = _per_account_semaphores.get(account_id)
    if sem is None:
        sem = asyncio.Semaphore(_PER_ACCOUNT_CONCURRENCY)
        _per_account_semaphores[account_id] = sem
    return sem


# Tracks which (account_id, kind, date_preset, time_range, fb_user_id)
# tuples have been fetched recently. The cache-warm loop reads this
# to pick entries to refresh just before they expire so user-facing
# reads always land on warm cache. fb_user_id is part of the key
# because Phase A made FB calls per-user — the same (account_id,
# date) tuple from two users uses two different tokens and lives in
# two separate cache entries, so the warm loop must refresh under
# the same user context the original read used. Entries older than
# 10 min are skipped (cold accounts don't get re-warmed; this keeps
# background FB usage bounded by what's actually being looked at).
WarmTargetKey = tuple[str, str, str, Optional[str], str]
_warm_targets: dict[WarmTargetKey, float] = {}
# Last time the warm loop attempted a target. Kept separate from
# `_warm_targets` so background refreshes don't pretend the user is
# still actively looking at that account.
_warm_attempted_at: dict[WarmTargetKey, float] = {}
_WARM_TARGET_SUPPRESSED_SOURCES = {
    "warm",
    "line-push",
    "security-push",
    "security-probe",
    "security-test",
    "history-warm",
}


def _register_warm_target(
    account_id: str,
    kind: str,
    date_preset: str,
    time_range: Optional[str],
) -> None:
    """Track user-facing reads for optional cache warming.

    Background jobs must not extend the "recently accessed" window.
    Otherwise the warm loop can keep a once-viewed account alive
    forever by refreshing it and then re-registering itself as fresh
    access.
    """
    if _fb_call_source.get() in _WARM_TARGET_SUPPRESSED_SOURCES:
        return
    warm_uid = _current_fb_user_id.get() or ""
    if not warm_uid:
        return
    key: WarmTargetKey = (account_id, kind, date_preset, time_range, warm_uid)
    now = time.monotonic()
    _warm_targets[key] = now
    # A foreground read just used or populated the cache. Give the
    # entry most of its TTL before the warm loop considers it again.
    _warm_attempted_at[key] = now

# Security push scan result cache. Multiple configs often belong to the
# same owner and watch the same selected account set; without this each
# config repeats the same FB campaign fetches inside one scheduler
# tick. Keep it short-lived only: a one-hour cache can make the next
# hourly scan reuse the previous scan window and miss campaigns created
# after that run.
_security_push_scan_cache: dict[tuple[str, tuple[str, ...]], dict[str, Any]] = {}

# Set whenever we observe an 80004 throttle response. The warm loop
# checks this and backs off for 10 minutes — the absolute last thing
# we want is the warm loop poking the throttled account again and
# extending the lockout. This is the global "any account 80004'd
# recently" flag; the per-account version below lets unrelated
# accounts keep getting served while the throttled one is gated.
_last_ads_throttle_at: float = 0.0

# App/user/page-level Graph API rate limits (e.g. code 4, 17, 32, 613)
# are not tied to one ad account. When FB sends one of these, continuing
# to call a different edge still burns the same app/user bucket, so we
# install a short global circuit breaker and make every FB caller fail
# fast until it cools down.
_global_fb_throttle_until: float = 0.0

# Per-ad-account throttle deadline. When 80000-80014 fires for an
# account we store `time.monotonic() + cooldown` here; `_fb_request`
# checks this BEFORE acquiring a semaphore and short-circuits to a
# 429 instead of issuing a call that would just extend the lockout.
# Cooldown = max(600s, BUCU regain seconds) so we always wait at
# least 10 minutes even when FB's header says "0 minutes" (which it
# sometimes does immediately after the throttle fires).
_account_throttle_until: dict[str, float] = {}

# Per-account FB capability memory. Some ad accounts reject optional
# /campaigns parameters with Graph code=100 (Invalid parameter), most
# commonly the archived effective_status filter. Once observed, skip that
# optional tier for a while instead of paying one doomed FB call on every
# dashboard load.
_CAMPAIGNS_CAPABILITY_TTL_SECONDS = _env_int("CAMPAIGNS_CAPABILITY_TTL_SECONDS", 24 * 60 * 60)
_campaigns_unsupported_until: dict[tuple[str, str], float] = {}

# Ring buffer of the last N FB Graph API calls (success + error).
# Each entry: {ts, path, account_id, method, ms, status, bucu_peak_pct,
# cache_hit, error_code, retried}. Read-only — surfaced via
# /api/engineering/fb-calls so operators can correlate "rate-limit
# spike at HH:MM:SS" with the actual paths that were in flight.
# 500 entries × ~150 bytes ≈ 75 KB, well within budget.
_fb_call_log: deque = deque(maxlen=500)

# Per-account 80000-80014 throttle event history. Last 20 events per
# account (timestamp + path + error_code) so the engineering panel
# can answer "which account is being throttled most often?". Older
# events fall off the deque automatically.
_account_throttle_events: dict[str, deque] = {}
_global_throttle_events: deque = deque(maxlen=20)

# ── LINE push scheduler ─────────────────────────────────────────────
# `_scheduler_task` holds the background asyncio task started in
# lifespan so we can cancel it cleanly on shutdown. The loop ticks
# every SCHEDULER_TICK_SECONDS and fires any push configs whose
# next_run_at has passed. SCHEDULER_FAIL_THRESHOLD consecutive failures
# flip `enabled=false` so a broken token doesn't spam the log forever.
_scheduler_task: Optional[asyncio.Task] = None
_warm_task: Optional[asyncio.Task] = None
# Background fire-and-forget tasks (e.g. one-shot LINE group name
# backfill on startup). We hold strong refs so asyncio doesn't gc
# them mid-run. Tasks self-discard via `add_done_callback`.
_bg_tasks: "set[asyncio.Task]" = set()
SCHEDULER_TICK_SECONDS = 60
# 5 consecutive failures auto-disable a push config. Failures now RETRY
# with 10min × fail_count backoff (10+20+30+40 ≈ 100min of tolerance), so
# a typical ~1h FB throttle window no longer eats the whole budget the
# way the old threshold of 3 (~30min) would; genuinely-dead configs
# (bot kicked, expired token) still get disabled within a couple hours.
SCHEDULER_FAIL_THRESHOLD = 5
SCHEDULER_TZ_NAME = os.getenv("SCHEDULER_TZ", "Asia/Taipei")


def _scheduler_tz() -> ZoneInfo:
    try:
        return ZoneInfo(SCHEDULER_TZ_NAME)
    except Exception:
        return ZoneInfo("Asia/Taipei")


def get_token() -> str:
    """Resolve the FB access token for the current call.

    Resolution order:
      1. The per-user token for `_current_fb_user_id` (set by the
         middleware from `?fb_user_id=…` or by background tasks
         from a config / channel owner). This is the multi-tenant
         path — each user's calls go through their own token so they
         only see what THEIR FB account has access to.
      2. The legacy `_runtime_token` global, populated by
         `POST /api/auth/token` for backward compatibility.
         Currently used by the public `/r/<campaign_id>` share page
         where the viewer has no session.
      3. The .env `FB_ACCESS_TOKEN` fallback for local dev.
    """
    uid = _current_fb_user_id.get()
    if uid:
        tok = _user_token_cache.get(uid)
        if tok:
            return tok
    return _runtime_token or _ACCESS_TOKEN or ""


def _token_for_user(uid: str) -> Optional[str]:
    """Direct lookup of a specific user's token, bypassing contextvar.
    Used by background tasks that need to call FB on behalf of a known
    user without first setting the contextvar."""
    if not uid:
        return None
    return _user_token_cache.get(uid)


# Built React app output (from frontend/ via `pnpm build`). Served as
# the ONE and ONLY frontend — the legacy dashboard.html + the optional
# PostgreSQL user-settings sync were removed in the React-only cutover.
DIST_DIR = Path(__file__).parent / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http_client, _db_pool
    # Per-request overrides in _fb_fetch_and_cache set the real
    # timeout (10s for GET, 30s for POST). This client-level value
    # is just a safety ceiling for any code path that slips through
    # without an explicit override.
    _http_client = httpx.AsyncClient(
        timeout=30,
        limits=httpx.Limits(max_connections=200, max_keepalive_connections=40),
    )
    if DATABASE_URL:
        try:
            # max_size=5 was too tight: scheduler tick can claim several
            # connections in parallel while the dashboard simultaneously
            # fans out per-account fetches. 10 leaves comfortable
            # headroom AND lets new deploys grab a pool while the old
            # container is still releasing its own — on a Lightsail
            # 2C 2GB PG with max_connections ~20, an old+new combined
            # max of 20 (10 + 10) is the safe ceiling. Tune via env
            # on busy deployments.
            db_pool_max = int(os.getenv("DB_POOL_MAX", "10"))
            db_pool_min = int(os.getenv("DB_POOL_MIN", "2"))
            _db_pool = await asyncpg.create_pool(
                DATABASE_URL,
                min_size=db_pool_min,
                max_size=db_pool_max,
                command_timeout=10,
            )
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS campaign_nicknames (
                        campaign_id TEXT PRIMARY KEY,
                        store TEXT NOT NULL DEFAULT '',
                        designer TEXT NOT NULL DEFAULT '',
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # Schema compatibility guard: the legacy build shipped a
                # different `user_settings` table (pre-2026-04-15 cutover).
                # CREATE TABLE IF NOT EXISTS silently skips when the table
                # exists, so a stale schema would leave INSERTs failing
                # with "column not found" and surface as an HTTP 500.
                # Detect a missing column and recreate the table.
                expected = {"fb_user_id", "key", "value", "updated_at"}
                existing = {
                    r["column_name"]
                    for r in await conn.fetch(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'user_settings'
                        """
                    )
                }
                if existing and not expected.issubset(existing):
                    print(
                        f"[startup] DB: user_settings schema mismatch (has {sorted(existing)}),"
                        f" dropping + recreating",
                        flush=True,
                    )
                    await conn.execute("DROP TABLE IF EXISTS user_settings")
                # Per-user settings — keyed on (fb_user_id, key). Used
                # for things each person toggles privately: selected
                # accounts, account order, etc.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS user_settings (
                        fb_user_id TEXT NOT NULL,
                        key TEXT NOT NULL,
                        value JSONB NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (fb_user_id, key)
                    )
                    """
                )
                # Same defensive check for shared_settings.
                expected_shared = {"key", "value", "updated_at"}
                existing_shared = {
                    r["column_name"]
                    for r in await conn.fetch(
                        """
                        SELECT column_name FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'shared_settings'
                        """
                    )
                }
                if existing_shared and not expected_shared.issubset(existing_shared):
                    print(
                        f"[startup] DB: shared_settings schema mismatch (has {sorted(existing_shared)}),"
                        f" dropping + recreating",
                        flush=True,
                    )
                    await conn.execute("DROP TABLE IF EXISTS shared_settings")
                # Team-wide shared settings — single row per key, visible
                # to every user. Used for markup rules, pins, etc.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS shared_settings (
                        key TEXT PRIMARY KEY,
                        value JSONB NOT NULL,
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # ── LINE push scheduler tables ────────────────────
                # gen_random_uuid() lives in pgcrypto on older PG. PG13+
                # has it in core, but enabling defensively is idempotent
                # and lets the CREATE TABLE below parse its DEFAULT on
                # managed providers that ship PG12.
                try:
                    await conn.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"')
                except Exception as exc:
                    print(f"[startup] DB: pgcrypto extension skipped ({exc})", flush=True)
                # `line_channels` (multi-OA, 2026-04-30): one row per
                # LINE Official Account we push from. Tokens are stored
                # plaintext for now to match `_fb_runtime_token`'s
                # current handling; the P0 audit will encrypt both at
                # the same time using TOKEN_ENC_KEY (Fernet).
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS line_channels (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        name TEXT NOT NULL,
                        channel_secret TEXT NOT NULL,
                        access_token TEXT NOT NULL,
                        enabled BOOLEAN NOT NULL DEFAULT TRUE,
                        is_default BOOLEAN NOT NULL DEFAULT FALSE,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # Migration (2026-04-30): track last webhook activity
                # for diagnostics. Updated by _handle_line_webhook on
                # every signature-verified hit, used by the LINE 推播
                # 設定 UI to show「上次接收: …」 next to each channel.
                # Helps the user distinguish "LINE never reached us"
                # vs "LINE reached us but nothing happened" when groups
                # don't appear after inviting the bot.
                await conn.execute(
                    """
                    ALTER TABLE line_channels
                    ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ
                    """
                )
                # Multi-user (2026-04-30): each channel "belongs to" the
                # FB user who created it. NULL means "shared / legacy".
                await conn.execute(
                    """
                    ALTER TABLE line_channels
                    ADD COLUMN IF NOT EXISTS owner_fb_user_id TEXT
                    """
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_line_channels_owner
                    ON line_channels (owner_fb_user_id)
                    """
                )
                # Only one row may carry is_default = TRUE.
                await conn.execute(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_line_channels_one_default
                    ON line_channels ((1)) WHERE is_default
                    """
                )
                # Channel-secret uniqueness (Phase B): prevents user B
                # from re-adding user A's OA. LINE channels have a
                # globally-unique channel_secret, so a duplicate insert
                # is by definition the same OA. Use a UNIQUE INDEX so
                # we can predicate on `enabled` — a soft-disabled
                # channel from a previous owner shouldn't block re-
                # registration. Existing rows are checked for duplicates
                # by the migration; manual cleanup needed if any pre-
                # 2026-05-08 dataset has duplicates.
                await conn.execute(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_line_channels_secret_unique
                    ON line_channels (channel_secret) WHERE enabled
                    """
                )
                # ── Phase B: LINE OA grants ───────────────────────
                # Lets a channel OWNER share their OA with another FB
                # user. Granted users see the same groups + can manage
                # push configs once they ACCEPT the invitation.
                # Schema: composite PK (channel_id, fb_user_id) so a
                # user can't have two invitations to the same channel.
                # Status flow: pending → accepted | rejected. Rejected
                # rows stay so the same user can't be re-invited
                # immediately after rejecting.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS line_channel_grants (
                        channel_id UUID NOT NULL REFERENCES line_channels(id) ON DELETE CASCADE,
                        fb_user_id TEXT NOT NULL,
                        granted_by_fb_user_id TEXT NOT NULL,
                        status TEXT NOT NULL DEFAULT 'pending',
                        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        responded_at TIMESTAMPTZ,
                        PRIMARY KEY (channel_id, fb_user_id)
                    )
                    """
                )
                # Role on the grant: 'admin' (full edit on groups +
                # push configs, can fire test pushes) or 'viewer'
                # (read-only). Owner can change at any time via the
                # share modal. Existing rows default to 'admin' to
                # preserve current behaviour for pre-role grants.
                await conn.execute(
                    """
                    ALTER TABLE line_channel_grants
                    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'
                    """
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_lcg_user_status
                    ON line_channel_grants (fb_user_id, status)
                    """
                )
                # `line_groups`: populated from the /api/line/webhook
                # join/leave events. We keep left_at instead of deleting
                # so existing push configs don't lose their FK target.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS line_groups (
                        group_id TEXT PRIMARY KEY,
                        label TEXT NOT NULL DEFAULT '',
                        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        left_at TIMESTAMPTZ
                    )
                    """
                )
                # Backfill: real LINE-side group display name (from
                # the /v2/bot/group/{id}/summary endpoint). Separate
                # from `label`, which is the user-editable nickname.
                await conn.execute(
                    """
                    ALTER TABLE line_groups
                    ADD COLUMN IF NOT EXISTS group_name TEXT NOT NULL DEFAULT ''
                    """
                )
                # Multi-channel (2026-04-30): which OA owns this group.
                # NULL means "default channel" (the one seeded from env).
                # Webhook handler sets it to the channel whose URL the
                # join event came in on.
                await conn.execute(
                    """
                    ALTER TABLE line_groups
                    ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES line_channels(id)
                    """
                )
                # `line_group_folders` (2026-07-07): user-defined folders
                # for categorising groups WITHIN one OA (channel). A group
                # belongs to at most one folder; NULL folder_id = 未分類.
                # Deleting a folder un-categorises its groups (SET NULL),
                # never deletes groups.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS line_group_folders (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        channel_id UUID NOT NULL REFERENCES line_channels(id) ON DELETE CASCADE,
                        name TEXT NOT NULL,
                        sort_order INT NOT NULL DEFAULT 0,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_line_group_folders_channel
                    ON line_group_folders (channel_id)
                    """
                )
                await conn.execute(
                    """
                    ALTER TABLE line_groups
                    ADD COLUMN IF NOT EXISTS folder_id UUID
                        REFERENCES line_group_folders(id) ON DELETE SET NULL
                    """
                )
                # `campaign_line_push_configs`: one row per
                # (campaign_id, group_id) pair. `next_run_at` is the
                # index the scheduler tick scans; `frequency` + the
                # three discriminator columns (weekdays/month_day/
                # hour/minute) describe the recurrence rule.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS campaign_line_push_configs (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        campaign_id TEXT NOT NULL,
                        account_id TEXT NOT NULL,
                        group_id TEXT NOT NULL REFERENCES line_groups(group_id),
                        frequency TEXT NOT NULL,
                        weekdays INT[] NOT NULL DEFAULT '{}',
                        month_day INT,
                        hour INT NOT NULL,
                        minute INT NOT NULL,
                        date_range TEXT NOT NULL DEFAULT 'last_7d',
                        enabled BOOLEAN NOT NULL DEFAULT TRUE,
                        last_run_at TIMESTAMPTZ,
                        next_run_at TIMESTAMPTZ NOT NULL,
                        last_error TEXT,
                        fail_count INT NOT NULL DEFAULT 0,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        UNIQUE (campaign_id, group_id)
                    )
                    """
                )
                # Partial index — scheduler tick only cares about
                # enabled rows.
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_push_due
                    ON campaign_line_push_configs (next_run_at)
                    WHERE enabled
                    """
                )
                # Foreign-key / filter indexes — list endpoints query
                # by group_id and campaign_id, audit logs by config_id.
                # Without these, list pages do seq scans as the table
                # grows.
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_clpc_campaign ON campaign_line_push_configs (campaign_id)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_clpc_group ON campaign_line_push_configs (group_id)"
                )
                # Migration (2026-04-27): allow multiple configs per
                # (campaign, group) — different frequencies should
                # coexist (daily report + weekly report to same group).
                # The legacy UNIQUE (campaign_id, group_id) made the
                # 2nd insert ON-CONFLICT-overwrite the 1st. Replace
                # with the correct invariant: at most one row per
                # (campaign, group, frequency).
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    DROP CONSTRAINT IF EXISTS campaign_line_push_configs_campaign_id_group_id_key
                    """
                )
                await conn.execute(
                    """
                    DO $$
                    BEGIN
                      IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint
                        WHERE conname = 'campaign_line_push_configs_campaign_group_freq_key'
                      ) THEN
                        ALTER TABLE campaign_line_push_configs
                        ADD CONSTRAINT campaign_line_push_configs_campaign_group_freq_key
                        UNIQUE (campaign_id, group_id, frequency);
                      END IF;
                    END$$;
                    """
                )
                # Migration (2026-04-27): user-selectable report KPI
                # fields. Empty array → use the built-in defaults.
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    ADD COLUMN IF NOT EXISTS report_fields TEXT[] NOT NULL DEFAULT '{}'
                    """
                )
                # Migration (2026-04-29): include_report_button toggles
                # the LINE flex card's "查看完整報告" footer button.
                # Default FALSE so existing rows surface the new option
                # as opt-in rather than retroactively losing the button.
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    ADD COLUMN IF NOT EXISTS include_report_button BOOLEAN NOT NULL DEFAULT FALSE
                    """
                )
                # Migration (2026-07-09): which report version the 查看完整
                # 報告 button links to — 'standard' (以廣告組合報告) or
                # 'perf' (以廣告報告 / 素材成效). Only meaningful when
                # include_report_button is TRUE.
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    ADD COLUMN IF NOT EXISTS report_variant TEXT NOT NULL DEFAULT 'standard'
                    """
                )
                # Migration (2026-04-29): include_recommendations toggles
                # the 「優化建議」 section in the LINE flex body. Default
                # FALSE — many recipients are external (業主) and don't
                # want auto-generated advice; opt-in keeps existing rows
                # quiet until the operator deliberately enables it.
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    ADD COLUMN IF NOT EXISTS include_recommendations BOOLEAN NOT NULL DEFAULT FALSE
                    """
                )
                # Migration (2026-04-30): cache the FB campaign name on
                # the push config row at save time. Without this, the
                # group-management UI fell back to displaying the bare
                # campaign_id (a long opaque number) when no nickname
                # was set. The frontend has the name in hand at
                # save-time (from the searchable combobox), so just
                # persist it for display use.
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    ADD COLUMN IF NOT EXISTS campaign_name TEXT NOT NULL DEFAULT ''
                    """
                )
                # Migration (2026-04-30): custom date range support.
                # When date_range = 'custom', date_from / date_to are
                # the user-picked ISO calendar dates (inclusive on
                # both ends). For preset ranges these stay NULL.
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    ADD COLUMN IF NOT EXISTS date_from DATE,
                    ADD COLUMN IF NOT EXISTS date_to DATE
                    """
                )
                # Migration (2026-05-27): per-adset scoping. When this
                # array is non-empty, the LINE flex push reports each
                # selected adset as its own bubble in a carousel (title
                # = adset name, KPI = that adset's insights). Empty
                # array preserves the original behaviour (one bubble,
                # campaign-level numbers).
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    ADD COLUMN IF NOT EXISTS adset_ids TEXT[] NOT NULL DEFAULT '{}'
                    """
                )
                # Migration (2026-06-11): per-AD scoping (以廣告播報).
                # When this array is non-empty, the LINE flex push
                # reports each selected ad (3rd level) as its own
                # carousel bubble (title = ad name, KPI = that ad's
                # insights). Mutually exclusive with adset_ids — the
                # POST endpoint rejects configs that set both. Empty
                # array preserves the original behaviour.
                # (campaign_ids from the reverted 以行銷活動播報
                # attempt may still exist in production DBs; it is
                # ignored by the code.)
                await conn.execute(
                    """
                    ALTER TABLE campaign_line_push_configs
                    ADD COLUMN IF NOT EXISTS ad_ids TEXT[] NOT NULL DEFAULT '{}'
                    """
                )
                # `line_push_logs`: audit trail per push attempt, keeps
                # the last N entries per config for the "最近推播" UI.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS line_push_logs (
                        id BIGSERIAL PRIMARY KEY,
                        config_id UUID REFERENCES campaign_line_push_configs(id) ON DELETE CASCADE,
                        run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        success BOOLEAN NOT NULL,
                        error TEXT,
                        message_preview TEXT
                    )
                    """
                )
                # `/api/line-push/logs?config_id=…` list query filters
                # by config_id and orders by run_at DESC.
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_lpl_config_run ON line_push_logs (config_id, run_at DESC)"
                )
                # ── 安全監控推播 (event-driven, not schedule-driven) ─
                # One row per "alert subscription". When the scheduler
                # tick wakes up (every poll_interval_minutes), it
                # fetches campaigns created since last_run_at across
                # the configured account_ids, evaluates each against
                # the anomaly_filters list, and pushes any matches to
                # every group_id in group_ids.
                #
                # Sized for a small team (~5 configs per channel),
                # poll interval 5-60 min. Empty account_ids means
                # "all enabled accounts visible to owner_fb_user_id".
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS security_push_configs (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        name TEXT NOT NULL,
                        owner_fb_user_id TEXT NOT NULL,
                        channel_id UUID NOT NULL REFERENCES line_channels(id) ON DELETE CASCADE,
                        group_ids TEXT[] NOT NULL DEFAULT '{}',
                        account_ids TEXT[] NOT NULL DEFAULT '{}',
                        anomaly_filters TEXT[] NOT NULL DEFAULT ARRAY['deep_night','weekend','high_budget'],
                        poll_interval_minutes INT NOT NULL DEFAULT 10,
                        enabled BOOLEAN NOT NULL DEFAULT TRUE,
                        last_run_at TIMESTAMPTZ,
                        next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        last_error TEXT,
                        fail_count INT NOT NULL DEFAULT 0,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_sec_push_due
                    ON security_push_configs (next_run_at) WHERE enabled
                    """
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_sec_push_owner
                    ON security_push_configs (owner_fb_user_id)
                    """
                )
                # Cost-center snapshots — one row per past month for the
                # lurefin export. Past months are immutable, so once a
                # completed month is captured we serve it from here and
                # never hit FB again. The current month is always fetched
                # live (never read from / written to this table).
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS cost_center_snapshots (
                        month TEXT PRIMARY KEY,
                        payload JSONB NOT NULL,
                        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # Per-account complete-past-month overview snapshots. The
                # /api/overview endpoint serves a complete past calendar
                # month from here instead of FB (past months are immutable),
                # so 歷史花費 / 月報表型頁面 open instantly and don't burn
                # FB rate limit. Keyed by the include_* flags because
                # different views request different payload shapes.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS account_month_snapshots (
                        account_id TEXT NOT NULL,
                        month TEXT NOT NULL,
                        include_archived BOOLEAN NOT NULL DEFAULT FALSE,
                        include_adsets BOOLEAN NOT NULL DEFAULT FALSE,
                        payload JSONB NOT NULL,
                        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (account_id, month, include_archived, include_adsets)
                    )
                    """
                )
                # Backfill: old INSERT bug let the frontend send any
                # poll_interval_minutes value into DB (the hardcoded
                # 60-min override only applied on UPDATE, not INSERT).
                # Force every existing row back to 60 so a residual
                # 5 or 10 doesn't keep scanning FB at 12× the intended
                # rate after the bug fix lands.
                backfilled = await conn.execute(
                    """
                    UPDATE security_push_configs
                    SET poll_interval_minutes = 60,
                        updated_at = NOW()
                    WHERE poll_interval_minutes <> 60
                    """
                )
                # asyncpg returns "UPDATE N" — emit only if N > 0 so
                # subsequent restarts don't spam an info line.
                if backfilled and not backfilled.endswith(" 0"):
                    print(
                        f"[startup] security_push_configs poll_interval backfill: {backfilled}",
                        flush=True,
                    )
                # Align existing future schedules to the next whole
                # hour so deployed configs stop drifting immediately
                # instead of waiting one more off-minute run.
                aligned = await conn.execute(
                    """
                    UPDATE security_push_configs
                    SET next_run_at = date_trunc('hour', NOW()) + INTERVAL '1 hour',
                        updated_at = NOW()
                    WHERE enabled
                      AND next_run_at > NOW()
                      AND (
                        EXTRACT(MINUTE FROM next_run_at) <> 0
                        OR EXTRACT(SECOND FROM next_run_at) <> 0
                      )
                    """
                )
                if aligned and not aligned.endswith(" 0"):
                    print(
                        f"[startup] security_push_configs hourly alignment: {aligned}",
                        flush=True,
                    )
                # `security_push_logs`: one row per scheduler-tick attempt
                # against a security_push_configs row. Lets the UI surface
                # a per-config history (「過去 24 hrs 跑了幾次、各偵測到幾
                # 個異常」). The config-level last_run_at / fail_count
                # only tells you the LATEST state — this table is for
                # debugging trends (e.g. "is this config silently failing
                # half the time?").
                #
                # Volume: ~24 rows/config/day at default poll=60min. Cheap
                # to keep for months; if it ever grows, prune on
                # created_at < NOW() - INTERVAL '90 days'.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS security_push_logs (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        config_id UUID NOT NULL REFERENCES security_push_configs(id) ON DELETE CASCADE,
                        run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        matches_count INT NOT NULL DEFAULT 0,
                        pushed_groups INT NOT NULL DEFAULT 0,
                        duration_ms INT NOT NULL DEFAULT 0,
                        error TEXT
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_sec_push_logs_config_run
                    ON security_push_logs (config_id, run_at DESC)
                    """
                )
                # `security_scan_records`: full snapshot of WHAT was found
                # in each scan (specific campaigns + anomalies + budget /
                # spend), not just the count. Lets the team go back later
                # and ask「上週吸引力 LURE 被偵測為深夜創建的活動有哪些」.
                #
                # Two trigger types:
                #   - 'auto'   : scheduler tick (config_id set)
                #   - 'manual' : user 按「立即掃描」(fb_user_id set,
                #                config_id null)
                #
                # `matches` JSONB stores the full per-campaign payload so
                # we don't need to re-fetch FB to reconstruct the timeline.
                # Each match: {campaign_id, name, account_id, account_name,
                # anomalies[], created_time, daily_budget, spend, creator}.
                #
                # Volume estimate:
                #   - 1 user × 1 config × 24 auto/day × 30d = 720 rows / month
                #   - + manual scans
                # Rows are small (~1-5KB JSONB depending on match count).
                # Recommend pruning rows older than 90 days if storage
                # ever becomes a concern.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS security_scan_records (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        config_id UUID REFERENCES security_push_configs(id) ON DELETE SET NULL,
                        fb_user_id TEXT,
                        trigger_type TEXT NOT NULL,
                        scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        account_ids TEXT[] NOT NULL DEFAULT '{}',
                        matches JSONB NOT NULL DEFAULT '[]'::jsonb,
                        matches_count INT NOT NULL DEFAULT 0,
                        duration_ms INT NOT NULL DEFAULT 0
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_sec_scan_records_user_time
                    ON security_scan_records (fb_user_id, scanned_at DESC)
                    """
                )
                await conn.execute(
                    """
                    CREATE INDEX IF NOT EXISTS idx_sec_scan_records_config_time
                    ON security_scan_records (config_id, scanned_at DESC)
                    """
                )
                # `auth_verify_cache`: PG mirror of the in-memory
                # `_AUTH_VERIFY_CACHE` so a Zeabur redeploy doesn't
                # flush every tab's verified token, forcing them all
                # to re-hit FB `/me` simultaneously (which triggers
                # code 4 "Application request limit reached").
                #
                # Key is SHA-256 prefix of the FB access token — token
                # itself is never stored.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS auth_verify_cache (
                        token_hash TEXT PRIMARY KEY,
                        uid TEXT NOT NULL,
                        name TEXT,
                        picture_url TEXT,
                        verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # ── Per-user FB tokens (Phase A — multi-tenant) ───
                # Each FB user's long-lived token is persisted here so a
                # server restart doesn't blow away every user's session.
                # Replaces the legacy `_fb_runtime_token` row in
                # shared_settings, which only tracked the LAST user to
                # log in. With multi-tenant FB data isolation, each
                # logged-in user's FB calls go through THEIR OWN token
                # (set via the contextvar middleware) so user A no
                # longer sees user B's BMs / ad accounts.
                #
                # Schema is deliberately minimal — just (uid, token,
                # timestamps). expires_at is reserved for future
                # auto-refresh logic; FB long-lived tokens last ~60d
                # and the frontend re-runs the FB Login flow before
                # expiry, persisting a fresh token here each time.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS user_fb_tokens (
                        fb_user_id TEXT PRIMARY KEY,
                        access_token TEXT NOT NULL,
                        expires_at TIMESTAMPTZ,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # `fb_user_profiles`: a directory of everyone who has ever
                # logged in (name + avatar captured at login). Persists
                # across logout (unlike user_fb_tokens, which is deleted),
                # so the 管理員 → 用戶列表 can list all users.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS fb_user_profiles (
                        fb_user_id TEXT PRIMARY KEY,
                        name TEXT,
                        picture_url TEXT,
                        nickname TEXT,
                        first_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        last_login_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "ALTER TABLE fb_user_profiles ADD COLUMN IF NOT EXISTS nickname TEXT"
                )
                # page_perms: JSON array of allowed sidebar route keys, or
                # NULL = all pages allowed (default). Admins bypass it.
                await conn.execute(
                    "ALTER TABLE fb_user_profiles ADD COLUMN IF NOT EXISTS page_perms JSONB"
                )
                # `fb_throttle_events`: durable log of every FB rate-limit
                # / throttle hit (per-account 80000-80014 + global
                # 4/17/32/613). The in-memory ring buffers are lost on
                # restart and only keep the last 20/5-min window; this
                # table keeps the FULL history so 工程模式「FB 限流戰情室」
                # can answer「上週是誰、哪個頁面把我們打爆的」. Rows record
                # who (fb_user_id) + what (source) + which account/path +
                # the BUCU% at the moment of the hit.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS fb_throttle_events (
                        id BIGSERIAL PRIMARY KEY,
                        ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        scope TEXT NOT NULL,
                        account_id TEXT,
                        path TEXT,
                        error_code INTEGER,
                        source TEXT,
                        fb_user_id TEXT,
                        bucu_pct INTEGER
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_fb_throttle_events_ts "
                    "ON fb_throttle_events (ts DESC)"
                )
                # ── Billing / Subscription (Polar.sh) ─────────────
                # `subscriptions`: one row per fb_user_id. Tracks Polar
                # state + denormalized quota limits so per-request
                # auth checks don't have to JOIN a separate plans
                # table. `tier`/`status` are the source of truth;
                # the *_limit columns are reapplied whenever a webhook
                # mutates the row.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS subscriptions (
                        fb_user_id TEXT PRIMARY KEY,
                        polar_customer_id TEXT UNIQUE,
                        polar_subscription_id TEXT UNIQUE,
                        tier TEXT NOT NULL DEFAULT 'free',
                        status TEXT NOT NULL DEFAULT 'free',
                        trial_ends_at TIMESTAMPTZ,
                        current_period_end TIMESTAMPTZ,
                        cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
                        ad_accounts_limit INT NOT NULL DEFAULT 1,
                        line_channels_limit INT NOT NULL DEFAULT 0,
                        line_groups_limit INT NOT NULL DEFAULT 0,
                        monthly_push_limit INT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_subscriptions_polar_customer ON subscriptions (polar_customer_id)"
                )
                await conn.execute(
                    "ALTER TABLE subscriptions DROP COLUMN IF EXISTS grandfathered"
                )
                await conn.execute(
                    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS over_limit_since TIMESTAMPTZ"
                )
                await conn.execute(
                    "ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS agent_advice_limit INT"
                )
                # Per-user log of "Generate" button clicks on the
                # 成效優化中心 page. Each row = ONE quota use and one
                # persisted action-plan payload.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS agent_advice_runs (
                        id BIGSERIAL PRIMARY KEY,
                        fb_user_id TEXT NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_agent_advice_runs_user_month ON agent_advice_runs (fb_user_id, created_at)"
                )
                # The payload column was added later — older rows
                # have it NULL (they're only useful as quota markers).
                # Frontend's "restore last run" path filters those out.
                await conn.execute(
                    "ALTER TABLE agent_advice_runs ADD COLUMN IF NOT EXISTS payload JSONB"
                )
                # `billing_events`: webhook idempotency log + audit
                # trail. Polar can re-deliver events; the unique
                # constraint on polar_event_id makes ingest a no-op
                # for duplicates.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS billing_events (
                        id BIGSERIAL PRIMARY KEY,
                        polar_event_id TEXT UNIQUE NOT NULL,
                        event_type TEXT NOT NULL,
                        fb_user_id TEXT,
                        payload JSONB NOT NULL,
                        processed_at TIMESTAMPTZ,
                        error TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_billing_events_user ON billing_events (fb_user_id, created_at DESC)"
                )
                # `report_snapshots`: frozen 行銷活動報告 for the public
                # /r/ share link. Generating a snapshot fetches ALL the
                # report's FB data ONCE (campaign + adsets + per-adset ads
                # + per-adset breakdowns) and stores it as one JSONB
                # payload, so every share-link open serves the frozen copy
                # instead of hammering FB. Each generation is a NEW
                # immutable row (its own id + created_at) — old links keep
                # their data. `payload` holds the full render tree with
                # thumbnail URLs rewritten to /api/report-snapshots/{id}/
                # asset/{hash} (see report_snapshot_assets).
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS report_snapshots (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        campaign_id TEXT NOT NULL,
                        account_id TEXT,
                        variant TEXT NOT NULL DEFAULT 'standard',
                        label TEXT,
                        date_label TEXT,
                        created_by TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        payload JSONB NOT NULL DEFAULT '{}'::jsonb
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_report_snapshots_campaign ON report_snapshots (campaign_id, created_at DESC)"
                )
                # `report_snapshot_assets`: the creative thumbnails for a
                # snapshot, stored as bytes on OUR server so the frozen
                # report's images never break when the FB signed CDN URL
                # expires (days). Keyed by a hash of the original URL so a
                # creative reused across adsets is stored once. Cascade-
                # deleted with the parent snapshot.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS report_snapshot_assets (
                        snapshot_id UUID NOT NULL REFERENCES report_snapshots(id) ON DELETE CASCADE,
                        hash TEXT NOT NULL,
                        content_type TEXT NOT NULL DEFAULT 'image/jpeg',
                        bytes BYTEA NOT NULL,
                        PRIMARY KEY (snapshot_id, hash)
                    )
                    """
                )
                # `invoice_buyers`: per-store 電子發票 buyer identity. Keyed
                # by the free-text store label (matches campaign_nicknames.
                # store) so the 開立發票 form can prefill from 店家花費. No FK
                # — campaign_nicknames is keyed by campaign_id and store is
                # not unique there. category B2B carries 統編; B2C carries a
                # 載具 (carrier) or 捐贈碼 (love_code).
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS invoice_buyers (
                        store        TEXT PRIMARY KEY,
                        category     TEXT NOT NULL DEFAULT 'B2C',
                        buyer_name   TEXT NOT NULL DEFAULT '',
                        tax_id       TEXT NOT NULL DEFAULT '',
                        email        TEXT NOT NULL DEFAULT '',
                        carrier_type TEXT NOT NULL DEFAULT '',
                        carrier_num  TEXT NOT NULL DEFAULT '',
                        love_code    TEXT NOT NULL DEFAULT '',
                        print_flag   TEXT NOT NULL DEFAULT 'N',
                        address      TEXT NOT NULL DEFAULT '',
                        notes        TEXT NOT NULL DEFAULT '',
                        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # `einvoices`: issued 電子發票 ledger. Buyer fields are a
                # snapshot frozen at issue time (the profile may change
                # later). merchant_order_no is our idempotency key (ezPay
                # rejects reused order numbers permanently). raw_request /
                # raw_response hold the decrypted ezPay payloads (PII — read
                # routes are admin-gated). Populated from Phase 2 onward;
                # created here so the schema is stable.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS einvoices (
                        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        store             TEXT NOT NULL DEFAULT '',
                        category          TEXT NOT NULL,
                        buyer_name        TEXT NOT NULL DEFAULT '',
                        buyer_tax_id      TEXT NOT NULL DEFAULT '',
                        buyer_email       TEXT NOT NULL DEFAULT '',
                        carrier_type      TEXT NOT NULL DEFAULT '',
                        carrier_num       TEXT NOT NULL DEFAULT '',
                        love_code         TEXT NOT NULL DEFAULT '',
                        print_flag        TEXT NOT NULL DEFAULT 'N',
                        tax_type          TEXT NOT NULL DEFAULT '1',
                        tax_rate          NUMERIC NOT NULL DEFAULT 5,
                        amt               INT NOT NULL,
                        tax_amt           INT NOT NULL,
                        total_amt         INT NOT NULL,
                        items             JSONB NOT NULL DEFAULT '[]'::jsonb,
                        merchant_order_no TEXT NOT NULL UNIQUE,
                        invoice_number    TEXT,
                        random_number     TEXT,
                        invoice_trans_no  TEXT,
                        check_code        TEXT,
                        status            TEXT NOT NULL DEFAULT 'issued',
                        void_reason       TEXT,
                        void_at           TIMESTAMPTZ,
                        allowance_no      TEXT,
                        allowance_amt     INT,
                        allowance_at      TIMESTAMPTZ,
                        raw_request       JSONB NOT NULL DEFAULT '{}'::jsonb,
                        raw_response      JSONB NOT NULL DEFAULT '{}'::jsonb,
                        created_by        TEXT,
                        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        account_id        TEXT,
                        campaign_id       TEXT,
                        period            TEXT,
                        spend             INT,
                        markup_percent    NUMERIC
                    )
                    """
                )
                # Additive columns for DBs created before the 開立發票
                # flow (Phase 1 shipped einvoices without these). Records
                # which campaign / month / spend the invoice was issued
                # against — feeds the cost-center invoice-number hook.
                for _col, _type in (
                    ("account_id", "TEXT"),
                    ("campaign_id", "TEXT"),
                    ("period", "TEXT"),
                    ("spend", "INT"),
                    ("markup_percent", "NUMERIC"),
                ):
                    await conn.execute(
                        f"ALTER TABLE einvoices ADD COLUMN IF NOT EXISTS {_col} {_type}"
                    )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_einvoices_store ON einvoices (store, created_at DESC)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_einvoices_status ON einvoices (status, created_at DESC)"
                )
                # `einvoice_campaign_drafts`: per-campaign remembered
                # invoice inputs (category / item / buyer 統編-抬頭-email)
                # so the 開立發票 modal prefills each 行銷活動 with what was
                # entered last time. Keyed by campaign_id, team-wide.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS einvoice_campaign_drafts (
                        campaign_id TEXT PRIMARY KEY,
                        category    TEXT NOT NULL DEFAULT 'B2C',
                        item_name   TEXT NOT NULL DEFAULT '廣告行銷',
                        buyer_name  TEXT NOT NULL DEFAULT '',
                        tax_id      TEXT NOT NULL DEFAULT '',
                        email       TEXT NOT NULL DEFAULT '',
                        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # Per-ad-account ezPay 商店金鑰. Each 廣告帳號 can bill under
                # its own ezPay merchant (different selling entities), so
                # credentials live here keyed by account_id (act_ prefix)
                # instead of the single global env vars. `is_test` selects
                # the cinv (test) vs inv (prod) host. Falls back to the env
                # globals when an account has no row. Admin-gated CRUD; the
                # secret hash_key/hash_iv are NEVER returned to the client.
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS einvoice_merchants (
                        account_id  TEXT PRIMARY KEY,
                        merchant_id TEXT NOT NULL,
                        hash_key    TEXT NOT NULL,
                        hash_iv     TEXT NOT NULL,
                        is_test     BOOLEAN NOT NULL DEFAULT TRUE,
                        updated_by  TEXT,
                        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                # user_settings is keyed (fb_user_id, key) — the PK
                # already covers fb_user_id-leading queries, but bare
                # WHERE fb_user_id=$1 fan-outs benefit from being able
                # to land on a covering index. Postgres composite PK is
                # sufficient; explicit single-col index is redundant
                # and we skip it.

                # Diagnostic — print every table in the public schema
                # with its row count. Lets operators confirm at a
                # glance after a redeploy that the tables are present
                # AND that settings are actually landing.
                rows = await conn.fetch(
                    """
                    SELECT c.relname AS tbl,
                           COALESCE(s.n_live_tup, 0) AS approx_rows
                    FROM pg_class c
                    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
                    WHERE c.relkind = 'r'
                      AND c.relnamespace = 'public'::regnamespace
                    ORDER BY c.relname
                    """
                )
                if rows:
                    print(
                        "[startup] DB tables: "
                        + ", ".join(f"{r['tbl']}({r['approx_rows']})" for r in rows),
                        flush=True,
                    )
                else:
                    print("[startup] DB tables: (none)", flush=True)
                # Exact counts for the three tables we own — these are
                # fresh after CREATE TABLE even if pg_stat hasn't caught
                # up with a recent INSERT yet.
                for tbl in (
                    "campaign_nicknames",
                    "user_settings",
                    "shared_settings",
                    "line_groups",
                    "campaign_line_push_configs",
                    "line_push_logs",
                    "subscriptions",
                    "billing_events",
                ):
                    n = await conn.fetchval(f"SELECT COUNT(*) FROM {tbl}")
                    print(f"[startup] DB exact: {tbl} = {n} rows", flush=True)
            print("[startup] DB: OK (nicknames + settings + LINE push + subscriptions tables ready)", flush=True)
        except Exception as exc:
            # IMPORTANT: do NOT close the pool on migration failure.
            # The pool itself is healthy (asyncpg.create_pool succeeded
            # above); only the DDL block crashed — likely on a single
            # new ALTER / CREATE INDEX that conflicts with existing
            # data. Killing _db_pool here would take EVERY feature
            # offline (the「資料都不見了」symptom). Instead, capture
            # the error so /api/_status can surface it, log loudly,
            # and let the pool stay open so existing tables continue
            # to read/write. New features that depend on the failed
            # migration will 500 individually — much better than total
            # silence across the entire product.
            global _db_startup_error
            _db_startup_error = str(exc)
            print(
                f"[startup] DB: MIGRATION FAILED ({exc}) — pool kept open, "
                "endpoints relying on the failed schema change will 500 individually",
                flush=True,
            )
    else:
        print("[startup] DB: SKIPPED (DATABASE_URL not set)", flush=True)

    # Restore the persisted FB runtime token (if any) so the public
    # share page survives server restarts. The DB row is upserted by
    # /api/auth/token whenever an admin logs in. Until then, calls
    # fall back to FB_ACCESS_TOKEN from .env.
    if _db_pool is not None:
        try:
            async with _db_pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT value FROM shared_settings WHERE key = $1",
                    "_fb_runtime_token",
                )
            if row:
                v = row["value"]
                if isinstance(v, str):
                    v = _json.loads(v)
                if isinstance(v, dict) and v.get("token"):
                    global _runtime_token
                    _runtime_token = v["token"]
                    print("[startup] runtime FB token: restored from PG", flush=True)
        except Exception as exc:
            print(f"[startup] runtime token restore failed: {exc}", flush=True)

        # Restore the set of FB user ids that have logged in before.
        # New endpoints use this as the auth gate (see
        # `_assert_known_user`). Failure is non-fatal — set stays
        # empty and the next successful login repopulates it.
        try:
            async with _db_pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT value FROM shared_settings WHERE key = $1",
                    "_fb_known_users",
                )
            if row:
                v = row["value"]
                if isinstance(v, str):
                    v = _json.loads(v)
                if isinstance(v, list):
                    _KNOWN_FB_USERS.update(str(x) for x in v if x)
                    print(
                        f"[startup] known FB users: restored {len(_KNOWN_FB_USERS)} from PG",
                        flush=True,
                    )
        except Exception as exc:
            print(f"[startup] known users restore failed: {exc}", flush=True)

        # Phase A: load every persisted per-user FB token into the
        # in-memory cache so the contextvar-based lookup in get_token()
        # works immediately on first request post-restart instead of
        # falling through to the legacy _runtime_token global.
        await _load_user_tokens_cache()
        # Load the extra-admin allowlist (for the 管理員 nav group).
        await _load_admin_users()

    # Multi-user (2026-04-30): no auto-seeded default channel.
    # Each user adds their own LINE Official Accounts via the UI;
    # there is no shared/team-wide channel anymore. Existing
    # NULL-owner rows from earlier seed runs are left as-is — they
    # stay in DB so previously-bound groups don't lose their FK
    # target, but they're invisible to every user (the list endpoint
    # filters by owner_fb_user_id = current user).
    #
    # If you need to claim an existing NULL-owner channel, set
    # ADMIN_FB_USER_ID in env: lifespan startup reassigns any
    # orphans to that user as a one-shot rescue.
    if _db_pool is not None:
        admin_id = (os.getenv("ADMIN_FB_USER_ID") or "").strip()
        if admin_id:
            try:
                async with _db_pool.acquire() as conn:
                    n = await conn.fetchval(
                        """
                        UPDATE line_channels
                        SET owner_fb_user_id = $1
                        WHERE owner_fb_user_id IS NULL
                        """,
                        admin_id,
                    )
                    if n:
                        print(
                            f"[startup] LINE channels: claimed {n} orphan channel(s) "
                            f"for admin {admin_id[-4:]}",
                            flush=True,
                        )
            except Exception as exc:
                print(f"[startup] LINE channels admin claim failed: {exc}", flush=True)

    # Start the LINE push scheduler loop only when the DB is available.
    # Without DB there's nothing to schedule off, so skip silently.
    global _scheduler_task, _warm_task
    if _db_pool is not None:
        _scheduler_task = asyncio.create_task(_scheduler_loop())
        print(
            f"[startup] scheduler: running, tick={SCHEDULER_TICK_SECONDS}s,"
            f" tz={SCHEDULER_TZ_NAME}",
            flush=True,
        )
        # One-shot backfill of legacy line_groups rows whose group_name
        # is empty (joined before that column existed). Runs in the
        # background so startup isn't blocked by LINE API latency.
        bf = asyncio.create_task(_backfill_line_group_names())
        _bg_tasks.add(bf)
        bf.add_done_callback(_bg_tasks.discard)
    else:
        print("[startup] scheduler: SKIPPED (no DB)", flush=True)

    # Cache warm-refresh is intentionally opt-in. In production, "no
    # background FB API unless explicitly enabled" is safer than keeping
    # data warm at the cost of BUCU/rate-limit pressure.
    if os.getenv("CACHE_WARM_ENABLED", "0") == "1":
        _warm_task = asyncio.create_task(_cache_warm_loop())
        print(
            f"[startup] cache-warm: running, tick={_WARM_TICK_SECONDS}s,"
            f" max={_WARM_MAX_PER_TICK}/tick",
            flush=True,
        )
    else:
        _warm_task = None
        print("[startup] cache-warm: DISABLED (set CACHE_WARM_ENABLED=1 to enable)", flush=True)

    print(_ezpay_status_line(), flush=True)

    yield

    if _scheduler_task is not None:
        _scheduler_task.cancel()
        try:
            await _scheduler_task
        except asyncio.CancelledError:
            pass
        _scheduler_task = None
    if _warm_task is not None:
        _warm_task.cancel()
        try:
            await _warm_task
        except asyncio.CancelledError:
            pass
        _warm_task = None
    await _http_client.aclose()
    _http_client = None
    if _db_pool is not None:
        await _db_pool.close()
        _db_pool = None


app = FastAPI(title="FB Ads Dashboard", lifespan=lifespan)

# CORS: explicit allowlist via env (comma-separated), e.g.
#   ALLOWED_ORIGINS=https://meta.lure.agency,https://staging.lure.agency
# Wildcard is opt-in via ALLOWED_ORIGINS=* — required for legacy local dev
# but no longer the default. Unset env now means "same-origin only" so
# misconfigured production deploys fail closed instead of open.
_RAW_ORIGINS = os.getenv("ALLOWED_ORIGINS", "").strip()
if _RAW_ORIGINS == "*":
    _CORS_ORIGINS: List[str] = ["*"]
elif not _RAW_ORIGINS:
    _CORS_ORIGINS = []
    print(
        "[startup] WARNING: ALLOWED_ORIGINS unset — CORS will reject all "
        "cross-origin requests. Set ALLOWED_ORIGINS=https://your.domain "
        "(or `*` for local dev) to enable cross-origin access.",
        flush=True,
    )
else:
    _CORS_ORIGINS = [o.strip() for o in _RAW_ORIGINS.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "x-fb-user-id", "x-fb-source"],
)
print(f"[startup] CORS origins: {_CORS_ORIGINS}", flush=True)


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(raw: str) -> bytes:
    return base64.urlsafe_b64decode(raw + ("=" * (-len(raw) % 4)))


def _issue_session_token(uid: str) -> tuple[str, int]:
    if not _SESSION_SECRET:
        raise HTTPException(status_code=503, detail="SESSION_SECRET not configured")
    now = int(time.time())
    exp = now + _SESSION_TTL_SECONDS
    payload = {"sub": uid, "iat": now, "exp": exp, "v": 1}
    payload_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(_SESSION_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    return f"v1.{payload_b64}.{_b64url_encode(sig)}", exp


def _verify_session_token(token: str) -> Optional[str]:
    if not token or not _SESSION_SECRET:
        return None
    try:
        version, payload_b64, sig_b64 = token.split(".", 2)
        if version != "v1":
            return None
        expected = hmac.new(
            _SESSION_SECRET.encode("utf-8"),
            payload_b64.encode("ascii"),
            hashlib.sha256,
        ).digest()
        supplied = _b64url_decode(sig_b64)
        if not hmac.compare_digest(supplied, expected):
            return None
        payload = json.loads(_b64url_decode(payload_b64))
        if int(payload.get("exp") or 0) < int(time.time()):
            return None
        uid = str(payload.get("sub") or "").strip()
        return uid or None
    except Exception:
        return None


def _bearer_token(request: Request) -> str:
    auth = request.headers.get("authorization", "").strip()
    if not auth.lower().startswith("bearer "):
        return ""
    return auth[7:].strip()


def _is_public_api_request(request: Request) -> bool:
    path = request.url.path
    method = request.method.upper()
    if method == "OPTIONS":
        return True
    if not path.startswith("/api/"):
        return True
    if path in {"/api/_status", "/api/auth/token", "/api/auth/me", "/api/pricing/config"}:
        return True
    if path == "/api/billing/webhook":
        return True
    if path.startswith("/api/line/webhook"):
        return True
    # Machine-to-machine 費用中心匯出 (lurefin)。Bypasses the FB session
    # middleware because it does its own static Bearer-token check against
    # AD_SPEND_API_TOKEN — see get_cost_center() / post_cost_center_backfill().
    if path.startswith("/api/cost-center"):
        return True
    if path == "/api/proxy-asset" and method == "GET":
        return True
    # Frozen report snapshots for the public /r/ share link: the single
    # snapshot payload + its stored thumbnail assets are readable without
    # login (like the live share endpoints below). The bare
    # `/api/report-snapshots` list + POST/DELETE stay authed.
    if method == "GET" and re.match(r"^/api/report-snapshots/[^/]+(/asset/[^/]+)?$", path):
        return True
    # Public share reports (/r/...) load these read-only FB proxy endpoints
    # with the server's persisted runtime token and no browser login.
    if method == "GET" and (
        path.startswith("/api/campaigns/")
        or path.startswith("/api/adsets/")
        or path == "/api/breakdown"
        or path.startswith("/api/videos/")
        or path.startswith("/api/posts/")
        or path.startswith("/api/creatives/")
        or path.startswith("/api/pages/")
    ):
        return True
    return False


# Security headers — applied to every response. CSP allows our own
# origin plus FB CDN for ad creative thumbnails (signed URLs, never
# escape the value with HTML escapers — see CLAUDE.md).
@app.middleware("http")
async def _security_headers(request: Request, call_next):
    resp = await call_next(request)
    h = resp.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Referrer-Policy", "same-origin")
    h.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    # HSTS only when behind HTTPS (Zeabur terminates TLS — `x-forwarded-proto`
    # is set to "https"). Avoid sending HSTS over plain http: localhost.
    if request.headers.get("x-forwarded-proto", "").lower() == "https":
        h.setdefault(
            "Strict-Transport-Security", "max-age=63072000; includeSubDomains"
        )
    # CSP: restrict by default, allow FB CDN for ad creative thumbnails
    # and Graph API XHR. Chart.js / Vite output is self-hosted so 'self'
    # is enough for scripts.
    if "content-type" in h and h["content-type"].startswith("text/html"):
        h.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "img-src 'self' https: data: blob:; "
            "media-src 'self' https: blob:; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "script-src 'self' https://connect.facebook.net; "
            # fonts.* here (not just in font-src) so html-to-image's 下載
            # JPG capture can fetch + inline the Noto Sans TC web font;
            # otherwise CJK text falls back to a system font in the JPEG.
            "connect-src 'self' https://graph.facebook.com https://*.facebook.com "
            "https://generativelanguage.googleapis.com "
            "https://fonts.googleapis.com https://fonts.gstatic.com; "
            "frame-src 'none'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'",
        )
    return resp


# Per-request user-context middleware. Normal authenticated app calls
# carry an `Authorization: Bearer <signed-session>` header issued by
# `/api/auth/token`; the signed payload is the only trusted source for
# `_current_fb_user_id`. Legacy `fb_user_id` query/header context is
# available only when LEGACY_FB_USER_HEADER_AUTH=1.
@app.middleware("http")
async def _user_context_middleware(request: Request, call_next):
    uid = ""
    bearer = _bearer_token(request)
    if bearer:
        verified_uid = _verify_session_token(bearer)
        if not verified_uid:
            if not _is_public_api_request(request):
                return JSONResponse(status_code=401, content={"detail": "登入憑證無效或已過期,請重新登入"})
        else:
            uid = verified_uid
    elif not _is_public_api_request(request):
        return JSONResponse(status_code=401, content={"detail": "請先登入"})
    elif _LEGACY_FB_USER_HEADER_AUTH:
        uid = (
            request.query_params.get("fb_user_id")
            or request.headers.get("x-fb-user-id")
            or ""
        ).strip()
    # Frontend tags requests with X-Fb-Source so the engineering panel
    # can attribute「這個 FB call 是因為我做了什麼事」(立即掃描 vs
    # dashboard 載入 vs DataPreloader vs ...) rather than lumping all
    # user-facing requests under "其他".
    source = request.headers.get("x-fb-source", "").strip()
    source_token = _fb_call_source.set(source) if source else None
    if not uid:
        try:
            return await call_next(request)
        finally:
            if source_token is not None:
                _fb_call_source.reset(source_token)
    reset_token = _current_fb_user_id.set(uid)
    try:
        return await call_next(request)
    finally:
        _current_fb_user_id.reset(reset_token)
        if source_token is not None:
            _fb_call_source.reset(source_token)


# Gzip EVERY response >500 bytes for clients that send Accept-Encoding:
# gzip. Every FB API JSON response compresses roughly 4-5× so the
# savings on the proxy path are substantial.
# level=6 is the httpx / nginx default — best size/CPU balance.
app.add_middleware(GZipMiddleware, minimum_size=500, compresslevel=6)

# Serve built React assets (JS / CSS chunks emitted by Vite). Vite's build
# places hashed files under dist/assets/. Mounted before any catch-all so
# they resolve before the SPA fallback route.
_REACT_BUILD_PRESENT = (DIST_DIR / "index.html").exists()
_REACT_ASSETS_PRESENT = (DIST_DIR / "assets").exists()


class _ImmutableAssets(StaticFiles):
    """Vite emits hashed filenames under /assets — content for a given
    URL never changes, so the browser can cache it forever."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        resp = await super().get_response(path, scope)
        # 200 responses get the long max-age; 404s stay uncached.
        if getattr(resp, "status_code", 0) == 200:
            resp.headers.setdefault(
                "Cache-Control", "public, max-age=31536000, immutable"
            )
        return resp


if _REACT_ASSETS_PRESENT:
    app.mount("/assets", _ImmutableAssets(directory=str(DIST_DIR / "assets")), name="assets")


# ── Startup-cached HTML / PWA assets ────────────────────────────────
#
# The SPA catch-all fires on EVERY browser hard-refresh of a React
# route (/dashboard, /analytics, …). Reading index.html from disk per
# request would be a real hotpath. Same for sw.js / manifest.json /
# favicons. Everything is read exactly once at import time into
# module-level bytes — responses are served straight from memory.
# A redeploy restarts the Python process and picks up fresh bytes.
def _read_bytes(path: Path) -> Optional[bytes]:
    try:
        return path.read_bytes() if path.exists() else None
    except OSError:
        return None


_REACT_INDEX_HTML: Optional[bytes] = _read_bytes(DIST_DIR / "index.html")
_SW_JS: Optional[bytes] = _read_bytes(DIST_DIR / "sw.js")
_MANIFEST_JSON: Optional[bytes] = (
    _read_bytes(DIST_DIR / "manifest.webmanifest")
    or _read_bytes(DIST_DIR / "manifest.json")
)

# Top-level PWA assets — Vite copies these from frontend/public/ to
# the root of dist/ at build time. They must be served at `/favicon.png`
# etc. (not under `/assets/`) because frontend/index.html references
# them at the root path.
_FAVICON_PNG: Optional[bytes] = _read_bytes(DIST_DIR / "favicon.png")
_ICON_192_PNG: Optional[bytes] = _read_bytes(DIST_DIR / "icon-192.png")
_ICON_512_PNG: Optional[bytes] = _read_bytes(DIST_DIR / "icon-512.png")

# Loud startup banner so Zeabur logs show at-a-glance whether the
# React build was found. If you see "[startup] React build: MISSING"
# in the logs, the server has no index.html to serve and will
# return a minimal placeholder at "/" until you fix the build step.
print(
    f"[startup] React build: {'OK' if _REACT_BUILD_PRESENT else 'MISSING'} "
    f"(dist/index.html), assets mount: {'OK' if _REACT_ASSETS_PRESENT else 'MISSING'}",
    flush=True,
)


# ── Helpers ─────────────────────────────────────────────────────────

# In-memory response cache for FB Graph API GETs. The same user
# typically hits the same (account_id, date_preset) combination across
# multiple views (Dashboard → Analytics → Finance → Alerts), and FB API
# calls take 1-3s each. A 5-minute TTL turns repeat hits into instant
# local lookups while still feeling live for normal interactive use —
# FB's own insights aggregation only runs hourly on their side, so
# anything shorter than that buys staleness without buying freshness.
# This is the dominant lever against the 80004 ad-account throttle:
# the LINE-push share-button workflow opens a campaign report whose
# fan-out (campaign + N adsets + N×4 breakdowns + N×ads) totals
# 40-60+ FB calls; the second open within 5 min hits 0.
#
# Mutations (status toggles, budget edits) call _cache_invalidate
# scoped to the affected account, so freshness for the account being
# mutated is preserved while unrelated accounts keep their cache.
#
# Cache scope is per-token: the key includes a hash of the access token
# so different users (or token rotations) never see each other's data.
import hashlib
import json as _json
import re
import time

_CACHE_TTL_SECONDS = 300.0
# Accounts list changes very rarely (new ad accounts are onboarded
# manually); keep it cached for 10 minutes to stay well within FB's
# per-ad-account rate limits (80004). This is the single biggest
# request-reduction lever we have — every tab load used to pay one
# /api/accounts call against FB.
_ACCOUNTS_CACHE_TTL_SECONDS = 600.0
# Cache entry is (inserted_at, data, ttl). Older entries written with
# just (inserted_at, data) are migrated on read via _cache_get.
_fb_cache: dict[str, tuple[float, Any, float]] = {}
# Per-key request locks — when N concurrent requests miss the same
# cache key, the first one holds the lock and actually fans out to
# FB, while the rest await the lock and hit the now-populated cache
# on their retry. This prevents a cache stampede on /api/accounts and
# /api/overview, which every tab fires on first load.
_fb_cache_locks: dict[str, asyncio.Lock] = {}

# Latest FB rate-limit usage snapshot, parsed from the
# `X-Business-Use-Case-Usage` response header. Key = business id (the
# outer JSON key FB uses); value = dict with the highest observed
# `call_count` / `total_cputime` / `total_time` percentages plus
# `estimated_time_to_regain_access` (minutes) and the timestamp of
# the reading. Exposed via `/api/fb-usage` so the frontend can warn
# the user before they hit 100% or show how long to wait after a
# rate-limit error.
_fb_usage: dict[str, dict[str, Any]] = {}
_BUCU_USAGE_STALE_SECONDS = _env_int("BUCU_USAGE_STALE_SECONDS", 15 * 60)
_BUCU_LIVE_GATE_PCT = _env_int("FB_LIVE_BUCU_GATE_PCT", 95)


def _fresh_bucu_entries() -> list[dict[str, Any]]:
    """Return recent BUCU snapshots and drop stale rows.

    If we stop all FB calls to let BUCU decay, FB will not send new
    headers. Without aging, the last high snapshot would keep the app in
    self-throttle forever.
    """
    now = time.time()
    fresh: list[dict[str, Any]] = []
    for key, usage in list(_fb_usage.items()):
        observed = float(usage.get("observed_at") or 0)
        if observed <= 0 or now - observed > _BUCU_USAGE_STALE_SECONDS:
            _fb_usage.pop(key, None)
            continue
        fresh.append(usage)
    return fresh


def _parse_bucu_header(raw: Optional[str]) -> None:
    """Parse `X-Business-Use-Case-Usage` into `_fb_usage`.

    FB docs: https://developers.facebook.com/docs/graph-api/overview/rate-limiting#headers
    Header is a JSON object mapping business id → list of usage entries
    (one per call type: ads_management / ads_insights / ...). Each entry
    reports percent usage against FB's 100% ceiling, plus
    `estimated_time_to_regain_access` in minutes (0 when not throttled).

    Silently ignored when the header is missing or malformed — FB
    doesn't promise it on every response and we don't want a bad
    header format to break the actual data call.
    """
    if not raw:
        return
    try:
        parsed = _json.loads(raw)
    except Exception:
        return
    if not isinstance(parsed, dict):
        return
    now = time.time()
    for biz_id, entries in parsed.items():
        if not isinstance(entries, list):
            continue
        peak = {"call_count": 0, "total_cputime": 0, "total_time": 0}
        regain = 0
        call_type = ""
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for k in peak:
                try:
                    peak[k] = max(peak[k], int(entry.get(k, 0) or 0))
                except (TypeError, ValueError):
                    continue
            try:
                regain = max(regain, int(entry.get("estimated_time_to_regain_access", 0) or 0))
            except (TypeError, ValueError):
                pass
            if not call_type:
                call_type = str(entry.get("type", "") or "")
        _fb_usage[str(biz_id)] = {
            **peak,
            "estimated_time_to_regain_access": regain,
            "type": call_type,
            "observed_at": now,
        }


def _peak_regain_minutes() -> int:
    """Largest `estimated_time_to_regain_access` across all businesses
    in the last snapshot. Returned to the client alongside rate-limit
    errors so the UI can say "try again in N minutes" instead of a
    generic "rate limited" message.
    """
    entries = _fresh_bucu_entries()
    if not entries:
        return 0
    return max(
        int(u.get("estimated_time_to_regain_access", 0) or 0) for u in entries
    )


def _peak_bucu_pct() -> int:
    """Highest of (call_count, total_cputime, total_time) across all
    BUCU entries. Used in the call log so each row records the BUCU
    headroom AT THE TIME the call was made, instead of the panel only
    being able to show the current snapshot.
    """
    entries = _fresh_bucu_entries()
    if not entries:
        return 0
    peak = 0
    for u in entries:
        for k in ("call_count", "total_cputime", "total_time"):
            try:
                peak = max(peak, int(u.get(k, 0) or 0))
            except (TypeError, ValueError):
                continue
    return peak


def _bucu_snapshot_expires_in() -> int:
    entries = _fresh_bucu_entries()
    if not entries:
        return 0
    newest = max(float(u.get("observed_at") or 0) for u in entries)
    return max(0, int(_BUCU_USAGE_STALE_SECONDS - (time.time() - newest)))


# ── X-App-Usage(app / user / page 層級 rate limit)──────────────────
# Codes 4 / 17 / 32 hit buckets broader than one ad account (whole
# app, one user, one page). BUCU above only covers per-ad-account
# buckets, so relying on it alone means the first sign of app/user
# pressure is FB returning code 4/17 — which costs a 10-minute global
# cooldown. FB reports live usage for these buckets in the
# `X-App-Usage` header (% of the sliding one-hour budget); track it
# and shed load BEFORE crossing 100%.
_app_usage: dict[str, Any] = {}
_APP_USAGE_STALE_SECONDS = _env_int("FB_APP_USAGE_STALE_SECONDS", 5 * 60)
_APP_USAGE_LIVE_GATE_PCT = _env_int("FB_APP_USAGE_LIVE_GATE_PCT", 92)
_APP_USAGE_BACKGROUND_GATE_PCT = _env_int("FB_APP_USAGE_BACKGROUND_GATE_PCT", 75)


def _parse_app_usage_header(raw: Optional[str]) -> None:
    """Parse `X-App-Usage` into `_app_usage`.

    Header is a flat JSON object — {"call_count": N, "total_time": N,
    "total_cputime": N} — where each value is percent-of-budget for
    the sliding one-hour window. Missing/malformed headers are
    ignored; FB doesn't promise the header on every response.
    """
    if not raw:
        return
    try:
        parsed = _json.loads(raw)
    except Exception:
        return
    if not isinstance(parsed, dict):
        return
    snapshot: dict[str, Any] = {"observed_at": time.time()}
    for k in ("call_count", "total_time", "total_cputime"):
        try:
            snapshot[k] = int(parsed.get(k, 0) or 0)
        except (TypeError, ValueError):
            snapshot[k] = 0
    _app_usage.clear()
    _app_usage.update(snapshot)


def _peak_app_usage_pct() -> int:
    """Highest X-App-Usage metric from the last fresh snapshot, or 0.

    Stale snapshots (no FB call within _APP_USAGE_STALE_SECONDS) read
    as 0 so a self-imposed gate always re-opens for a probe call after
    the quiet period — by then the sliding-hour budget has partially
    decayed and the probe refreshes the snapshot either way.
    """
    observed = float(_app_usage.get("observed_at") or 0)
    if observed <= 0 or (time.time() - observed) > _APP_USAGE_STALE_SECONDS:
        return 0
    return max(
        int(_app_usage.get(k, 0) or 0)
        for k in ("call_count", "total_time", "total_cputime")
    )


def _app_usage_snapshot_expires_in() -> int:
    observed = float(_app_usage.get("observed_at") or 0)
    if observed <= 0:
        return 0
    return max(0, int(_APP_USAGE_STALE_SECONDS - (time.time() - observed)))


def _live_bucu_gate_reason() -> Optional[str]:
    """Reason to block live FB calls, or None when live traffic is OK."""
    regain = _peak_regain_minutes()
    if regain > 0:
        return f"FB BUCU regain={regain}min"
    peak = _peak_bucu_pct()
    if peak >= _BUCU_LIVE_GATE_PCT:
        return f"self-throttle: BUCU peak {peak}% ≥ {_BUCU_LIVE_GATE_PCT}%"
    app_peak = _peak_app_usage_pct()
    if app_peak >= _APP_USAGE_LIVE_GATE_PCT:
        return f"self-throttle: app usage {app_peak}% ≥ {_APP_USAGE_LIVE_GATE_PCT}%"
    return None


def _live_bucu_gate_wait_seconds() -> int:
    regain = _peak_regain_minutes()
    if regain > 0:
        return max(60, regain * 60)
    if _peak_bucu_pct() >= _BUCU_LIVE_GATE_PCT:
        return max(60, _bucu_snapshot_expires_in())
    return max(60, _app_usage_snapshot_expires_in())


# Self-imposed BUCU ceiling for background tasks (warm loop + scheduler
# + security push). User-facing live calls use the stricter
# _BUCU_LIVE_GATE_PCT above: cache hits still work, but cache misses
# fail fast while BUCU is in the danger zone.
_BUCU_BACKGROUND_GATE_PCT = 80


def _background_gate_reason() -> Optional[str]:
    """Reason to skip background tasks, or None to proceed. Combines:
      1. FB-reported `estimated_time_to_regain_access` (the
         conservative gate — only fires when FB itself tells us to
         wait).
      2. Self-imposed BUCU ceiling. The peak_bucu_pct snapshot is
         already the max-across-metrics; if anything ≥80% we pause
         until natural decay brings it back down.
    """
    regain = _peak_regain_minutes()
    if regain > 0:
        return f"FB BUCU regain={regain}min"
    peak = _peak_bucu_pct()
    if peak >= _BUCU_BACKGROUND_GATE_PCT:
        return f"self-throttle: BUCU peak {peak}% ≥ {_BUCU_BACKGROUND_GATE_PCT}%"
    app_peak = _peak_app_usage_pct()
    if app_peak >= _APP_USAGE_BACKGROUND_GATE_PCT:
        return f"self-throttle: app usage {app_peak}% ≥ {_APP_USAGE_BACKGROUND_GATE_PCT}%"
    return None


def _log_fb_call(
    *,
    path: str,
    account_id: Optional[str],
    method: str,
    ms: float,
    status: int,
    cache_hit: bool,
    error_code: Optional[int] = None,
    retried: bool = False,
) -> None:
    """Append a single entry to the FB call ring buffer. Best-effort;
    a failure here must NEVER break the actual FB call path."""
    try:
        _fb_call_log.append(
            {
                "ts": time.time(),
                "path": path,
                "account_id": account_id or "",
                "method": method,
                "ms": int(ms),
                "status": status,
                "bucu_peak_pct": _peak_bucu_pct(),
                "cache_hit": cache_hit,
                "error_code": error_code,
                "retried": retried,
                "source": _fb_call_source.get(),
                "fb_user_id": _current_fb_user_id.get() or "",
            }
        )
    except Exception:
        pass


def _spawn_bg(coro) -> None:
    """Fire-and-forget an awaitable, holding a strong ref so the event
    loop doesn't gc it mid-run. Safe to call from sync code that runs
    inside the running loop (the throttle recorders do). No-op if there
    is no running loop."""
    try:
        task = asyncio.get_running_loop().create_task(coro)
    except RuntimeError:
        # No running loop — close the coroutine so we don't leak a
        # "coroutine was never awaited" warning.
        try:
            coro.close()
        except Exception:
            pass
        return
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)


async def _persist_throttle_event(
    *,
    scope: str,
    account_id: str,
    path: str,
    error_code: int,
    source: str,
    fb_user_id: str,
    bucu: int,
) -> None:
    """Durably record a rate-limit / throttle hit to `fb_throttle_events`
    so the 工程模式 panel keeps the FULL history (survives restarts and
    the 5-minute ring-buffer window). Best-effort — never raises."""
    if _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO fb_throttle_events
                     (scope, account_id, path, error_code, source, fb_user_id, bucu_pct)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)""",
                scope,
                account_id or None,
                path or None,
                int(error_code),
                source or None,
                fb_user_id or None,
                int(bucu),
            )
    except Exception:
        pass


def _record_account_throttle(account_id: Optional[str], path: str, error_code: int) -> None:
    """Bookkeeping when 80000-80014 hits: append to per-account event
    history, set the throttle-until deadline (max of 10min and BUCU
    regain), update the global `_last_ads_throttle_at`, and emit a
    structured log line so operators can correlate from stderr.
    """
    aid = account_id or _extract_account_id_from_path(path) or ""
    regain_min = _peak_regain_minutes()
    # Cooldown floor: 10 minutes. FB's BUCU header sometimes reports
    # 0 minutes IMMEDIATELY after the throttle fires (it's an estimate),
    # so we always wait at least 10 minutes before talking to that
    # account again.
    cooldown_s = max(600.0, float(regain_min) * 60.0)
    now = time.monotonic()
    uid = _current_fb_user_id.get() or ""
    source = _fb_call_source.get()
    bucu = _peak_bucu_pct()
    global _last_ads_throttle_at
    _last_ads_throttle_at = now
    if aid:
        _account_throttle_until[aid] = now + cooldown_s
        events = _account_throttle_events.get(aid)
        if events is None:
            events = deque(maxlen=20)
            _account_throttle_events[aid] = events
        events.append(
            {
                "ts": time.time(),
                "path": path,
                "code": error_code,
                "fb_user_id": uid,
                "source": source,
                "bucu": bucu,
            }
        )
    _spawn_bg(
        _persist_throttle_event(
            scope="account",
            account_id=aid,
            path=path,
            error_code=error_code,
            source=source,
            fb_user_id=uid,
            bucu=bucu,
        )
    )
    print(
        f"[fb throttle {error_code}] account={aid or '?'} path={path} "
        f"regain_min={regain_min} cooldown_s={int(cooldown_s)}",
        flush=True,
    )


def _account_throttle_remaining(account_id: Optional[str]) -> float:
    """Seconds left on the per-account cooldown, or 0 if not throttled."""
    if not account_id:
        return 0.0
    deadline = _account_throttle_until.get(account_id)
    if not deadline:
        return 0.0
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        _account_throttle_until.pop(account_id, None)
        return 0.0
    return remaining


def _fb_detail_has_code(detail: object, code: int) -> bool:
    return f"[code={code}" in str(detail)


def _campaigns_capability_blocked(account_id: str, capability: str) -> bool:
    key = (account_id, capability)
    deadline = _campaigns_unsupported_until.get(key)
    if not deadline:
        return False
    if deadline <= time.monotonic():
        _campaigns_unsupported_until.pop(key, None)
        return False
    return True


def _remember_campaigns_unsupported(account_id: str, capability: str, detail: object) -> None:
    _campaigns_unsupported_until[(account_id, capability)] = (
        time.monotonic() + _CAMPAIGNS_CAPABILITY_TTL_SECONDS
    )
    print(
        f"[campaigns meta] {account_id} skip capability={capability} "
        f"for {_CAMPAIGNS_CAPABILITY_TTL_SECONDS}s after FB code=100: {detail}",
        flush=True,
    )


def _record_global_throttle(path: str, error_code: int) -> None:
    """Install a process-wide FB API cooldown for app/user/page limits.

    Codes 4 / 17 / 32 / 613 mean the bucket is broader than one ad
    account. A 500ms retry or a fallback with fewer fields will not
    help; it only keeps the app in the penalty box longer.
    """
    regain_min = _peak_regain_minutes()
    cooldown_s = max(600.0, float(regain_min) * 60.0)
    deadline = time.monotonic() + cooldown_s
    uid = _current_fb_user_id.get() or ""
    source = _fb_call_source.get()
    bucu = _peak_bucu_pct()
    global _global_fb_throttle_until, _last_ads_throttle_at
    _global_fb_throttle_until = max(_global_fb_throttle_until, deadline)
    _last_ads_throttle_at = time.monotonic()
    _global_throttle_events.append(
        {
            "ts": time.time(),
            "path": path,
            "code": error_code,
            "fb_user_id": uid,
            "source": source,
            "bucu": bucu,
        }
    )
    _spawn_bg(
        _persist_throttle_event(
            scope="global",
            account_id="",
            path=path,
            error_code=error_code,
            source=source,
            fb_user_id=uid,
            bucu=bucu,
        )
    )
    print(
        f"[fb global throttle {error_code}] path={path} "
        f"regain_min={regain_min} cooldown_s={int(cooldown_s)}",
        flush=True,
    )


def _global_throttle_remaining() -> float:
    """Seconds left on the global FB cooldown, or 0 if not throttled."""
    global _global_fb_throttle_until
    if not _global_fb_throttle_until:
        return 0.0
    remaining = _global_fb_throttle_until - time.monotonic()
    if remaining <= 0:
        _global_fb_throttle_until = 0.0
        return 0.0
    return remaining


def _cache_key(token: str, path: str, params: dict, *, kind: str = "single") -> str:
    """Build a stable cache key from token + path + sorted params.
    The token is hashed so it never appears in memory inspection or
    log output in plaintext form. ``kind`` distinguishes single-page
    GETs ("single") from paginated calls ("paged") so they never collide.
    """
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()[:12] if token else "anon"
    # Strip access_token from params before hashing — it's already
    # represented by token_hash.
    sanitized = {k: v for k, v in params.items() if k != "access_token"}
    param_str = "&".join(f"{k}={v}" for k, v in sorted(sanitized.items()))
    return f"{token_hash}::{kind}::{path}::{param_str}"


def _cache_get(key: str) -> Any:
    entry = _fb_cache.get(key)
    if entry is None:
        return None
    inserted_at, data, ttl = entry
    if (time.monotonic() - inserted_at) > ttl:
        # Expired for normal reads, but intentionally NOT popped: the
        # entry stays addressable for _cache_get_stale() so throttle
        # gates can degrade to stale data instead of a hard 429. The
        # LRU cap in _cache_put keeps total entries bounded, and
        # _cache_invalidate still drops entries after mutations.
        return None
    return data


# How old a cache entry may be and still be served as a degraded
# fallback while FB throttle gates are active. One hour matches the
# sliding-hour window of the app/user-level limits — anything we
# fetched within the current window is better than a blank dashboard.
_STALE_FALLBACK_MAX_AGE_SECONDS = _env_int("FB_STALE_FALLBACK_MAX_AGE_SECONDS", 3600)


def _cache_get_stale(key: Optional[str]) -> Any:
    """Expired-but-recent cache entry for throttle degradation."""
    if key is None:
        return None
    entry = _fb_cache.get(key)
    if entry is None:
        return None
    inserted_at, data, _ttl = entry
    if (time.monotonic() - inserted_at) > _STALE_FALLBACK_MAX_AGE_SECONDS:
        return None
    return data


def _stale_response_for_throttle(cache_key: Optional[str], path: str, method: str) -> Any:
    """Stale cache payload to serve while a throttle gate is active.

    Returns None when nothing usable is cached (caller raises its 429
    as before). Logged as a cache hit so the engineering panel's
    cache-hit-rate reflects that the user still got data.
    """
    if method != "GET":
        return None
    stale = _cache_get_stale(cache_key)
    if stale is None:
        return None
    _log_fb_call(
        path=path,
        account_id=_extract_account_id_from_path(path),
        method=method,
        ms=0,
        status=200,
        cache_hit=True,
    )
    return stale


def _cache_put(key: str, data: Any, ttl: float = _CACHE_TTL_SECONDS) -> None:
    # Best-effort eviction: cap cache at 500 entries to avoid runaway
    # memory growth across long-running sessions.
    if len(_fb_cache) > 500:
        # Drop the oldest 100 entries to make room
        oldest = sorted(_fb_cache.items(), key=lambda kv: kv[1][0])[:100]
        for k, _ in oldest:
            _fb_cache.pop(k, None)
            _fb_cache_locks.pop(k, None)
    _fb_cache[key] = (time.monotonic(), data, ttl)


def _cache_lock(key: str) -> asyncio.Lock:
    """Return the asyncio.Lock guarding ``key``, creating it on first
    miss. Locks are kept in a parallel dict so the cache itself stays
    a plain value map. Locks are cheap (~200 bytes each) and are
    evicted alongside their entries when the LRU prunes.
    """
    lock = _fb_cache_locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _fb_cache_locks[key] = lock
    return lock


def _cache_clear() -> None:
    """Wipe the entire in-memory cache. Used as the safety-net
    invalidation when a more granular hint isn't available.
    """
    _fb_cache.clear()
    _fb_cache_locks.clear()


# Cache key format is ``token::kind::path::params`` — we only want to
# match the path segment, not the token hash or param string. Path
# segments are slash-delimited and can contain the entity id in the
# middle. This pattern extracts the path so we can do a proper
# tokenised match instead of a naive substring scan (which matches
# act_123 against act_1234 — the prefix-boundary bug).
_CACHE_KEY_PATH_RE = re.compile(r"^[^:]+::[^:]+::([^:]+)::")


def _key_path(key: str) -> str:
    m = _CACHE_KEY_PATH_RE.match(key)
    return m.group(1) if m else key


def _path_references_id(path: str, fb_id: str) -> bool:
    """Does ``path`` contain ``fb_id`` as a whole segment?

    Cache keys encode the FB Graph path like ``act_123/campaigns``.
    Splitting on '/' and checking equality avoids the classic
    ``"act_123" in "act_1234/campaigns"`` false positive.
    """
    if not fb_id:
        return False
    for segment in path.split("/"):
        if segment == fb_id:
            return True
    return False


def _cache_invalidate(*, account_id: Optional[str] = None, entity_id: Optional[str] = None) -> int:
    """Drop cache entries that could be affected by a mutation.

    Hints are merged with OR semantics:
      - ``account_id="act_X"`` clears every entry whose path
        references account X (campaigns, adsets, ads, insights).
        Normalised so ``act_123`` and ``123`` both match.
      - ``entity_id="123"`` clears every entry whose path contains
        ``123`` as a whole segment (so ``123/adsets`` matches but
        ``1234/adsets`` does NOT — fixes the prefix-boundary bug).

    Returns the number of entries dropped. Falls back to a full
    clear if neither hint is provided.
    """
    if account_id is None and entity_id is None:
        before = len(_fb_cache)
        _cache_clear()
        return before

    # Build a set of ids to check per-segment equality against, with
    # both ``act_X`` and bare-``X`` forms where applicable.
    ids: list[str] = []
    if account_id:
        ids.append(account_id)
        if account_id.startswith("act_"):
            ids.append(account_id[4:])
        else:
            ids.append(f"act_{account_id}")
    if entity_id:
        ids.append(entity_id)

    to_drop: list[str] = []
    for k in _fb_cache:
        path = _key_path(k)
        if any(_path_references_id(path, i) for i in ids):
            to_drop.append(k)
    for k in to_drop:
        _fb_cache.pop(k, None)
        _fb_cache_locks.pop(k, None)
    return len(to_drop)


# Per-method httpx timeouts.
#
# FAST — for single-entity lookups where a human is waiting (video
# source, page info, creative hires thumbnail). Fails in 10s so a
# slow response doesn't freeze the preview modal open.
#
# BULK — for the heavy fan-out endpoints (`/api/overview` hitting
# 80 accounts in parallel, `/api/accounts` enumerating adaccounts).
# FB's insights endpoint for a large account routinely takes 5-15s
# under load; pair that with ~160 concurrent requests during a
# cold page-load and the FB side starts throttling, which pushes
# the slowest tail into the 10-20s range. 20s here keeps slow
# accounts from being intermittently mislabeled as "errored".
#
# POST — mutations tolerate the old 30s budget because FB's write
# path occasionally lags.
_GET_TIMEOUT_FAST = 10.0
_GET_TIMEOUT_BULK = 20.0
_POST_TIMEOUT = 30.0

# How many times to retry a transient FB failure before surfacing
# the error to the client. 1 extra attempt doubles the latency
# ceiling in the worst case but hugely improves success rate for
# the "sometimes works, sometimes doesn't" category of errors
# (429 rate-limited, 5xx upstream blip, connection reset, timeout).
_FB_MAX_RETRIES = 1
_FB_RETRY_DELAY_S = 0.5


def _is_transient_fb_error(exc: HTTPException) -> bool:
    """Heuristic for "worth retrying once" FB failures.

    We retry on:
      - 500  upstream internal error
      - 502  bad gateway (our own "can't reach FB" wrapper code)
      - 503  service unavailable
      - 504  gateway timeout (includes the httpx TimeoutException wrap)

    We do NOT retry 429. FB rate limit is a brake signal, not a
    transient transport blip; retrying immediately only burns more
    quota and can extend the lockout.

    We do NOT retry on 400 — that's usually a real FB API rejection
    (bad field, permission denied, unknown objective) that won't
    get better on a retry and would just double the wait for the
    user. Same for 401 (token expired) and 404 (entity gone).
    """
    return exc.status_code in (500, 502, 503, 504)


def _is_rate_limit_exception(exc: HTTPException) -> bool:
    """True when a fallback/retry ladder should stop immediately."""
    if exc.status_code == 429:
        return True
    detail = str(exc.detail or "")
    return any(
        marker in detail
        for marker in (
            "[code=4",
            "[code=17",
            "[code=32",
            "[code=613",
            "[code=800",
            "retry_after_",
            "節流",
            "rate limit",
            "request limit",
        )
    )


def _friendly_push_error(err: Any, owner_name: Optional[str] = None) -> str:
    """Turn a raw push failure into an actionable Chinese message stored
    in `last_error` and shown on the LINE push config row.

    The most common real-world failure is an expired FB token — the raw
    text is「Error validating access token: The session is invalid...」,
    which nobody can act on. We translate the frequent cases and, for
    token failures, name WHO must re-log in (the LINE 官方帳號 owner —
    the push runs on that owner's FB token, not on whoever created the
    config)."""
    # LinePushError already carries a translated friendly_message.
    friendly = getattr(err, "friendly_message", None)
    if friendly:
        return str(friendly)[:500]

    raw = str(err or "")
    low = raw.lower()
    who = f"「{owner_name}」" if owner_name else "官方帳號擁有者"

    # Expired / invalidated FB access token — the screenshot case.
    if (
        "access token" in low
        or "session is invalid" in low
        or "session has been invalidated" in low
        or "oauthexception" in low
        or "code=190" in low
    ):
        return (
            f"Facebook 登入憑證已失效,請由{who}重新用 Facebook 登入本平台一次即可修復"
            "(推播設定不需重設,系統會自動用新憑證重試)。"
        )
    # FB rate limit / throttle — transient, auto-retried.
    if any(
        m in low
        for m in ("code=17", "code=4)", "code=80004", "request limit", "rate limit", "節流", "throttle")
    ):
        return "Facebook 目前呼叫量過高(限流中),系統會自動稍後重試,通常無需處理。"
    # LINE side: bot removed from the group / no usable channel.
    if "no enabled line channel" in low or "not a member" in low or "bot" in low:
        return "找不到可用的 LINE 官方帳號,或 Bot 已被移出此群組,請確認 Bot 仍在群組內。"
    # Timeout talking to FB.
    if "timeout" in low or "timed out" in low:
        return "連線 Facebook 逾時(多半是限流中),系統會自動重試。"
    # Unknown — keep the raw text so nothing is silently swallowed.
    return raw[:500]


async def _fb_request(
    method: str,
    path: str,
    params: Optional[dict] = None,
    data_payload: Optional[dict] = None,
    *,
    slow_ok: bool = False,
    cache_ttl: Optional[float] = None,
) -> dict:
    """Send a request to FB Graph API and convert ALL failure modes to HTTPException
    with a JSON body so the frontend can always parse and display the error.

    GET responses are cached in-memory for 60 seconds (per token + path +
    params) so repeat calls within the TTL window return instantly. POSTs
    are never cached (they are mutations).

    Concurrent GETs for the same cache key are coalesced: only the
    first request actually hits FB, all other waiters block on the
    per-key lock and re-read the cache once it's populated. This
    prevents N×N stampede on `/api/accounts` and `/api/overview`
    when users open multiple tabs at once.

    ``slow_ok=True`` switches to the bulk 20s timeout — used by
    heavy fan-out call sites (``_fetch_account_insights``,
    ``_fetch_campaigns_for_account``) where FB's upstream latency
    routinely exceeds 10s during cold-load bursts. Single-entity
    lookups (video source, page info, hires thumbnail) leave the
    default 10s to fail fast.
    """
    if params is None:
        params = {}
    if data_payload is None:
        data_payload = {}
    token = get_token()
    if not token:
        raise HTTPException(status_code=401, detail="Facebook access token not set. Please log in.")

    get_timeout = _GET_TIMEOUT_BULK if slow_ok else _GET_TIMEOUT_FAST

    # Cache lookup for GET only (POSTs are mutations, never cached)
    cache_key: Optional[str] = None
    if method == "GET":
        cache_key = _cache_key(token, path, params, kind="single")
        cached = _cache_get(cache_key)
        if cached is not None:
            _log_fb_call(
                path=path,
                account_id=_extract_account_id_from_path(path),
                method=method,
                ms=0,
                status=200,
                cache_hit=True,
            )
            return cached

    global_remaining = _global_throttle_remaining()
    if global_remaining > 0:
        stale = _stale_response_for_throttle(cache_key, path, method)
        if stale is not None:
            return stale
        _log_fb_call(
            path=path,
            account_id=_extract_account_id_from_path(path),
            method=method,
            ms=0,
            status=429,
            cache_hit=False,
            error_code=4,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                f"FB Graph API 全域節流冷卻中,約 {int(global_remaining)} 秒後可重試 "
                f"[code=4 retry_after_seconds={int(global_remaining)}]"
            ),
        )

    live_gate_reason = _live_bucu_gate_reason()
    if live_gate_reason:
        stale = _stale_response_for_throttle(cache_key, path, method)
        if stale is not None:
            return stale
        wait = _live_bucu_gate_wait_seconds()
        _log_fb_call(
            path=path,
            account_id=_extract_account_id_from_path(path),
            method=method,
            ms=0,
            status=429,
            cache_hit=False,
            error_code=4,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                f"FB 用量保護模式啟動({live_gate_reason}),約 {wait} 秒後可重試。"
                f"期間只允許既有快取,不再送出新的 FB Graph API 呼叫 "
                f"[code=4 self_bucu_gate=1 retry_after_seconds={wait}]"
            ),
        )

    # Per-account throttle short-circuit. When we've seen 80000-80014
    # for this account, refuse to issue ANY new call for `cooldown_s`
    # — continuing to hit FB just extends the lockout. Returns a 429
    # with the remaining seconds so the frontend can show a friendly
    # "try again in N minutes" message. This is the dominant lever
    # against rate-limit escalation: one 80004 = stop talking to that
    # account for 10+ minutes, full stop.
    acct_for_gate = _extract_account_id_from_path(path)
    remaining = _account_throttle_remaining(acct_for_gate)
    if remaining > 0:
        stale = _stale_response_for_throttle(cache_key, path, method)
        if stale is not None:
            return stale
        _log_fb_call(
            path=path,
            account_id=acct_for_gate,
            method=method,
            ms=0,
            status=429,
            cache_hit=False,
            error_code=80004,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                f"廣告帳戶 {acct_for_gate} 仍在 FB 節流冷卻中,約 {int(remaining)} 秒後可重試 "
                f"[code=80004 retry_after_seconds={int(remaining)}]"
            ),
        )

    # Serialise concurrent misses on the same key so we only pay the
    # FB round-trip once per window. The cache re-check INSIDE the
    # lock is important: the first holder puts the result into the
    # cache, later waiters enter the lock, see the cached entry, and
    # return immediately without a second FB call.
    if cache_key is not None:
        lock = _cache_lock(cache_key)
        async with lock:
            cached = _cache_get(cache_key)
            if cached is not None:
                _log_fb_call(
                    path=path,
                    account_id=acct_for_gate,
                    method=method,
                    ms=0,
                    status=200,
                    cache_hit=True,
                )
                return cached
            try:
                return await _fb_fetch_with_retry(
                    method, path, params, data_payload, token, cache_key, get_timeout,
                    cache_ttl=cache_ttl,
                )
            except HTTPException as exc:
                # The call itself tripped a rate limit (fresh 80004 or
                # code 4/17/32/613). The throttle memory is already
                # recorded; degrade THIS response to stale cache so the
                # user keeps seeing data instead of an error toast.
                if exc.status_code == 429:
                    stale = _stale_response_for_throttle(cache_key, path, method)
                    if stale is not None:
                        return stale
                raise

    return await _fb_fetch_with_retry(
        method, path, params, data_payload, token, cache_key, get_timeout,
        cache_ttl=cache_ttl,
    )


async def _fb_fetch_with_retry(
    method: str,
    path: str,
    params: dict,
    data_payload: dict,
    token: str,
    cache_key: Optional[str],
    get_timeout: float,
    *,
    cache_ttl: Optional[float] = None,
) -> dict:
    """Wrap :func:`_fb_fetch_and_cache` with a single retry on
    transient upstream errors (5xx / network timeout / connect reset).
    Rate-limit 429 is a brake signal and is never retried. Dashboard
    fan-out endpoints routinely see 1-2% of calls
    blip on the FB side; retrying after a 500ms backoff recovers
    almost all of them and turns the "sometimes works, sometimes
    doesn't" complaint into something that just works.

    The retry is BEST-EFFORT: if the second attempt also fails we
    surface the LATER error so callers see the most recent state.
    """
    last_exc: Optional[HTTPException] = None
    for attempt in range(_FB_MAX_RETRIES + 1):
        try:
            return await _fb_fetch_and_cache(
                method,
                path,
                params,
                data_payload,
                token,
                cache_key,
                get_timeout,
                retried=(attempt > 0),
                cache_ttl=cache_ttl,
            )
        except HTTPException as e:
            last_exc = e
            if attempt >= _FB_MAX_RETRIES or not _is_transient_fb_error(e):
                raise
            print(
                f"[fb] transient {e.status_code} on {path} "
                f"(attempt {attempt + 1}/{_FB_MAX_RETRIES + 1}): {e.detail}",
                flush=True,
            )
            # Exponential backoff with jitter: 0.5s × 2^attempt plus
            # up to 250ms jitter. With _FB_MAX_RETRIES=1 this means
            # ~0.5-0.75s before the single retry — same ballpark as
            # the old fixed 0.5s but spread out so a burst of concurrent
            # transient failures don't all retry on the same tick.
            delay = _FB_RETRY_DELAY_S * (2**attempt) + random.uniform(0, 0.25)
            await asyncio.sleep(delay)
    # Unreachable: the loop either returns or raises, but mypy / lint
    # likes an explicit exit.
    raise last_exc if last_exc else HTTPException(status_code=500, detail="fb retry exhausted")


async def _fb_fetch_and_cache(
    method: str,
    path: str,
    params: dict,
    data_payload: dict,
    token: str,
    cache_key: Optional[str],
    get_timeout: float = _GET_TIMEOUT_FAST,
    *,
    retried: bool = False,
    cache_ttl: Optional[float] = None,
) -> dict:
    """Inner FB call — issues the actual httpx request, handles the
    usual error pathways, and writes the result to the cache when
    ``cache_key`` is provided. ``cache_ttl`` overrides the default
    5-minute TTL for slow-moving data (e.g. page name / avatar).
    """
    url = f"{BASE_URL}/{path}"
    # Two-layer throttle: per-account first (cap 4 same-account
    # in-flight, FB's 80004 ceiling), then global (cap 40 total). Order
    # matters — we want to BLOCK on the account gate before consuming
    # a global slot, otherwise a hot account would starve the global
    # pool. Bypass per-account when path doesn't carry act_*.
    account_id = _extract_account_id_from_path(path)
    acct_sem = _account_semaphore(account_id) if account_id else None
    started = time.monotonic()
    r = None
    try:
        async with (acct_sem if acct_sem else _NULL_CTX):
            async with _fb_semaphore:
                try:
                    if method == "GET":
                        params = {"access_token": token, **params}
                        r = await _http_client.get(url, params=params, timeout=get_timeout)
                    else:
                        data_payload = {"access_token": token, **data_payload}
                        r = await _http_client.post(url, data=data_payload, timeout=_POST_TIMEOUT)
                except httpx.TimeoutException as e:
                    _log_fb_call(
                        path=path,
                        account_id=account_id,
                        method=method,
                        ms=(time.monotonic() - started) * 1000,
                        status=504,
                        cache_hit=False,
                        retried=retried,
                    )
                    raise HTTPException(status_code=504, detail=f"Facebook API timeout: {e}")
                except httpx.RequestError as e:
                    # Includes ConnectError, ProxyError, NetworkError, etc.
                    _log_fb_call(
                        path=path,
                        account_id=account_id,
                        method=method,
                        ms=(time.monotonic() - started) * 1000,
                        status=502,
                        cache_hit=False,
                        retried=retried,
                    )
                    raise HTTPException(status_code=502, detail=f"Cannot reach Facebook API: {type(e).__name__}: {e}")
        # Record rate-limit usage regardless of success/error — the header
        # is present on error responses too and is how we know when it's
        # safe to retry.
        _parse_bucu_header(r.headers.get("x-business-use-case-usage"))
        _parse_app_usage_header(r.headers.get("x-app-usage"))
        # Try to parse JSON response
        try:
            body = r.json()
        except Exception:
            # FB returned non-JSON (rare, usually HTML error page)
            snippet = (r.text or "")[:300]
            _log_fb_call(
                path=path,
                account_id=account_id,
                method=method,
                ms=(time.monotonic() - started) * 1000,
                status=502,
                cache_hit=False,
                retried=retried,
            )
            raise HTTPException(status_code=502, detail=f"Facebook API returned non-JSON (HTTP {r.status_code}): {snippet}")
        if isinstance(body, dict) and "error" in body:
            err = body["error"] if isinstance(body["error"], dict) else {}
            # FB's `message` is usually a generic「Invalid parameter」or
            # the like. The actually actionable version is in
            # `error_user_title` + `error_user_msg`, which FB localises and
            # explicitly intends for operator-facing display. Prefer those
            # when present so users see「廣告組合無法啟用,因上層行銷活動
            # 已暫停」 instead of「Invalid parameter」.
            user_title = (err.get("error_user_title") or "").strip()
            user_msg = (err.get("error_user_msg") or "").strip()
            generic_msg = err.get("message", "Facebook API error")
            if user_msg:
                msg = f"{user_title}:{user_msg}" if user_title else user_msg
            else:
                msg = generic_msg
            # Re-surface FB error code so frontend can react (e.g. token expired = 190)
            code = err.get("code")
            sub = err.get("error_subcode")
            detail = f"{msg} [code={code}{f' subcode={sub}' if sub else ''}]" if code else msg
            # Ads-account throttle (80000-80014) — flag the account so
            # the cache-warm loop and subsequent dashboard hits to THIS
            # account back off, while unrelated accounts keep working.
            if isinstance(code, int) and 80000 <= code <= 80014:
                _record_account_throttle(account_id, path, code)
                http_status = 429
            elif isinstance(code, int) and code in {4, 17, 32, 613}:
                _record_global_throttle(path, code)
                http_status = 429
            else:
                http_status = 400
            _log_fb_call(
                path=path,
                account_id=account_id,
                method=method,
                ms=(time.monotonic() - started) * 1000,
                status=http_status,
                cache_hit=False,
                error_code=code if isinstance(code, int) else None,
                retried=retried,
            )
            raise HTTPException(status_code=http_status, detail=detail)
        # Cache successful GET responses
        if cache_key is not None:
            _cache_put(cache_key, body, ttl=cache_ttl if cache_ttl is not None else _CACHE_TTL_SECONDS)
        _log_fb_call(
            path=path,
            account_id=account_id,
            method=method,
            ms=(time.monotonic() - started) * 1000,
            status=200,
            cache_hit=False,
            retried=retried,
        )
        return body
    except HTTPException:
        raise


async def fb_get(
    path: str,
    params: Optional[dict] = None,
    *,
    slow_ok: bool = False,
    cache_ttl: Optional[float] = None,
) -> dict:
    return await _fb_request("GET", path, params=params, slow_ok=slow_ok, cache_ttl=cache_ttl)


async def fb_post(
    path: str,
    payload: Optional[dict] = None,
    *,
    invalidate_account: Optional[str] = None,
    invalidate_entity: Optional[str] = None,
) -> dict:
    """POST a Graph API mutation and selectively bust the read cache.

    If ``invalidate_account`` or ``invalidate_entity`` is provided we
    drop only entries that could be stale. Otherwise we wipe the
    entire cache (safe but coarse). Status / budget toggles know
    exactly which account they affect, so they pass the account id
    and we keep cache hits for unrelated accounts.
    """
    result = await _fb_request("POST", path, data_payload=payload)
    if invalidate_account or invalidate_entity:
        _cache_invalidate(account_id=invalidate_account, entity_id=invalidate_entity)
    else:
        _cache_clear()
    return result


async def fb_get_paginated(
    path: str,
    params: Optional[dict] = None,
    *,
    ttl: float = _CACHE_TTL_SECONDS,
    max_pages: Optional[int] = None,
) -> List[dict]:
    """Paginate through a FB Graph API endpoint that returns {data:[], paging:{next}}.
    Always raises HTTPException on failure (never lets httpx errors bubble up as 500).

    Final result lists are cached in-memory for ``ttl`` seconds (default 60s,
    per token + path + initial params). Subsequent calls within the TTL window
    return without hitting Facebook at all — a major speedup for the heavy
    /api/accounts and /api/accounts/{id}/campaigns endpoints. Endpoints whose
    underlying data changes very slowly (e.g. the ad-account list) pass a
    longer TTL to stay further below FB's per-account rate limit.

    Uses the same per-key stampede lock as :func:`_fb_request` so a
    burst of concurrent cache misses only pays for one FB call.

    ``max_pages`` caps how many pages we'll walk through ``paging.next``
    before returning whatever we have. Used by very-high-volume edges
    like ``ad_account/activities`` where a single logical request can
    otherwise fan out to 10+ FB calls (one per page), each burning BUCU.
    None = unbounded (legacy behavior). The cache key intentionally does
    NOT include max_pages, so a capped fetch and an unbounded fetch
    share storage if they otherwise match — the second one fills in
    additional pages on demand."""
    if params is None:
        params = {}
    token = get_token()
    if not token:
        raise HTTPException(status_code=401, detail="Facebook access token not set. Please log in.")

    cache_key = _cache_key(token, path, params, kind="paged")
    cached = _cache_get(cache_key)
    if cached is not None:
        _log_fb_call(
            path=path,
            account_id=_extract_account_id_from_path(path),
            method="GET",
            ms=0,
            status=200,
            cache_hit=True,
        )
        return cached  # already a List[dict]

    global_remaining = _global_throttle_remaining()
    if global_remaining > 0:
        stale = _stale_response_for_throttle(cache_key, path, "GET")
        if stale is not None:
            return stale
        _log_fb_call(
            path=path,
            account_id=_extract_account_id_from_path(path),
            method="GET",
            ms=0,
            status=429,
            cache_hit=False,
            error_code=4,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                f"FB Graph API 全域節流冷卻中,約 {int(global_remaining)} 秒後可重試 "
                f"[code=4 retry_after_seconds={int(global_remaining)}]"
            ),
        )

    live_gate_reason = _live_bucu_gate_reason()
    if live_gate_reason:
        stale = _stale_response_for_throttle(cache_key, path, "GET")
        if stale is not None:
            return stale
        wait = _live_bucu_gate_wait_seconds()
        _log_fb_call(
            path=path,
            account_id=_extract_account_id_from_path(path),
            method="GET",
            ms=0,
            status=429,
            cache_hit=False,
            error_code=4,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                f"FB 用量保護模式啟動({live_gate_reason}),約 {wait} 秒後可重試。"
                f"期間只允許既有快取,不再送出新的 FB Graph API 呼叫 "
                f"[code=4 self_bucu_gate=1 retry_after_seconds={wait}]"
            ),
        )

    # Same per-account throttle gate as `_fb_request`. Catches the
    # paginated read paths (account list, campaigns, activities)
    # before they issue a doomed call against a throttled account.
    acct_for_gate = _extract_account_id_from_path(path)
    remaining = _account_throttle_remaining(acct_for_gate)
    if remaining > 0:
        stale = _stale_response_for_throttle(cache_key, path, "GET")
        if stale is not None:
            return stale
        _log_fb_call(
            path=path,
            account_id=acct_for_gate,
            method="GET",
            ms=0,
            status=429,
            cache_hit=False,
            error_code=80004,
        )
        raise HTTPException(
            status_code=429,
            detail=(
                f"廣告帳戶 {acct_for_gate} 仍在 FB 節流冷卻中,約 {int(remaining)} 秒後可重試 "
                f"[code=80004 retry_after_seconds={int(remaining)}]"
            ),
        )

    lock = _cache_lock(cache_key)
    async with lock:
        # Re-check after acquiring — a concurrent waiter may have
        # populated the cache while we were blocked.
        cached = _cache_get(cache_key)
        if cached is not None:
            _log_fb_call(
                path=path,
                account_id=acct_for_gate,
                method="GET",
                ms=0,
                status=200,
                cache_hit=True,
            )
            return cached
        try:
            return await _fb_get_paginated_fetch(
                path, params, token, cache_key, ttl, max_pages=max_pages
            )
        except HTTPException as exc:
            # Same degrade-to-stale as `_fb_request`: a fresh rate
            # limit mid-walk shouldn't blank a list the user saw
            # minutes ago.
            if exc.status_code == 429:
                stale = _stale_response_for_throttle(cache_key, path, "GET")
                if stale is not None:
                    return stale
            raise


async def _fb_get_paginated_fetch(
    path: str,
    params: dict,
    token: str,
    cache_key: str,
    ttl: float = _CACHE_TTL_SECONDS,
    max_pages: Optional[int] = None,
) -> List[dict]:
    """Walk FB paging.next until exhausted. Per-page GETs use the
    **bulk** timeout (20s) because this function backs the heavy
    `/api/accounts` and `/api/accounts/{id}/campaigns` endpoints
    where slow FB responses were intermittently tripping the
    tighter 10s budget. Each page is also retried once on
    transient (5xx / 429 / timeout / connection) failures.
    """
    items: List[dict] = []
    next_url: Optional[str] = f"{BASE_URL}/{path}"
    page_params = {"access_token": token, **params}
    account_id = _extract_account_id_from_path(path)
    acct_sem = _account_semaphore(account_id) if account_id else None
    pages_fetched = 0
    while next_url:
        if max_pages is not None and pages_fetched >= max_pages:
            print(
                f"[fb paged] {path} hit max_pages={max_pages} cap, "
                f"stopping with {len(items)} items (more pages available)",
                flush=True,
            )
            break
        pages_fetched += 1
        data: Optional[dict] = None
        last_exc: Optional[HTTPException] = None
        # Per FB best practices, ads-specific account throttles
        # (80000-80014) must NOT be retried — continuing calls
        # extends the lockout. Flag is set inline when we see one.
        no_retry = False
        retried_this_page = False
        for attempt in range(_FB_MAX_RETRIES + 1):
            started = time.monotonic()
            page_status = 200
            page_err_code: Optional[int] = None
            try:
                async with (acct_sem if acct_sem else _NULL_CTX):
                    async with _fb_semaphore:
                        r = await _http_client.get(
                            next_url, params=page_params, timeout=_GET_TIMEOUT_BULK
                        )
            except httpx.TimeoutException as e:
                last_exc = HTTPException(status_code=504, detail=f"Facebook API timeout: {e}")
                page_status = 504
            except httpx.RequestError as e:
                last_exc = HTTPException(
                    status_code=502,
                    detail=f"Cannot reach Facebook API: {type(e).__name__}: {e}",
                )
                page_status = 502
            else:
                _parse_bucu_header(r.headers.get("x-business-use-case-usage"))
                _parse_app_usage_header(r.headers.get("x-app-usage"))
                try:
                    data = r.json()
                except Exception:
                    snippet = (r.text or "")[:300]
                    last_exc = HTTPException(
                        status_code=502,
                        detail=f"Facebook API returned non-JSON (HTTP {r.status_code}): {snippet}",
                    )
                    data = None
                    page_status = 502
                if data is not None and isinstance(data, dict) and "error" in data:
                    err = data["error"] if isinstance(data["error"], dict) else {}
                    # Prefer the actionable error_user_title /
                    # error_user_msg FB provides, falling back to the
                    # generic `message` only when those are absent.
                    user_title = (err.get("error_user_title") or "").strip()
                    user_msg = (err.get("error_user_msg") or "").strip()
                    if user_msg:
                        msg = f"{user_title}:{user_msg}" if user_title else user_msg
                    else:
                        msg = err.get("message", "Facebook API error")
                    code = err.get("code")
                    page_err_code = code if isinstance(code, int) else None
                    # Code 4 / 17 / 32 / 613 are app/user/page-level
                    # rate-limit codes — treat as transient so we
                    # retry once. Code 80000-80014 are ads-specific
                    # ad-account throttles; per FB best practices we
                    # do NOT retry them (continuing calls extends the
                    # lockout) — surface 429 with the wait time and
                    # let the frontend show "try again in N minutes".
                    transient_fb_codes = {4, 17, 32, 613}
                    is_ads_throttle = isinstance(code, int) and 80000 <= code <= 80014
                    if code in transient_fb_codes:
                        http_status = 429
                    elif is_ads_throttle:
                        http_status = 429
                    else:
                        http_status = 400
                    detail = f"{msg} [code={code}]" if code else msg
                    if is_ads_throttle:
                        no_retry = True
                        _record_account_throttle(account_id, path, code)
                        wait_min = _peak_regain_minutes()
                        if wait_min:
                            detail = f"{detail} [retry_after_minutes={wait_min}]"
                    elif isinstance(code, int) and code in transient_fb_codes:
                        no_retry = True
                        _record_global_throttle(path, code)
                        wait_sec = int(_global_throttle_remaining())
                        detail = f"{detail} [retry_after_seconds={wait_sec}]"
                    last_exc = HTTPException(status_code=http_status, detail=detail)
                    data = None
                    page_status = http_status
            _log_fb_call(
                path=path,
                account_id=account_id,
                method="GET",
                ms=(time.monotonic() - started) * 1000,
                status=page_status,
                cache_hit=False,
                error_code=page_err_code,
                retried=retried_this_page,
            )
            if data is not None:
                last_exc = None
                break  # success, stop retrying
            # Decide whether to retry this failure
            if no_retry or last_exc is None or not _is_transient_fb_error(last_exc):
                break
            if attempt >= _FB_MAX_RETRIES:
                break
            print(
                f"[fb paged] transient {last_exc.status_code} on {path} "
                f"(attempt {attempt + 1}/{_FB_MAX_RETRIES + 1}): {last_exc.detail}",
                flush=True,
            )
            # Same exponential backoff with jitter as `_fb_fetch_with_retry`
            delay = _FB_RETRY_DELAY_S * (2**attempt) + random.uniform(0, 0.25)
            await asyncio.sleep(delay)
            retried_this_page = True
        if last_exc is not None:
            raise last_exc
        assert data is not None
        items.extend(data.get("data", []))
        next_url = data.get("paging", {}).get("next")
        page_params = {}  # next_url already contains all params
    _cache_put(cache_key, items, ttl)
    return items


def _insights_clause(fields: str, date_preset: str = "last_30d", time_range: Optional[str] = None) -> str:
    """Build FB insights sub-field with correct date parameter."""
    if time_range:
        return f"insights.time_range({time_range}){{{fields}}}"
    return f"insights.date_preset({date_preset}){{{fields}}}"


# ── Pages ───────────────────────────────────────────────────────────

def _index_bytes() -> bytes:
    """Return the pre-cached React index.html. Read into memory at
    module import time, so this never touches disk at request time.
    If the React build is missing (e.g. `pnpm build` didn't run),
    returns a minimal placeholder so the server doesn't 500.
    """
    if _REACT_INDEX_HTML is not None:
        return _REACT_INDEX_HTML
    return "<!doctype html><title>luredash | Meta AI 廣告智能平台</title><body>build missing</body>".encode()


# index.html must always be revalidated so a redeploy picks up the
# new asset hashes immediately. The hashed /assets/* files are still
# cached forever (handled by _ImmutableAssets).
_HTML_NO_CACHE = {"Cache-Control": "no-cache, must-revalidate"}
# Icons / favicon: 1 day cache is plenty (rarely change, but updates
# should reach users within a day without a hard refresh).
_ICON_CACHE = {"Cache-Control": "public, max-age=86400"}
# Service worker MUST NOT be aggressively cached — browsers re-check
# it themselves per spec, but be explicit.
_SW_HEADERS = {"Cache-Control": "no-cache, must-revalidate"}


@app.get("/", response_class=HTMLResponse)
async def root():
    return Response(
        content=_index_bytes(),
        media_type="text/html; charset=utf-8",
        headers=_HTML_NO_CACHE,
    )


@app.get("/api/_status")
async def app_status():
    """Diagnostic endpoint: confirms the server has a React build
    loaded AND whether the PostgreSQL persistence layer is actually
    connected. Hit this URL directly when "data disappeared after a
    redeploy" — it tells you immediately whether the app is running
    in (silent) no-DB mode vs DB-connected, and surfaces live row
    counts for the key persistence tables so you can tell apart
    "DB not connected" from "DB connected but empty (real data loss
    upstream)".
    """
    db: dict = {
        "configured": bool(DATABASE_URL),
        "connected": _db_pool is not None,
        "tables": {},
        # Surface a startup migration / pool failure so operators can
        # see WHY the app is in no-DB mode (or running with a partially
        # applied schema) without digging through Zeabur startup logs.
        "startup_error": _db_startup_error,
        "error": None,
    }
    if _db_pool is not None:
        try:
            async with _db_pool.acquire() as conn:
                for tbl in (
                    "user_fb_tokens",
                    "user_settings",
                    "line_channels",
                    "line_channel_grants",
                    "campaign_line_push_configs",
                    "security_push_configs",
                    "subscriptions",
                    "campaign_nicknames",
                ):
                    try:
                        db["tables"][tbl] = int(
                            await conn.fetchval(f"SELECT COUNT(*) FROM {tbl}")
                        )
                    except Exception as exc:  # table missing / perm error
                        db["tables"][tbl] = f"err: {exc}"
        except Exception as exc:
            db["error"] = str(exc)
    return {
        "react_index_present": _REACT_BUILD_PRESENT,
        "react_assets_present": _REACT_ASSETS_PRESENT,
        "dist_dir": str(DIST_DIR),
        "db": db,
    }


def _read_proc_kv(path: str, key: str) -> Optional[int]:
    """Pull a single `Key: NNN kB` value out of /proc/<x>/status or
    /proc/meminfo. Returns the integer KB value, or None on Linux-
    only file missing (macOS dev / Windows). Used by /api/engineering/
    memory so we don't drag in psutil as a runtime dep."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith(key + ":"):
                    parts = line.split()
                    if len(parts) >= 2 and parts[1].isdigit():
                        return int(parts[1])  # kB
    except (FileNotFoundError, PermissionError, OSError):
        return None
    return None


@app.get("/api/engineering/memory")
async def get_engineering_memory():
    """Process RSS + host total memory for the 工程模式 panel.

    Returns MB-rounded values plus a percent so the frontend can
    render the「81.4 MB / 1,907.9 MB · 4.3%」 strip without doing
    its own math. Zeabur runs Linux, so /proc/* is available; on
    other platforms we degrade gracefully (Nones)."""
    rss_kb = _read_proc_kv("/proc/self/status", "VmRSS")
    total_kb = _read_proc_kv("/proc/meminfo", "MemTotal")
    rss_mb = round(rss_kb / 1024, 1) if rss_kb is not None else None
    total_mb = round(total_kb / 1024, 1) if total_kb is not None else None
    percent = (
        round((rss_kb / total_kb) * 100, 1)
        if rss_kb is not None and total_kb and total_kb > 0
        else None
    )
    return {
        "rss_mb": rss_mb,
        "total_mb": total_mb,
        "percent": percent,
        "source": "proc" if rss_kb is not None else "unavailable",
    }


@app.get("/favicon.png")
async def favicon_png():
    if _FAVICON_PNG is None:
        raise HTTPException(status_code=404, detail="favicon missing")
    return Response(content=_FAVICON_PNG, media_type="image/png", headers=_ICON_CACHE)


@app.get("/icon-192.png")
async def icon_192_png():
    if _ICON_192_PNG is None:
        raise HTTPException(status_code=404, detail="icon missing")
    return Response(content=_ICON_192_PNG, media_type="image/png", headers=_ICON_CACHE)


@app.get("/icon-512.png")
async def icon_512_png():
    if _ICON_512_PNG is None:
        raise HTTPException(status_code=404, detail="icon missing")
    return Response(content=_ICON_512_PNG, media_type="image/png", headers=_ICON_CACHE)


@app.get("/sw.js")
async def service_worker():
    """Serve the Workbox service worker Vite PWA emits into dist/.
    Cached at module import so this route never touches disk.
    """
    body = _SW_JS if _SW_JS is not None else b"// no service worker"
    return Response(
        content=body, media_type="application/javascript", headers=_SW_HEADERS
    )


@app.get("/manifest.json")
async def manifest():
    """Serve the PWA manifest Vite PWA emits into dist/."""
    if _MANIFEST_JSON is not None:
        return Response(
            content=_MANIFEST_JSON,
            media_type="application/manifest+json",
            headers=_ICON_CACHE,
        )
    return JSONResponse(content={})


@app.get("/manifest.webmanifest")
async def manifest_webmanifest():
    return await manifest()


# ── Auth ─────────────────────────────────────────────────────────────

class TokenPayload(BaseModel):
    token: str


async def _persist_user_token(uid: str, token: Optional[str]) -> None:
    """Insert / update / delete the given FB user's token in the
    `user_fb_tokens` table. Best-effort — logs failures but never
    raises, since the in-memory `_user_token_cache` is the live source
    of truth for the current process. PG persistence is purely so a
    Zeabur redeploy doesn't blow away every user's session."""
    if not uid or _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            if token:
                await conn.execute(
                    """
                    INSERT INTO user_fb_tokens (fb_user_id, access_token, updated_at)
                    VALUES ($1, $2, NOW())
                    ON CONFLICT (fb_user_id) DO UPDATE
                    SET access_token = EXCLUDED.access_token, updated_at = NOW()
                    """,
                    uid,
                    token,
                )
            else:
                await conn.execute(
                    "DELETE FROM user_fb_tokens WHERE fb_user_id = $1", uid
                )
    except Exception as exc:
        print(f"[user-token] persist failed for {uid[-4:]}: {exc}", flush=True)


async def _persist_user_profile(
    uid: str, name: Optional[str], picture: Optional[str]
) -> None:
    """Upsert the user's display name / avatar into `fb_user_profiles`.
    Unlike `user_fb_tokens` (deleted on logout), this directory persists
    so the 管理員 → 用戶列表 can list everyone who has ever logged in.
    Best-effort — COALESCE keeps prior values when a field is None."""
    if not uid or _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO fb_user_profiles (fb_user_id, name, picture_url, first_login_at, last_login_at)
                VALUES ($1, $2, $3, NOW(), NOW())
                ON CONFLICT (fb_user_id) DO UPDATE
                SET name = COALESCE(EXCLUDED.name, fb_user_profiles.name),
                    picture_url = COALESCE(EXCLUDED.picture_url, fb_user_profiles.picture_url),
                    last_login_at = NOW()
                """,
                uid,
                name,
                picture,
            )
    except Exception as exc:
        print(f"[user-profile] persist failed for {uid[-4:]}: {exc}", flush=True)


async def _load_user_tokens_cache() -> None:
    """Populate `_user_token_cache` from `user_fb_tokens` on lifespan
    startup. Called after `_db_pool` is created so post-redeploy reads
    the freshest tokens before any `fb_get` fires."""
    if _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT fb_user_id, access_token FROM user_fb_tokens"
            )
        for r in rows:
            uid = str(r["fb_user_id"] or "")
            tok = r["access_token"] or ""
            if uid and tok:
                _user_token_cache[uid] = tok
        print(
            f"[startup] user_fb_tokens loaded: {len(_user_token_cache)} users",
            flush=True,
        )
    except Exception as exc:
        print(f"[startup] user_fb_tokens load failed: {exc}", flush=True)


async def _persist_runtime_token(token: Optional[str]) -> None:
    """Save / clear the runtime FB token to PG so that a server
    restart (e.g. Zeabur redeploy) doesn't break the public share
    page until an admin re-logs in.

    Stored under the `_fb_runtime_token` key — the underscore prefix
    is the convention `get_shared_settings` uses to keep internal
    rows from leaking to the frontend.
    """
    if _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            if token:
                await conn.execute(
                    """
                    INSERT INTO shared_settings (key, value, updated_at)
                    VALUES ($1, $2::jsonb, NOW())
                    ON CONFLICT (key) DO UPDATE
                    SET value = EXCLUDED.value, updated_at = NOW()
                    """,
                    "_fb_runtime_token",
                    _json.dumps({"token": token}),
                )
            else:
                await conn.execute(
                    "DELETE FROM shared_settings WHERE key = $1",
                    "_fb_runtime_token",
                )
    except Exception as exc:
        print(f"[token] persist failed: {exc}", flush=True)


async def _persist_known_user(uid: str) -> None:
    """Append `uid` to the `shared_settings._fb_known_users` JSON
    array. Idempotent. Failures are logged but never raised — the
    in-memory set still works for the rest of the process lifetime."""
    if not uid or _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM shared_settings WHERE key = $1",
                "_fb_known_users",
            )
            existing: List[str] = []
            if row:
                v = row["value"]
                if isinstance(v, str):
                    v = _json.loads(v)
                if isinstance(v, list):
                    existing = [str(x) for x in v if x]
            if uid in existing:
                return
            existing.append(uid)
            await conn.execute(
                """
                INSERT INTO shared_settings (key, value, updated_at)
                VALUES ($1, $2::jsonb, NOW())
                ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = NOW()
                """,
                "_fb_known_users",
                _json.dumps(existing),
            )
    except Exception as exc:
        print(f"[auth] persist known user failed: {exc}", flush=True)


# ── Admin allowlist ──────────────────────────────────────────────
# The 管理員 nav group + user-list endpoints are gated on this set. The
# two seed ids are ALWAYS admin (protected from lockout); extra admins
# granted via 用戶列表 are stored in shared_settings._admin_fb_users
# (underscore-prefixed → filtered out of GET /api/settings/shared).
_DEFAULT_ADMIN_FB_IDS = {"122153891258988817", "10243465392077273"}
_ADMIN_FB_USERS: "set[str]" = set()


async def _load_admin_users() -> None:
    """Load the extra-admin set from shared_settings on startup."""
    global _ADMIN_FB_USERS
    if _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM shared_settings WHERE key = $1", "_admin_fb_users"
            )
        loaded: "set[str]" = set()
        if row:
            v = row["value"]
            if isinstance(v, str):
                v = _json.loads(v)
            if isinstance(v, list):
                loaded = {str(x) for x in v if x}
        _ADMIN_FB_USERS = loaded
        print(f"[startup] admin users: {len(_ADMIN_FB_USERS)} extra", flush=True)
    except Exception as exc:
        print(f"[admin] load admin users failed: {exc}", flush=True)


async def _persist_admin_users() -> None:
    if _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO shared_settings (key, value, updated_at)
                VALUES ($1, $2::jsonb, NOW())
                ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = NOW()
                """,
                "_admin_fb_users",
                _json.dumps(sorted(_ADMIN_FB_USERS)),
            )
    except Exception as exc:
        print(f"[admin] persist admin users failed: {exc}", flush=True)


def _is_admin(uid: Optional[str]) -> bool:
    return bool(uid) and (uid in _DEFAULT_ADMIN_FB_IDS or uid in _ADMIN_FB_USERS)


def _require_admin() -> str:
    """Raise 403 unless the current session belongs to an admin."""
    uid = (_current_fb_user_id.get() or "").strip()
    if not _is_admin(uid):
        raise HTTPException(status_code=403, detail="需要管理員權限")
    return uid


def _assert_known_user(uid: str) -> None:
    """Raise unless the signed session belongs to `uid`.

    `_KNOWN_FB_USERS` remains as a cheap sanity check, but the
    authoritative identity is `_current_fb_user_id`, populated from the
    HMAC-signed session token by middleware.
    """
    session_uid = _current_fb_user_id.get()
    if not uid or uid not in _KNOWN_FB_USERS:
        raise HTTPException(status_code=401, detail="未登入或登入已過期")
    if session_uid != uid:
        raise HTTPException(status_code=403, detail="不能存取其他使用者的資料")


# Per-user rate limit for the AI 幕僚 endpoints. The Gemini quota is
# the cost ceiling, but a low rate ceiling adds defence-in-depth so a
# logged-in operator (or a leaked fb_user_id) can't spam the endpoint
# in a tight loop. In-memory dict — single-process Zeabur deploy, no
# Redis needed; a process restart simply resets everyone's window.
_AGENT_RATE_LIMIT_SECONDS = 10
_AGENT_RATE_LIMIT: "dict[str, float]" = {}


def _check_agent_rate_limit(uid: str) -> None:
    if not uid:
        return
    now = time.monotonic()
    last = _AGENT_RATE_LIMIT.get(uid)
    if last is not None and now - last < _AGENT_RATE_LIMIT_SECONDS:
        wait = int(_AGENT_RATE_LIMIT_SECONDS - (now - last)) + 1
        raise HTTPException(
            status_code=429,
            detail=f"AI 幕僚請求太頻繁,請等待 {wait} 秒後再試",
        )
    _AGENT_RATE_LIMIT[uid] = now


# Cache for /me verification results keyed by token hash. Lets repeat
# `POST /api/auth/token` (page reloads, PWA cold-starts, FB SDK auto
# re-exchange) skip the FB round-trip for 5 minutes — main culprit for
# rate-limit incidents on the auth endpoint. Token itself is NEVER
# cached as plaintext: we key by SHA-256 prefix.
#
# The in-memory dict is mirrored to `auth_verify_cache` in PG so a
# Zeabur redeploy doesn't blow away the cache and force every tab to
# re-hit FB's `/me` (which hits the user-level Graph API rate limit,
# code 4). PG entries live longer than the in-memory TTL — 24h —
# because the cost of「old name/picture from 12h ago」is much smaller
# than「FB code 4 because all my tabs reloaded after redeploy」.
_AUTH_VERIFY_CACHE: dict[str, tuple[float, dict]] = {}
_AUTH_VERIFY_TTL_SECONDS = 5 * 60
_AUTH_VERIFY_PG_TTL_SECONDS = 24 * 60 * 60
_AUTH_VERIFY_RATE_LIMIT_FLOOR_SECONDS = 10 * 60

# Per-token-hash dedup lock. When N tabs (or N users in an agency
# sharing the same FB token cache prefix) simultaneously POST
# /api/auth/token after a Zeabur redeploy or app cold-start, they ALL
# miss the in-memory + PG verify cache and ALL fire /me concurrently.
# That stacks against FB's app-level rate limit (code 4) and surfaces
# as the「FB 觸發頻率限制」toast even though every request is for the
# same token. The lock makes the first call do the FB round-trip and
# subsequent concurrent calls await + read the populated cache, so the
# total FB /me cost for a burst is 1 call regardless of fan-in.
_AUTH_VERIFY_LOCKS: dict[str, asyncio.Lock] = {}


def _auth_cache_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


async def _auth_verify_pg_lookup(token_hash: str) -> Optional[dict]:
    """Read PG-backed verify cache. Returns the cached `/me` payload
    or None on miss / stale / no DB."""
    if _db_pool is None:
        return None
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT uid, name, picture_url, verified_at
                FROM auth_verify_cache
                WHERE token_hash = $1
                """,
                token_hash,
            )
    except Exception:
        return None
    if row is None:
        return None
    verified_at = row["verified_at"]
    if verified_at is None:
        return None
    age = (datetime.now(timezone.utc) - verified_at).total_seconds()
    if age > _AUTH_VERIFY_PG_TTL_SECONDS:
        return None
    return {
        "id": row["uid"],
        "name": row["name"],
        "picture": {"data": {"url": row["picture_url"] or ""}},
    }


async def _auth_verify_pg_store(token_hash: str, me: dict) -> None:
    """Mirror a successful `/me` verify into PG. Best-effort — a
    failure here just means the next redeploy will need to re-hit FB."""
    if _db_pool is None:
        return
    try:
        uid = str(me.get("id") or "")
        name = str(me.get("name") or "")
        pic_url = ""
        try:
            pic_url = str(((me.get("picture") or {}).get("data") or {}).get("url") or "")
        except Exception:
            pass
        async with _db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO auth_verify_cache
                    (token_hash, uid, name, picture_url, verified_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (token_hash) DO UPDATE
                SET uid = EXCLUDED.uid,
                    name = EXCLUDED.name,
                    picture_url = EXCLUDED.picture_url,
                    verified_at = NOW()
                """,
                token_hash,
                uid,
                name,
                pic_url,
            )
    except Exception as exc:
        print(f"[auth] verify PG cache store failed: {exc}", flush=True)


@app.post("/api/auth/token")
async def set_token(payload: TokenPayload):
    global _runtime_token
    # IMPORTANT: bypass fb_get / get_token() here. Reason: the caller's
    # `x-fb-user-id` header may still carry a stale uid from a previous
    # session, which makes the middleware set the contextvar → get_token
    # returns the OLD cached token from `_user_token_cache[stale_uid]`
    # instead of the fresh one in `payload.token`. The /me verify would
    # then hit FB with the expired token and 190 out, even though the
    # client just minted a brand-new token via FB.login. Direct httpx
    # call with payload.token sidesteps the cache entirely.

    # Two-tier verify cache so a flood of page reloads / multi-tab
    # post-redeploy stampede doesn't burn FB's `/me` rate limit:
    #   1. In-memory `_AUTH_VERIFY_CACHE` (5min) — fastest, same-process
    #   2. PG `auth_verify_cache` (24h) — survives Zeabur redeploys,
    #      cross-process for future multi-worker setups
    # On PG hit, write back into the in-memory cache so subsequent
    # requests in this process don't even need the DB roundtrip.
    cache_key = _auth_cache_key(payload.token)

    async def _read_cached() -> Optional[dict]:
        cached = _AUTH_VERIFY_CACHE.get(cache_key)
        if cached and time.time() - cached[0] < _AUTH_VERIFY_TTL_SECONDS:
            return cached[1]
        pg_hit = await _auth_verify_pg_lookup(cache_key)
        if pg_hit is not None:
            _AUTH_VERIFY_CACHE[cache_key] = (time.time(), pg_hit)
            return pg_hit
        return None

    me_cached = await _read_cached()
    if me_cached is not None:
        uid = str(me_cached.get("id") or "")
        _runtime_token = payload.token
        if uid:
            _user_token_cache[uid] = payload.token
            _KNOWN_FB_USERS.add(uid)
        session_token, session_expires_at = _issue_session_token(uid)
        return {
            "ok": True,
            "name": me_cached.get("name"),
            "id": me_cached.get("id"),
            "pictureUrl": me_cached.get("picture", {}).get("data", {}).get("url"),
            "cached": True,
            "sessionToken": session_token,
            "sessionExpiresAt": session_expires_at,
        }

    if _http_client is None:
        raise HTTPException(status_code=503, detail="伺服器尚未初始化,請稍後再試")

    global_remaining = _global_throttle_remaining()
    if global_remaining > 0:
        wait = int(global_remaining) + 1
        raise HTTPException(
            status_code=429,
            detail=f"FB 登入驗證冷卻中,請等待 {wait} 秒後再試。期間不會再呼叫 FB /me。",
        )

    live_gate_reason = _live_bucu_gate_reason()
    if live_gate_reason:
        wait = _live_bucu_gate_wait_seconds()
        raise HTTPException(
            status_code=429,
            detail=(
                f"FB 登入驗證暫停({live_gate_reason}),請等待 {wait} 秒後再試。"
                "期間不會再呼叫 FB /me。"
            ),
        )

    # Coalesce concurrent verifies for the same token. Without this
    # lock, N tabs reloading at once each fire their own /me and pile
    # onto FB's app-level rate limit. The first call populates the
    # cache and everyone else returns from it. setdefault is atomic
    # under cooperative asyncio so two concurrent tasks can't both
    # create separate locks for the same key.
    lock = _AUTH_VERIFY_LOCKS.setdefault(cache_key, asyncio.Lock())
    async with lock:
        # Re-read cache under the lock — another concurrent verify may
        # have populated it while we were queued.
        me_cached = await _read_cached()
        if me_cached is not None:
            uid = str(me_cached.get("id") or "")
            _runtime_token = payload.token
            if uid:
                _user_token_cache[uid] = payload.token
                _KNOWN_FB_USERS.add(uid)
            session_token, session_expires_at = _issue_session_token(uid)
            return {
                "ok": True,
                "name": me_cached.get("name"),
                "id": me_cached.get("id"),
                "pictureUrl": me_cached.get("picture", {}).get("data", {}).get("url"),
                "cached": True,
                "sessionToken": session_token,
                "sessionExpiresAt": session_expires_at,
            }
        try:
            return await _verify_token_with_fb(payload.token, cache_key)
        finally:
            # Best-effort cleanup so the lock dict doesn't grow forever
            # across token rotations. Safe to drop because new arrivals
            # will just create a fresh lock (and immediately hit the
            # cache we just populated).
            _AUTH_VERIFY_LOCKS.pop(cache_key, None)


async def _verify_token_with_fb(token: str, cache_key: str) -> dict:
    """Do the actual FB /me round-trip + cache population. Split out
    so the dedup lock wrapper in `set_token` stays readable. Raises
    HTTPException on FB rejection; on success, returns the same dict
    shape `set_token` returns."""
    global _runtime_token
    assert _http_client is not None
    started = time.perf_counter()
    status_code = 0
    fb_code: Optional[int] = None
    try:
        resp = await _http_client.get(
            f"{BASE_URL}/me",
            params={"fields": "id,name,picture", "access_token": token},
            timeout=10.0,
        )
        status_code = resp.status_code
    except httpx.HTTPError as e:
        _log_fb_call(
            path="/me",
            account_id=None,
            method="GET",
            ms=(time.perf_counter() - started) * 1000,
            status=502,
            cache_hit=False,
        )
        print(f"[auth] token verify network error: {type(e).__name__}: {e}", flush=True)
        raise HTTPException(
            status_code=502,
            detail=f"無法連線到 Facebook ({type(e).__name__})",
        ) from None

    if resp.status_code != 200:
        # Surface the FB error code + short message so the user (or
        # support) can see WHY FB rejected. We do NOT log or surface
        # the access token. Trim message to 200 chars.
        try:
            err_body = resp.json()
            fb_err = err_body.get("error", {}) if isinstance(err_body, dict) else {}
            fb_code = fb_err.get("code")
            fb_subcode = fb_err.get("error_subcode")
            fb_type = fb_err.get("type")
            fb_msg = (fb_err.get("message") or "")[:200]
        except Exception:
            fb_code = fb_subcode = fb_type = None
            fb_msg = resp.text[:200]
        try:
            fb_code_int = int(fb_code) if fb_code is not None else None
        except (TypeError, ValueError):
            fb_code_int = None
        _log_fb_call(
            path="/me",
            account_id=None,
            method="GET",
            ms=(time.perf_counter() - started) * 1000,
            status=status_code,
            cache_hit=False,
            error_code=fb_code_int,
        )
        print(
            f"[auth] token verify rejected: HTTP {resp.status_code} "
            f"code={fb_code} subcode={fb_subcode} type={fb_type} msg={fb_msg}",
            flush=True,
        )
        if fb_code == 190:
            detail = "FB token 已過期或被撤銷。請再次點擊登入按鈕重新授權。"
        elif fb_code == 104 or fb_type == "GraphMethodException":
            detail = "FB App 設定問題(可能需要 App Secret 重設)。"
        elif fb_code == 4 or "rate" in fb_msg.lower():
            code = int(fb_code) if fb_code is not None else 4
            _record_global_throttle("/me", code)
            wait = max(_AUTH_VERIFY_RATE_LIMIT_FLOOR_SECONDS, int(_global_throttle_remaining()) + 1)
            detail = f"FB 觸發頻率限制,請等待 {wait} 秒後再試。系統已暫停登入驗證,不會繼續呼叫 FB /me。"
        elif fb_code:
            detail = f"FB 驗證失敗(代碼 {fb_code}):{fb_msg}"
        else:
            detail = f"FB 驗證失敗(HTTP {resp.status_code}):{fb_msg or '無回應內容'}"
        raise HTTPException(status_code=429 if fb_code == 4 or "rate" in fb_msg.lower() else 400, detail=detail)

    try:
        me = resp.json()
        _log_fb_call(
            path="/me",
            account_id=None,
            method="GET",
            ms=(time.perf_counter() - started) * 1000,
            status=status_code,
            cache_hit=False,
        )
        uid = str(me.get("id") or "")
        pic = me.get("picture", {}).get("data", {}).get("url")
        # Only persist after the token verifies — avoids storing
        # garbage that would 401 every share-page viewer.
        _runtime_token = token
        await _persist_runtime_token(token)
        if uid:
            _user_token_cache[uid] = token
            await _persist_user_token(uid, token)
            await _persist_user_profile(uid, me.get("name"), pic)
            _KNOWN_FB_USERS.add(uid)
            await _persist_known_user(uid)
        # Cache the verified /me response in both layers so subsequent
        # re-exchanges with the same token skip FB entirely. PG mirror
        # is best-effort — a DB hiccup must not surface as a login
        # failure.
        _AUTH_VERIFY_CACHE[cache_key] = (time.time(), me)
        await _auth_verify_pg_store(cache_key, me)
        session_token, session_expires_at = _issue_session_token(uid)
        return {
            "ok": True,
            "name": me.get("name"),
            "id": me.get("id"),
            "pictureUrl": pic,
            "sessionToken": session_token,
            "sessionExpiresAt": session_expires_at,
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"[auth] post-verify persist failed: {e!r}", flush=True)
        raise HTTPException(status_code=500, detail=f"伺服器儲存失敗:{type(e).__name__}") from None


@app.delete("/api/auth/token")
async def clear_token(fb_user_id: Optional[str] = None):
    """Logout: drop the calling user's per-user token AND the legacy
    global runtime token. The per-user cache eviction is gated on the
    caller's `fb_user_id` so one user's logout doesn't kick everyone
    else out — when fb_user_id is missing (legacy clients, or share
    page logout), only the global is cleared."""
    global _runtime_token
    _runtime_token = None
    await _persist_runtime_token(None)
    uid = (fb_user_id or _current_fb_user_id.get() or "").strip()
    if uid:
        _user_token_cache.pop(uid, None)
        await _persist_user_token(uid, None)
    return {"ok": True}

@app.get("/api/auth/me")
async def get_me():
    """Return the current auth identity without touching FB Graph.

    This endpoint is used by engineering health checks. Calling FB /me
    from a health ping can lock out real login during code-4 rate-limit
    incidents, so it only reads our local/PG verify cache.
    """
    token = get_token()
    if not token:
        return {"logged_in": False}
    token_hash = _auth_cache_key(token)
    cached = _AUTH_VERIFY_CACHE.get(token_hash)
    me = cached[1] if cached and time.time() - cached[0] < _AUTH_VERIFY_TTL_SECONDS else None
    if me is None:
        me = await _auth_verify_pg_lookup(token_hash)
        if me is not None:
            _AUTH_VERIFY_CACHE[token_hash] = (time.time(), me)
    if me is None:
        uid = _current_fb_user_id.get() or ""
        if uid:
            return {"logged_in": True, "id": uid, "name": "User"}
        return {"logged_in": False}
    return {"logged_in": True, **me}


# ── 管理員 / 用戶列表 ─────────────────────────────────────────────────
#
# The 管理員 nav group is shown only to admins (see _is_admin). It exposes
# a list of everyone who has ever logged in (fb_user_profiles + known
# users) with their tier + role, and lets admins grant/revoke admin.


async def _get_page_perms(uid: str) -> Optional[list]:
    """The user's allowed sidebar route keys, or None = all allowed."""
    if not uid or _db_pool is None:
        return None
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT page_perms FROM fb_user_profiles WHERE fb_user_id = $1", uid
            )
        if row and row["page_perms"] is not None:
            v = row["page_perms"]
            if isinstance(v, str):
                v = _json.loads(v)
            if isinstance(v, list):
                return [str(x) for x in v]
    except Exception:
        pass
    return None


@app.get("/api/admin/whoami")
async def admin_whoami():
    """Any logged-in user: am I an admin + which pages can I see? Drives
    the 管理員 nav group AND per-user page gating in the sidebar."""
    uid = (_current_fb_user_id.get() or "").strip()
    return {
        "is_admin": _is_admin(uid),
        "fb_user_id": uid,
        "page_perms": await _get_page_perms(uid),
    }


@app.get("/api/admin/users")
async def admin_list_users():
    """List every user who has logged in, with tier + role + nickname.
    Admin only. Names/avatars fall back to the auth-verify cache so users
    who logged in before fb_user_profiles existed still show up named."""
    _require_admin()
    if _db_pool is None:
        return {"data": []}
    async with _db_pool.acquire() as conn:
        profiles = await conn.fetch(
            "SELECT fb_user_id, name, picture_url, nickname, page_perms, first_login_at, last_login_at FROM fb_user_profiles"
        )
        subs = await conn.fetch("SELECT fb_user_id, tier, status FROM subscriptions")
        # Latest verified /me per uid — backfills name/avatar for users
        # who predate fb_user_profiles.
        verify = await conn.fetch(
            "SELECT DISTINCT ON (uid) uid, name, picture_url FROM auth_verify_cache ORDER BY uid, verified_at DESC"
        )
        known_row = await conn.fetchrow(
            "SELECT value FROM shared_settings WHERE key = $1", "_fb_known_users"
        )

    sub_map = {str(r["fb_user_id"]): (r["tier"], r["status"]) for r in subs}
    verify_map = {str(r["uid"]): (r["name"], r["picture_url"]) for r in verify}

    by_id: dict = {}
    for r in profiles:
        uid = str(r["fb_user_id"])
        pp = r["page_perms"]
        if isinstance(pp, str):
            try:
                pp = _json.loads(pp)
            except Exception:
                pp = None
        by_id[uid] = {
            "name": r["name"],
            "picture_url": r["picture_url"],
            "nickname": r["nickname"],
            "page_perms": pp if isinstance(pp, list) else None,
            "first_login_at": r["first_login_at"].isoformat() if r["first_login_at"] else None,
            "last_login_at": r["last_login_at"].isoformat() if r["last_login_at"] else None,
        }
    # Every candidate id: profiles ∪ known ∪ admins ∪ subscribers.
    all_ids: "set[str]" = set(by_id) | set(sub_map) | set(_DEFAULT_ADMIN_FB_IDS) | set(_ADMIN_FB_USERS)
    if known_row:
        v = known_row["value"]
        if isinstance(v, str):
            v = _json.loads(v)
        if isinstance(v, list):
            all_ids |= {str(x) for x in v if x}

    data = []
    for uid in all_ids:
        base = by_id.get(uid, {})
        vn, vp = verify_map.get(uid, (None, None))
        tier, status = sub_map.get(uid, ("free", "free"))
        data.append(
            {
                "fb_user_id": uid,
                "name": base.get("name") or vn,
                "picture_url": base.get("picture_url") or vp,
                "nickname": base.get("nickname"),
                "page_perms": base.get("page_perms"),
                "tier": tier or "free",
                "status": status or "free",
                "first_login_at": base.get("first_login_at"),
                "last_login_at": base.get("last_login_at"),
                "role": "admin" if _is_admin(uid) else "user",
            }
        )
    data.sort(
        # admins first, then by nickname / name, then id
        key=lambda u: (
            u["role"] != "admin",
            (u["nickname"] or u["name"] or "￿").lower(),
            u["fb_user_id"],
        ),
    )
    return {"data": data, "default_admin_ids": sorted(_DEFAULT_ADMIN_FB_IDS)}


class AdminNicknamePayload(BaseModel):
    nickname: str = ""


@app.post("/api/admin/users/{target_fb_user_id}/nickname")
async def admin_set_user_nickname(target_fb_user_id: str, payload: AdminNicknamePayload):
    """Set / clear an admin-editable nickname for a user. Admin only."""
    _require_admin()
    uid = str(target_fb_user_id).strip()
    if not uid:
        raise HTTPException(status_code=400, detail="缺少使用者 id")
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="資料庫尚未連線")
    nn = (payload.nickname or "").strip() or None
    async with _db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO fb_user_profiles (fb_user_id, nickname)
            VALUES ($1, $2)
            ON CONFLICT (fb_user_id) DO UPDATE SET nickname = EXCLUDED.nickname
            """,
            uid,
            nn,
        )
    return {"ok": True, "nickname": nn}


class AdminPagesPayload(BaseModel):
    # None = all pages allowed (clears the restriction).
    pages: Optional[List[str]] = None


@app.post("/api/admin/users/{target_fb_user_id}/pages")
async def admin_set_user_pages(target_fb_user_id: str, payload: AdminPagesPayload):
    """Set which sidebar pages a user can see (None = all). Admin only."""
    _require_admin()
    uid = str(target_fb_user_id).strip()
    if not uid:
        raise HTTPException(status_code=400, detail="缺少使用者 id")
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="資料庫尚未連線")
    val = None if payload.pages is None else [str(p) for p in payload.pages]
    async with _db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO fb_user_profiles (fb_user_id, page_perms)
            VALUES ($1, $2::jsonb)
            ON CONFLICT (fb_user_id) DO UPDATE SET page_perms = EXCLUDED.page_perms
            """,
            uid,
            _json.dumps(val) if val is not None else None,
        )
    return {"ok": True, "pages": val}


class AdminRolePayload(BaseModel):
    role: str


@app.post("/api/admin/users/{target_fb_user_id}/role")
async def admin_set_user_role(target_fb_user_id: str, payload: AdminRolePayload):
    """Grant / revoke admin for another user. Admin only; the two seed
    admins are protected from change to avoid lockout."""
    _require_admin()
    role = payload.role
    if role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="role 必須是 admin 或 user")
    uid = str(target_fb_user_id).strip()
    if not uid:
        raise HTTPException(status_code=400, detail="缺少使用者 id")
    if uid in _DEFAULT_ADMIN_FB_IDS:
        raise HTTPException(status_code=400, detail="預設管理員無法變更權限")
    if role == "admin":
        _ADMIN_FB_USERS.add(uid)
    else:
        _ADMIN_FB_USERS.discard(uid)
    await _persist_admin_users()
    return {"ok": True, "role": role}


# ── Campaign Nicknames (PostgreSQL-backed) ────────────────────────────
#
# Stored in `campaign_nicknames` (campaign_id PK). Global / shared
# across all authenticated users — the LURE team uses a single shared
# nickname list per campaign.

class NicknamePayload(BaseModel):
    store: str = ""
    designer: str = ""


def _require_db() -> asyncpg.Pool:
    if _db_pool is None:
        raise HTTPException(
            status_code=503,
            detail="Database not configured. Set DATABASE_URL and redeploy.",
        )
    return _db_pool


@app.get("/api/nicknames")
async def list_nicknames():
    if _db_pool is None:
        return {"data": []}
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT campaign_id, store, designer FROM campaign_nicknames"
        )
    return {
        "data": [
            {"campaign_id": r["campaign_id"], "store": r["store"], "designer": r["designer"]}
            for r in rows
        ]
    }


@app.post("/api/nicknames/{campaign_id}")
async def upsert_nickname(campaign_id: str, payload: NicknamePayload):
    pool = _require_db()
    store = (payload.store or "").strip()
    designer = (payload.designer or "").strip()
    async with pool.acquire() as conn:
        if not store and not designer:
            # Both empty → treat as delete so we don't keep ghost rows
            await conn.execute(
                "DELETE FROM campaign_nicknames WHERE campaign_id = $1",
                campaign_id,
            )
            return {"ok": True, "deleted": True}
        await conn.execute(
            """
            INSERT INTO campaign_nicknames (campaign_id, store, designer, updated_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (campaign_id) DO UPDATE
            SET store = EXCLUDED.store,
                designer = EXCLUDED.designer,
                updated_at = NOW()
            """,
            campaign_id,
            store,
            designer,
        )
    return {"ok": True, "campaign_id": campaign_id, "store": store, "designer": designer}


@app.delete("/api/nicknames/{campaign_id}")
async def delete_nickname(campaign_id: str):
    pool = _require_db()
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM campaign_nicknames WHERE campaign_id = $1",
            campaign_id,
        )
    return {"ok": True}


# ── 電子發票 (ezPay) buyer profiles ───────────────────────────────────
#
# Phase 1: per-store buyer identity (統編 / 載具 / 捐贈碼) that the 開立發票
# form prefills from. Admin-gated — issuing statutory invoices and the
# buyer PII behind it are finance/operator concerns. Keyed by the store
# label so it lines up with 店家花費 aggregation.

_TAX_ID_RE = re.compile(r"^\d{8}$")


def _valid_tw_tax_id(tax_id: str) -> bool:
    """Taiwan 統一編號 (8-digit) checksum. The logic (2026 rule that also
    accepts the '7th digit == 7' special case) prevents a typo'd 統編 from
    reaching ezPay as a hard reject / invalid statutory invoice."""
    if not _TAX_ID_RE.match(tax_id):
        return False
    weights = (1, 2, 1, 2, 1, 2, 4, 1)
    digits = [int(c) for c in tax_id]

    def _digit_sum(n: int) -> int:
        return n // 10 + n % 10

    products = [_digit_sum(digits[i] * weights[i]) for i in range(8)]
    total = sum(products)
    if total % 5 == 0:
        return True
    # Special case: 7th digit (index 6) is 7 → the '7' can count as 0 or 1.
    if digits[6] == 7 and (total + 1) % 5 == 0:
        return True
    return False


class InvoiceBuyerPayload(BaseModel):
    category: str = "B2C"          # B2B | B2C
    buyer_name: str = ""
    tax_id: str = ""
    email: str = ""
    carrier_type: str = ""         # B2C: '0'手機條碼 '1'自然人憑證 '2'ezPay會員
    carrier_num: str = ""
    love_code: str = ""            # 捐贈碼 (mutually exclusive with carrier)
    print_flag: str = "N"
    address: str = ""
    notes: str = ""


def _buyer_row_to_dict(r) -> dict:
    return {
        "store": r["store"],
        "category": r["category"],
        "buyer_name": r["buyer_name"],
        "tax_id": r["tax_id"],
        "email": r["email"],
        "carrier_type": r["carrier_type"],
        "carrier_num": r["carrier_num"],
        "love_code": r["love_code"],
        "print_flag": r["print_flag"],
        "address": r["address"],
        "notes": r["notes"],
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    }


@app.get("/api/invoice-buyers")
async def list_invoice_buyers():
    _require_admin()
    pool = _require_db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM invoice_buyers ORDER BY store"
        )
    return {"data": [_buyer_row_to_dict(r) for r in rows]}


@app.post("/api/invoice-buyers/{store}")
async def upsert_invoice_buyer(store: str, payload: InvoiceBuyerPayload):
    _require_admin()
    pool = _require_db()
    store_key = (store or "").strip()
    if not store_key:
        raise HTTPException(status_code=400, detail="缺少店家名稱")
    category = "B2B" if (payload.category or "").upper() == "B2B" else "B2C"
    tax_id = (payload.tax_id or "").strip()
    carrier_num = (payload.carrier_num or "").strip()
    love_code = (payload.love_code or "").strip()
    # B2B: 統編 required + valid; ezPay 三聯式 must print.
    if category == "B2B":
        if not _valid_tw_tax_id(tax_id):
            raise HTTPException(status_code=400, detail="統一編號格式錯誤(需 8 碼且通過檢查碼)")
        print_flag = "Y"
        carrier_type = carrier_num = love_code = ""
    else:
        tax_id = ""
        # B2C: carrier and 捐贈碼 are mutually exclusive.
        if carrier_num and love_code:
            raise HTTPException(status_code=400, detail="載具號碼與捐贈碼只能擇一")
        carrier_type = (payload.carrier_type or "").strip()
        print_flag = "Y" if (payload.print_flag or "").upper() == "Y" else "N"
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO invoice_buyers (
                store, category, buyer_name, tax_id, email,
                carrier_type, carrier_num, love_code, print_flag,
                address, notes, updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
            ON CONFLICT (store) DO UPDATE SET
                category = EXCLUDED.category,
                buyer_name = EXCLUDED.buyer_name,
                tax_id = EXCLUDED.tax_id,
                email = EXCLUDED.email,
                carrier_type = EXCLUDED.carrier_type,
                carrier_num = EXCLUDED.carrier_num,
                love_code = EXCLUDED.love_code,
                print_flag = EXCLUDED.print_flag,
                address = EXCLUDED.address,
                notes = EXCLUDED.notes,
                updated_at = NOW()
            """,
            store_key, category, (payload.buyer_name or "").strip(), tax_id,
            (payload.email or "").strip(), carrier_type, carrier_num, love_code,
            print_flag, (payload.address or "").strip(), (payload.notes or "").strip(),
        )
        row = await conn.fetchrow("SELECT * FROM invoice_buyers WHERE store = $1", store_key)
    return {"ok": True, "data": _buyer_row_to_dict(row)}


@app.delete("/api/invoice-buyers/{store}")
async def delete_invoice_buyer(store: str):
    _require_admin()
    pool = _require_db()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM invoice_buyers WHERE store = $1", (store or "").strip())
    return {"ok": True}


# ── 電子發票 開立 (Phase 2) ───────────────────────────────────────────
#
# 手動開立 from the 開立發票 tab: the frontend reuses the 費用中心 numbers
# (花費 / % / 花費+%) — the operator picks a campaign, and 花費+% (the
# store bill, ceil(spend × (1+markup/100))) becomes the invoice 含稅總額.
# 應稅 5%: Amt = round(TotalAmt/1.05), TaxAmt = TotalAmt - Amt (subtract,
# never independently round, or ezPay rejects Amt+TaxAmt != TotalAmt).
# 個人 (B2C) = 雲端發票 (no buyer fields); 統編 (B2B) = 統編 + 抬頭.


class IssueInvoicePayload(BaseModel):
    category: str                      # B2B | B2C
    total_amt: int                     # 花費+% 含稅總額
    item_name: str = "廣告行銷"
    # buyer (B2B only; B2C 雲端發票 needs nothing)
    buyer_name: str = ""
    tax_id: str = ""
    email: str = ""
    # provenance (for the record + the cost-center hook)
    store: str = ""
    account_id: str = ""
    campaign_id: str = ""
    period: str = ""                   # YYYY-MM
    spend: Optional[int] = None
    markup_percent: Optional[float] = None


def _gen_merchant_order_no() -> str:
    # ezPay MerchantOrderNo: ≤20 alnum. "EI" + 16 hex = 18 chars. The
    # DB UNIQUE constraint is the real dup guard.
    return f"EI{uuid.uuid4().hex[:16]}"


# The ezPay 商店金鑰 is a single team-wide config (all ad accounts bill
# under the same merchant), stored as one row in `einvoice_merchants`
# under this sentinel PK.
_EZPAY_GLOBAL_KEY = "__global__"


async def _resolve_ezpay_creds() -> dict:
    """Team-wide ezPay credentials (`einvoice_merchants` global row), falling
    back to the env globals when not configured. `is_test` selects the cinv
    (test) vs inv (prod) host. Returns
    {base, merchant_id, hash_key, hash_iv, mock, source}."""
    if _db_pool is not None:
        try:
            async with _db_pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT merchant_id, hash_key, hash_iv, is_test "
                    "FROM einvoice_merchants WHERE account_id = $1",
                    _EZPAY_GLOBAL_KEY,
                )
            if row and row["merchant_id"] and row["hash_key"] and row["hash_iv"]:
                base = (
                    "https://cinv.ezpay.com.tw" if row["is_test"] else "https://inv.ezpay.com.tw"
                )
                return {
                    "base": base,
                    "merchant_id": row["merchant_id"],
                    "hash_key": row["hash_key"],
                    "hash_iv": row["hash_iv"],
                    "mock": "0",
                    "source": "db",
                }
        except Exception as exc:
            print(f"[einvoice] merchant lookup failed: {exc!r}", flush=True)
    return {
        "base": EZPAY_API_BASE,
        "merchant_id": EZPAY_MERCHANT_ID,
        "hash_key": EZPAY_HASH_KEY,
        "hash_iv": EZPAY_HASH_IV,
        "mock": EZPAY_MOCK,
        "source": "env",
    }


@app.post("/api/einvoice/issue")
async def issue_einvoice(payload: IssueInvoicePayload):
    uid = _require_admin()
    pool = _require_db()
    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client 尚未就緒")

    category = "B2B" if (payload.category or "").upper() == "B2B" else "B2C"
    total = int(payload.total_amt or 0)
    if total <= 0:
        raise HTTPException(status_code=400, detail="發票金額必須大於 0")
    item_name = (payload.item_name or "").strip() or "廣告行銷"

    tax_id = (payload.tax_id or "").strip()
    buyer_name = (payload.buyer_name or "").strip()
    email = (payload.email or "").strip()
    if category == "B2B":
        if not _valid_tw_tax_id(tax_id):
            raise HTTPException(status_code=400, detail="統一編號格式錯誤(需 8 碼且通過檢查碼)")
        if not buyer_name:
            raise HTTPException(status_code=400, detail="B2B 需填寫公司抬頭")
        print_flag = "Y"
    else:
        # B2C 雲端發票 — no carrier / no 統編; ezPay stores it in the
        # cloud (買方載具 = the merchant's default). PrintFlag N.
        tax_id = ""
        print_flag = "N"

    # 應稅 5%: derive TaxAmt by subtraction.
    amt = round(total / 1.05)
    tax_amt = total - amt
    # B2C item price/amt are tax-INCLUSIVE (= TotalAmt); B2B are
    # tax-EXCLUSIVE (= Amt).
    item_amt = total if category == "B2C" else amt
    items = [{"name": item_name, "count": 1, "unit": "式", "price": item_amt, "amt": item_amt}]

    order_no = _gen_merchant_order_no()
    ts = int(time.time())

    ezpay_params = {
        "MerchantOrderNo": order_no,
        "Status": "1",
        "Category": category,
        "BuyerName": buyer_name or ("個人" if category == "B2C" else ""),
        "BuyerUBN": tax_id if category == "B2B" else "",
        "BuyerEmail": email,
        "PrintFlag": print_flag,
        "TaxType": "1",
        "TaxRate": "5",
        "Amt": str(amt),
        "TaxAmt": str(tax_amt),
        "TotalAmt": str(total),
        "ItemName": item_name,
        "ItemCount": "1",
        "ItemUnit": "式",
        "ItemPrice": str(item_amt),
        "ItemAmt": str(item_amt),
    }

    creds = await _resolve_ezpay_creds()
    try:
        result = await ezpay_client.issue_invoice(
            _http_client,
            base=creds["base"],
            merchant_id=creds["merchant_id"],
            hash_key=creds["hash_key"],
            hash_iv=creds["hash_iv"],
            params=ezpay_params,
            timestamp=ts,
            mock=creds["mock"],
        )
    except ezpay_client.EzpayError as e:
        raise HTTPException(status_code=502, detail=e.friendly_message) from e

    invoice_number = str(result.get("InvoiceNumber") or "") or None
    random_number = str(result.get("RandomNum") or "") or None
    invoice_trans_no = str(result.get("InvoiceTransNo") or "") or None
    check_code = str(result.get("CheckCode") or "") or None

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO einvoices (
                store, category, buyer_name, buyer_tax_id, buyer_email,
                print_flag, tax_type, tax_rate, amt, tax_amt, total_amt,
                items, merchant_order_no, invoice_number, random_number,
                invoice_trans_no, check_code, status,
                raw_request, raw_response, created_by,
                account_id, campaign_id, period, spend, markup_percent
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,
                    $16,$17,'issued',$18::jsonb,$19::jsonb,$20,$21,$22,$23,$24,$25)
            RETURNING id, invoice_number, random_number, total_amt, status, created_at
            """,
            payload.store.strip(), category, buyer_name, tax_id, email,
            print_flag, "1", 5, amt, tax_amt, total,
            _json.dumps(items), order_no, invoice_number, random_number,
            invoice_trans_no, check_code,
            _json.dumps(ezpay_params), _json.dumps(result), uid,
            payload.account_id.strip() or None, payload.campaign_id.strip() or None,
            payload.period.strip() or None,
            int(payload.spend) if payload.spend is not None else None,
            payload.markup_percent,
        )
    return {
        "ok": True,
        "id": str(row["id"]),
        "invoice_number": row["invoice_number"],
        "random_number": row["random_number"],
        "total_amt": row["total_amt"],
        "status": row["status"],
        "mock": bool(result.get("_mock")),
    }


class EInvoiceMerchantPayload(BaseModel):
    merchant_id: str = ""
    # hash_key / hash_iv optional on update — blank keeps the stored value
    # so the operator can change merchant_id / is_test without re-typing
    # the secrets. Required (non-blank) on first-time create.
    hash_key: str = ""
    hash_iv: str = ""
    is_test: bool = True


@app.get("/api/einvoice/merchant")
async def get_einvoice_merchant():
    """Team-wide ezPay merchant config for the 設定 modal. NEVER returns the
    secret hash_key / hash_iv — only whether they're set (+ length ok) so
    the UI can show「已設定」without leaking. → {data: {...} | null}"""
    _require_admin()
    pool = _require_db()
    async with pool.acquire() as conn:
        r = await conn.fetchrow(
            "SELECT merchant_id, is_test, hash_key, hash_iv, updated_at "
            "FROM einvoice_merchants WHERE account_id = $1",
            _EZPAY_GLOBAL_KEY,
        )
    if not r:
        return {"data": None}
    return {
        "data": {
            "merchant_id": r["merchant_id"],
            "is_test": bool(r["is_test"]),
            "has_key": len(r["hash_key"] or "") == 32,
            "has_iv": len(r["hash_iv"] or "") == 16,
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        }
    }


@app.post("/api/einvoice/merchant")
async def upsert_einvoice_merchant(payload: EInvoiceMerchantPayload):
    """Create/update the team-wide ezPay 商店金鑰 (one merchant for all ad
    accounts). hash_key/hash_iv left blank keep the existing stored secret
    (edit merchant_id / is_test without re-typing); on first create they are
    required + length-validated."""
    uid = _require_admin()
    pool = _require_db()
    merchant_id = (payload.merchant_id or "").strip()
    if not merchant_id:
        raise HTTPException(status_code=400, detail="請填寫商店代號 MerchantID")
    new_key = (payload.hash_key or "").strip()
    new_iv = (payload.hash_iv or "").strip()

    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT hash_key, hash_iv FROM einvoice_merchants WHERE account_id = $1",
            _EZPAY_GLOBAL_KEY,
        )
        hash_key = new_key or (existing["hash_key"] if existing else "")
        hash_iv = new_iv or (existing["hash_iv"] if existing else "")
        if len(hash_key) != 32:
            raise HTTPException(status_code=400, detail="HashKey 需 32 碼")
        if len(hash_iv) != 16:
            raise HTTPException(status_code=400, detail="HashIV 需 16 碼")
        await conn.execute(
            """
            INSERT INTO einvoice_merchants (account_id, merchant_id, hash_key, hash_iv, is_test, updated_by, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (account_id) DO UPDATE
            SET merchant_id = EXCLUDED.merchant_id,
                hash_key = EXCLUDED.hash_key,
                hash_iv = EXCLUDED.hash_iv,
                is_test = EXCLUDED.is_test,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()
            """,
            _EZPAY_GLOBAL_KEY, merchant_id, hash_key, hash_iv, bool(payload.is_test), uid,
        )
    return {"ok": True}


@app.delete("/api/einvoice/merchant")
async def delete_einvoice_merchant():
    """Remove the ezPay config → falls back to the env globals."""
    _require_admin()
    pool = _require_db()
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM einvoice_merchants WHERE account_id = $1", _EZPAY_GLOBAL_KEY
        )
    return {"ok": True}


class EInvoiceDraftPayload(BaseModel):
    category: str = "B2C"
    item_name: str = "廣告行銷"
    buyer_name: str = ""
    tax_id: str = ""
    email: str = ""


@app.get("/api/einvoice/drafts")
async def list_einvoice_drafts():
    """Per-campaign remembered issue inputs → {data: {campaign_id: {...}}}."""
    _require_admin()
    pool = _require_db()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT campaign_id, category, item_name, buyer_name, tax_id, email FROM einvoice_campaign_drafts"
        )
    return {
        "data": {
            r["campaign_id"]: {
                "category": r["category"],
                "item_name": r["item_name"],
                "buyer_name": r["buyer_name"],
                "tax_id": r["tax_id"],
                "email": r["email"],
            }
            for r in rows
        }
    }


@app.post("/api/einvoice/drafts/{campaign_id}")
async def upsert_einvoice_draft(campaign_id: str, payload: EInvoiceDraftPayload):
    _require_admin()
    pool = _require_db()
    cid = (campaign_id or "").strip()
    if not cid:
        raise HTTPException(status_code=400, detail="缺少 campaign_id")
    category = "B2B" if (payload.category or "").upper() == "B2B" else "B2C"
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO einvoice_campaign_drafts
                (campaign_id, category, item_name, buyer_name, tax_id, email, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6, NOW())
            ON CONFLICT (campaign_id) DO UPDATE SET
                category = EXCLUDED.category,
                item_name = EXCLUDED.item_name,
                buyer_name = EXCLUDED.buyer_name,
                tax_id = EXCLUDED.tax_id,
                email = EXCLUDED.email,
                updated_at = NOW()
            """,
            cid, category, (payload.item_name or "").strip() or "廣告行銷",
            (payload.buyer_name or "").strip(), (payload.tax_id or "").strip(),
            (payload.email or "").strip(),
        )
    return {"ok": True}


@app.delete("/api/einvoices/{einvoice_id}")
async def delete_einvoice(einvoice_id: str):
    """Hard-delete an 開立紀錄 row. Admin-gated. Used to clear test /
    mock records (a real issued invoice would be 作廢, added later)."""
    _require_admin()
    pool = _require_db()
    if not _UUID_RE.match(einvoice_id):
        raise HTTPException(status_code=404, detail="找不到發票紀錄")
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM einvoices WHERE id = $1::uuid", einvoice_id)
    return {"ok": True}


@app.get("/api/einvoices")
async def list_einvoices(
    store: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    period: Optional[str] = Query(None),
    limit: int = Query(100),
    offset: int = Query(0),
):
    """開立紀錄 list. Admin-gated. Never returns the raw_request /
    raw_response payloads (buyer PII) — those are only in the per-id
    detail endpoint (later)."""
    _require_admin()
    pool = _require_db()
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    conds = []
    args: list = []
    if store:
        args.append(store)
        conds.append(f"store = ${len(args)}")
    if status:
        args.append(status)
        conds.append(f"status = ${len(args)}")
    if period:
        args.append(period)
        conds.append(f"period = ${len(args)}")
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    async with pool.acquire() as conn:
        total = await conn.fetchval(f"SELECT count(*) FROM einvoices {where}", *args)
        rows = await conn.fetch(
            f"""
            SELECT id, store, category, buyer_name, buyer_tax_id, total_amt,
                   spend, markup_percent,
                   invoice_number, random_number, status, period, campaign_id,
                   created_at
            FROM einvoices
            {where}
            ORDER BY created_at DESC
            LIMIT {limit} OFFSET {offset}
            """,
            *args,
        )
    return {
        "total": int(total or 0),
        "data": [
            {
                "id": str(r["id"]),
                "store": r["store"],
                "category": r["category"],
                "buyer_name": r["buyer_name"],
                "buyer_tax_id": r["buyer_tax_id"],
                "total_amt": r["total_amt"],
                "spend": r["spend"],
                "markup_percent": float(r["markup_percent"]) if r["markup_percent"] is not None else None,
                "invoice_number": r["invoice_number"],
                "random_number": r["random_number"],
                "status": r["status"],
                "period": r["period"],
                "campaign_id": r["campaign_id"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ],
    }


# ── Settings (PostgreSQL-backed) ──────────────────────────────────────
#
# Two scopes:
#   - user_settings: keyed on (fb_user_id, key). Each user owns their
#     own row. Used for: selected accounts, account order.
#   - shared_settings: keyed on key only, visible to every user. Used
#     for: finance row markups, pinned ids, default markup, show
#     nicknames toggle.
#
# `fb_user_id` is passed by the frontend — it's the FB /me id that the
# frontend already has after login. The backend trusts it (this is an
# internal agency tool; the blast radius of a forged user id is another
# person's private settings, not data exposure).

import json


class SettingsValuePayload(BaseModel):
    value: Any


@app.get("/api/settings/user/{fb_user_id}")
async def get_user_settings(fb_user_id: str):
    _assert_known_user(fb_user_id)
    if _db_pool is None:
        return {"data": {}}
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value FROM user_settings WHERE fb_user_id = $1",
            fb_user_id,
        )
    # asyncpg returns the jsonb column as a str; decode to the real
    # Python object so the JSON response is nested, not a string.
    return {
        "data": {
            r["key"]: (json.loads(r["value"]) if isinstance(r["value"], str) else r["value"])
            for r in rows
        }
    }


@app.post("/api/settings/user/{fb_user_id}/{key}")
async def upsert_user_setting(fb_user_id: str, key: str, payload: SettingsValuePayload):
    _assert_known_user(fb_user_id)
    pool = _require_db()
    # Tier-limit gate on selected_accounts: cap the number of
    # enabled ad accounts at the user's plan limit. The limit is
    # the user's source of truth — frontend shows an upgrade prompt
    # before sending, but a stale tab could still over-submit.
    if key == "selected_accounts" and isinstance(payload.value, list):
        limits = await _get_user_limits(fb_user_id)
        cap = limits["ad_accounts"]
        if not _is_unlimited(cap) and len(payload.value) > cap:
            raise _tier_limit_error(
                "ad_accounts",
                cap,
                limits["tier"],
                f"目前方案最多可啟用 {cap} 個廣告帳戶,請升級方案",
            )
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO user_settings (fb_user_id, key, value, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (fb_user_id, key) DO UPDATE
            SET value = EXCLUDED.value,
                updated_at = NOW()
            """,
            fb_user_id,
            key,
            json.dumps(payload.value),
        )
    # Redact uid in logs — only show suffix to confirm right user
    # without leaking the full FB id to log aggregators.
    uid_tail = (fb_user_id or "")[-4:]
    print(f"[settings] user POST uid=…{uid_tail} key={key!r}", flush=True)
    return {"ok": True}


@app.delete("/api/settings/user/{fb_user_id}/{key}")
async def delete_user_setting(fb_user_id: str, key: str):
    _assert_known_user(fb_user_id)
    pool = _require_db()
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM user_settings WHERE fb_user_id = $1 AND key = $2",
            fb_user_id,
            key,
        )
    return {"ok": True}


@app.get("/api/settings/shared")
async def get_shared_settings():
    if _db_pool is None:
        return {"data": {}}
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch("SELECT key, value FROM shared_settings")
    # Underscore-prefixed keys (e.g. _fb_runtime_token) are server
    # internal — never leak them to the frontend.
    return {
        "data": {
            r["key"]: (json.loads(r["value"]) if isinstance(r["value"], str) else r["value"])
            for r in rows
            if not r["key"].startswith("_")
        }
    }


@app.post("/api/settings/shared/{key}")
async def upsert_shared_setting(key: str, payload: SettingsValuePayload):
    pool = _require_db()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO shared_settings (key, value, updated_at)
                VALUES ($1, $2::jsonb, NOW())
                ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value,
                    updated_at = NOW()
                """,
                key,
                json.dumps(payload.value),
            )
            if key == "security_push_master_enabled" and payload.value is True:
                next_run_at = _next_security_push_run_at()
                await conn.execute(
                    """
                    UPDATE security_push_configs
                    SET next_run_at = $1,
                        updated_at = NOW()
                    WHERE enabled
                    """,
                    next_run_at,
                )
            elif key == "security_push_interval_hours":
                # Operator picked a new cadence — re-align every enabled
                # config so the next scan fires at the new boundary,
                # not at the old `last_run_at + previous_interval`
                # boundary which can be hours in the future for
                # 12h / 24h cadences.
                try:
                    n = int(payload.value)
                except (TypeError, ValueError):
                    n = 0
                if n in _VALID_SECURITY_PUSH_INTERVALS:
                    next_run_at = _next_security_push_run_at(interval_hours=n)
                    await conn.execute(
                        """
                        UPDATE security_push_configs
                        SET next_run_at = $1,
                            updated_at = NOW()
                        WHERE enabled
                        """,
                        next_run_at,
                    )
    print(f"[settings] shared POST key={key!r}", flush=True)
    return {"ok": True}


# ── Debug dump endpoint ───────────────────────────────────────────────
#
# Curl-able from a browser / fetch() so the user can see:
#   - whether DATABASE_URL is live
#   - what fb_user_id currently owns which user_settings rows
#   - what shared_settings are stored
#   - how many campaign_nicknames exist
# Returns redacted output (no value payloads that might contain secrets,
# though our data is already non-sensitive). Useful for diagnosing
# "saved settings didn't come back".

_DEBUG_ENABLED = os.getenv("LURE_DEBUG", "").lower() in {"1", "true", "yes"}


@app.get("/api/_debug/settings")
async def debug_settings_dump():
    # Production gate — this endpoint dumps every fb_user_id and shared
    # setting key. Only expose when explicitly opted in via LURE_DEBUG=1.
    if not _DEBUG_ENABLED:
        raise HTTPException(status_code=404, detail="Not found")
    if _db_pool is None:
        return {"db": "not_configured", "database_url_set": bool(DATABASE_URL)}
    out: dict = {"db": "connected"}
    async with _db_pool.acquire() as conn:
        user_rows = await conn.fetch(
            "SELECT fb_user_id, key, value, updated_at FROM user_settings ORDER BY updated_at DESC"
        )
        shared_rows = await conn.fetch(
            "SELECT key, value, updated_at FROM shared_settings ORDER BY updated_at DESC"
        )
        nickname_count = await conn.fetchval("SELECT COUNT(*) FROM campaign_nicknames")
    out["user_settings"] = [
        {
            "fb_user_id": r["fb_user_id"],
            "key": r["key"],
            "value": (json.loads(r["value"]) if isinstance(r["value"], str) else r["value"]),
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        }
        for r in user_rows
    ]
    out["shared_settings"] = [
        {
            "key": r["key"],
            "value": (json.loads(r["value"]) if isinstance(r["value"], str) else r["value"]),
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        }
        for r in shared_rows
    ]
    out["campaign_nicknames_count"] = nickname_count
    return out


@app.delete("/api/settings/shared/{key}")
async def delete_shared_setting(key: str):
    pool = _require_db()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM shared_settings WHERE key = $1", key)
    return {"ok": True}


# ── Billing / Pricing (Polar.sh) ──────────────────────────────────────
#
# Three monthly tiers + a free tier. Polar handles checkout, trial
# logic, payment retries, and the customer self-service portal. This
# server's responsibilities are narrower:
#
#   1. Serve TIER_CONFIGS to the public /pricing page.
#   2. Read `subscriptions` to answer "what tier is this user?".
#   3. Ingest Polar webhooks → upsert `subscriptions` (Phase 3 will
#      add signature verification + per-event handling; Phase 1 is
#      a stub that just persists raw payloads).
#
# Quota gates on the existing write endpoints land in Phase 5.

# ── 電子發票 (ezPay 藍新) ────────────────────────────────────────────
# Merchant credentials from the ezPay 商店後台. HashKey is 32 chars
# (AES-256), HashIV is 16 chars. Default API base is the TEST host
# (cinv.ezpay.com.tw); production = flip to https://inv.ezpay.com.tw
# with production credentials. EZPAY_MOCK=1 prints the decrypted payload
# instead of calling ezPay (dev, no credentials needed). Consumed from
# Phase 2 (ezpay_client.py); declared here so config is one place.
EZPAY_MERCHANT_ID = os.getenv("EZPAY_MERCHANT_ID", "")
EZPAY_HASH_KEY = os.getenv("EZPAY_HASH_KEY", "")
EZPAY_HASH_IV = os.getenv("EZPAY_HASH_IV", "")
EZPAY_API_BASE = os.getenv("EZPAY_API_BASE", "https://cinv.ezpay.com.tw")
EZPAY_MOCK = os.getenv("EZPAY_MOCK", "0")


def _ezpay_status_line() -> str:
    """One-line startup diagnostic for the ezPay config — never prints the
    actual keys, only whether they're set + the right length + which host.
    Lets operators confirm from Zeabur logs that env vars were picked up."""
    if str(EZPAY_MOCK).strip() in ("1", "true", "True"):
        return "[startup] ezPay: MOCK mode (不打 ezPay,回假發票號碼)"
    host = "TEST" if "cinv." in EZPAY_API_BASE else "PROD"
    have_id = bool(EZPAY_MERCHANT_ID)
    key_ok = len(EZPAY_HASH_KEY) == 32
    iv_ok = len(EZPAY_HASH_IV) == 16
    if have_id and key_ok and iv_ok:
        return f"[startup] ezPay: {host} host, creds OK (merchant={EZPAY_MERCHANT_ID})"
    problems = []
    if not have_id:
        problems.append("MERCHANT_ID 未設")
    if not key_ok:
        problems.append(f"HASH_KEY 長度={len(EZPAY_HASH_KEY)}(需32)")
    if not iv_ok:
        problems.append(f"HASH_IV 長度={len(EZPAY_HASH_IV)}(需16)")
    return f"[startup] ezPay: {host} host, 設定不完整 → 會退回 MOCK — {', '.join(problems)}"

POLAR_API_KEY = os.getenv("POLAR_API_KEY", "")
POLAR_WEBHOOK_SECRET = os.getenv("POLAR_WEBHOOK_SECRET", "")
# Polar product ids per tier. The fall-back to the legacy
# `_STARTER/_GROWTH/_AGENCY` names lets ops rename Zeabur env keys
# at their own pace — both old and new lookups work.
POLAR_PRODUCT_ID_BASIC = os.getenv("POLAR_PRODUCT_ID_BASIC") or os.getenv("POLAR_PRODUCT_ID_STARTER", "")
POLAR_PRODUCT_ID_PLUS = os.getenv("POLAR_PRODUCT_ID_PLUS") or os.getenv("POLAR_PRODUCT_ID_GROWTH", "")
POLAR_PRODUCT_ID_MAX = os.getenv("POLAR_PRODUCT_ID_MAX") or os.getenv("POLAR_PRODUCT_ID_AGENCY", "")

# Single source of truth for both the /pricing page display AND the
# quota limits applied per tier. Keep the *_limit values in sync with
# the limits shown on the pricing page — frontend reads them via
# /api/pricing/config so they only need updating here.
#
# `-1` for any *_limit means "unlimited" (the Agency tier).
TIER_CONFIGS: dict = {
    "free": {
        "tier": "free",
        "name": "Free",
        "price_monthly": 0,
        "price_monthly_full": 0,
        "ad_accounts_limit": 1,
        "line_channels_limit": 0,
        "line_groups_limit": 0,
        # monthly_push_limit removed as a tier differentiator (2026-05-08)
        # — actual push budget is bounded by LINE Official Account's own
        # monthly message quota (LINE bills `messages × recipients`),
        # which the operator pays LINE for separately. Keeping our own
        # internal cap on top added confusion ("Max 為什麼還會被擋")
        # without saving any FB / LINE cost. Free still effectively
        # can't push because line_channels_limit = 0 (no OA → no group →
        # no push).
        "monthly_push_limit": -1,
        # Free tier gets 40 LIFETIME trial runs (not per-month). The
        # period is enforced by the tier check in
        # _count_advice_runs_for_quota — paid tiers count this
        # month, free counts forever.
        "agent_advice_limit": 40,
        "polar_product_id": "",
    },
    "basic": {
        "tier": "basic",
        "name": "Basic",
        "price_monthly": 990,
        "price_monthly_full": 1980,
        "ad_accounts_limit": 5,
        "line_channels_limit": 1,
        "line_groups_limit": 3,
        "monthly_push_limit": -1,
        "agent_advice_limit": 2,
        "polar_product_id": POLAR_PRODUCT_ID_BASIC,
    },
    "plus": {
        "tier": "plus",
        "name": "Plus",
        "price_monthly": 2490,
        "price_monthly_full": 4980,
        "ad_accounts_limit": 20,
        "line_channels_limit": 3,
        "line_groups_limit": 15,
        "monthly_push_limit": -1,
        "agent_advice_limit": 6,
        "polar_product_id": POLAR_PRODUCT_ID_PLUS,
    },
    "max": {
        "tier": "max",
        "name": "Max",
        "price_monthly": 6490,
        "price_monthly_full": 12980,
        "ad_accounts_limit": -1,
        "line_channels_limit": -1,
        "line_groups_limit": -1,
        "monthly_push_limit": -1,
        "agent_advice_limit": -1,
        "polar_product_id": POLAR_PRODUCT_ID_MAX,
    },
}


def _free_tier_state() -> dict:
    """Default subscription state for users with no `subscriptions` row."""
    cfg = TIER_CONFIGS["free"]
    return {
        "tier": "free",
        "status": "free",
        "ad_accounts_limit": cfg["ad_accounts_limit"],
        "line_channels_limit": cfg["line_channels_limit"],
        "line_groups_limit": cfg["line_groups_limit"],
        "monthly_push_limit": cfg["monthly_push_limit"],
        "agent_advice_limit": cfg["agent_advice_limit"],
        "trial_ends_at": None,
        "current_period_end": None,
        "cancel_at_period_end": False,
        "polar_customer_id": None,
        "polar_subscription_id": None,
    }


@app.get("/api/pricing/config")
async def get_pricing_config():
    """Public — used by the /pricing page (no auth required)."""
    # Strip Polar product ids from the public response — they're
    # only used server-side when building checkout URLs.
    public_tiers = []
    for cfg in TIER_CONFIGS.values():
        public = {k: v for k, v in cfg.items() if k != "polar_product_id"}
        public_tiers.append(public)
    return {
        "currency": "TWD",
        "trial_days": 30,
        "tiers": public_tiers,
    }


@app.get("/api/billing/me")
async def get_billing_me(fb_user_id: str = Query(...)):
    """Return the calling user's subscription state + tier limits.

    Falls back to free-tier defaults when no row exists, so the
    frontend never has to special-case "user has never subscribed".
    """
    _assert_known_user(fb_user_id)
    if _db_pool is None:
        return {"data": _free_tier_state()}
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM subscriptions WHERE fb_user_id = $1",
            fb_user_id,
        )
    if not row:
        return {"data": _free_tier_state()}
    out = dict(row)
    # Once Polar marks the subscription as canceled the user no
    # longer has a paid relationship — surface the free-tier limits
    # so dashboards and feature gates fall back to free immediately.
    # We keep polar_customer_id (so the manage / re-subscribe button
    # still works) and clear the dangling trial / period markers
    # that would otherwise render as "下次扣款" UI.
    if str(out.get("status") or "").lower() == "canceled":
        free = _free_tier_state()
        out["tier"] = free["tier"]
        out["status"] = free["status"]
        out["ad_accounts_limit"] = free["ad_accounts_limit"]
        out["line_channels_limit"] = free["line_channels_limit"]
        out["line_groups_limit"] = free["line_groups_limit"]
        out["monthly_push_limit"] = free["monthly_push_limit"]
        out["agent_advice_limit"] = free["agent_advice_limit"]
        out["trial_ends_at"] = None
        out["current_period_end"] = None
        out["cancel_at_period_end"] = False
    # asyncpg returns datetime objects; the JSON encoder needs
    # ISO strings.
    for k in ("trial_ends_at", "current_period_end", "created_at", "updated_at"):
        if out.get(k) is not None:
            out[k] = out[k].isoformat()
    return {"data": out}


# ── Tier limit enforcement ────────────────────────────────────────────
#
# Each subscription tier caps four resources:
#   - ad_accounts  : how many FB ad accounts the user can have enabled
#                    in their Settings selection (selected_accounts)
#   - line_channels: how many LINE OA channels the user owns
#   - line_groups  : how many active push configs the user has
#                    (one config = one campaign × group × frequency)
#   - monthly_push : total successful pushes this calendar month
#
# Limits live on the `subscriptions` row (denormalised from the tier
# config). -1 in TIER_CONFIGS / 999_999 in the row means "unlimited".
# We use a slightly lower sentinel (_UNLIMITED_SENTINEL) so the helper
# treats anything in that range as no-limit at check time.

_UNLIMITED_SENTINEL = 999_000


def _is_unlimited(limit: int) -> bool:
    return limit < 0 or limit >= _UNLIMITED_SENTINEL


async def _get_user_limits(fb_user_id: str) -> dict:
    """Return the user's current tier + cap on each capped resource.
    Falls back to free-tier values when the user has no subscription
    row, or when their row is `status = canceled` (mirrors the same
    UI fallback applied by /api/billing/me)."""
    free = TIER_CONFIGS["free"]
    free_limits = {
        "tier": "free",
        "ad_accounts": free["ad_accounts_limit"],
        "line_channels": free["line_channels_limit"],
        "line_groups": free["line_groups_limit"],
        "monthly_push": free["monthly_push_limit"],
        "agent_advice": free["agent_advice_limit"],
    }
    if _db_pool is None or not fb_user_id:
        return free_limits
    # SELECT * + dict access so a missing `agent_advice_limit`
    # column (lifespan migration hasn't fired yet on this pod) is
    # tolerated by the .get() fallback below instead of crashing the
    # query with "column does not exist".
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM subscriptions WHERE fb_user_id = $1",
            fb_user_id,
        )
    if not row or str(row["status"] or "").lower() == "canceled":
        return free_limits
    row_d = dict(row)
    return {
        "tier": row_d.get("tier") or "free",
        "ad_accounts": int(row_d.get("ad_accounts_limit") or 0),
        "line_channels": int(row_d.get("line_channels_limit") or 0),
        "line_groups": int(row_d.get("line_groups_limit") or 0),
        "monthly_push": (
            _UNLIMITED_SENTINEL
            if row_d.get("monthly_push_limit") is None
            else int(row_d["monthly_push_limit"])
        ),
        "agent_advice": (
            _tier_default_agent_advice(row_d.get("tier"))
            if row_d.get("agent_advice_limit") is None
            else int(row_d["agent_advice_limit"])
        ),
    }


def _tier_default_agent_advice(tier: Optional[str]) -> int:
    """Resolve the agent_advice cap from the tier name when the
    `agent_advice_limit` column is NULL on a row (typical for
    rows written before this column existed). Avoids a destructive
    backfill at deploy time."""
    cfg = TIER_CONFIGS.get(str(tier or "free").lower()) or TIER_CONFIGS["free"]
    raw = int(cfg["agent_advice_limit"])
    return _UNLIMITED_SENTINEL if raw == -1 else raw


async def _count_selected_accounts(fb_user_id: str) -> int:
    if _db_pool is None or not fb_user_id:
        return 0
    async with _db_pool.acquire() as conn:
        val = await conn.fetchval(
            "SELECT value FROM user_settings WHERE fb_user_id = $1 AND key = 'selected_accounts'",
            fb_user_id,
        )
    if val is None:
        return 0
    try:
        if isinstance(val, str):
            val = json.loads(val)
        if isinstance(val, list):
            return len(val)
    except Exception:
        pass
    return 0


async def _count_line_channels(fb_user_id: str) -> int:
    if _db_pool is None or not fb_user_id:
        return 0
    async with _db_pool.acquire() as conn:
        n = await conn.fetchval(
            "SELECT COUNT(*) FROM line_channels WHERE owner_fb_user_id = $1",
            fb_user_id,
        )
    return int(n or 0)


async def _count_user_push_configs(fb_user_id: str) -> int:
    """Count push configs that target a group bound to a channel
    owned by this user."""
    if _db_pool is None or not fb_user_id:
        return 0
    async with _db_pool.acquire() as conn:
        n = await conn.fetchval(
            """
            SELECT COUNT(*) FROM campaign_line_push_configs c
            JOIN line_groups g ON g.group_id = c.group_id
            JOIN line_channels ch ON ch.id = g.channel_id
            WHERE ch.owner_fb_user_id = $1
            """,
            fb_user_id,
        )
    return int(n or 0)


async def _count_monthly_advice_runs(fb_user_id: str) -> int:
    """Optimization generation clicks this user has fired so far this
    calendar month (UTC). One row in `agent_advice_runs` = one click
    = one quota use. Used by paid tiers (basic / plus / max)."""
    if _db_pool is None or not fb_user_id:
        return 0
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    async with _db_pool.acquire() as conn:
        n = await conn.fetchval(
            """
            SELECT COUNT(*) FROM agent_advice_runs
            WHERE fb_user_id = $1 AND created_at >= $2
            """,
            fb_user_id,
            month_start,
        )
    return int(n or 0)


async def _count_lifetime_advice_runs(fb_user_id: str) -> int:
    """All-time AI 幕僚 generation clicks for this user. Used by the
    Free tier, which gets 3 LIFETIME trial runs rather than a
    monthly reset — the trials are a "try before you subscribe"
    affordance, not a recurring allowance."""
    if _db_pool is None or not fb_user_id:
        return 0
    async with _db_pool.acquire() as conn:
        n = await conn.fetchval(
            "SELECT COUNT(*) FROM agent_advice_runs WHERE fb_user_id = $1",
            fb_user_id,
        )
    return int(n or 0)


async def _count_advice_runs_for_quota(fb_user_id: str, tier: str) -> int:
    """Pick the right counter based on the user's current tier.
    Keeps the quota arithmetic in one place so the endpoint and the
    /api/billing/usage view always agree on what 'used' means."""
    if str(tier or "free").lower() == "free":
        return await _count_lifetime_advice_runs(fb_user_id)
    return await _count_monthly_advice_runs(fb_user_id)


async def _count_monthly_pushes(fb_user_id: str) -> int:
    """Successful pushes this calendar month (UTC) for configs
    owned by this user."""
    if _db_pool is None or not fb_user_id:
        return 0
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    async with _db_pool.acquire() as conn:
        n = await conn.fetchval(
            """
            SELECT COUNT(*) FROM line_push_logs l
            JOIN campaign_line_push_configs c ON c.id = l.config_id
            JOIN line_groups g ON g.group_id = c.group_id
            JOIN line_channels ch ON ch.id = g.channel_id
            WHERE ch.owner_fb_user_id = $1
              AND l.run_at >= $2
              AND l.success = TRUE
            """,
            fb_user_id,
            month_start,
        )
    return int(n or 0)


async def _grace_blocked(
    fb_user_id: str,
    config_id: str,
    cache: dict,
) -> bool:
    """True iff this push config should be skipped because the owner
    is over the line_groups cap AND past the grace period.

    `cache` is a per-tick dict mapping owner uid to either:
      - None (no enforcement: under limit, unlimited tier, or still
        in grace period) — every config OK
      - set[str] of OLDEST N config IDs that are still allowed
    """
    if fb_user_id in cache:
        allowed = cache[fb_user_id]
        return allowed is not None and config_id not in allowed

    limits = await _get_user_limits(fb_user_id)
    cap = limits["line_groups"]
    if _is_unlimited(cap):
        cache[fb_user_id] = None
        return False
    if _db_pool is None:
        cache[fb_user_id] = None
        return False
    async with _db_pool.acquire() as conn:
        over_since = await conn.fetchval(
            "SELECT over_limit_since FROM subscriptions WHERE fb_user_id = $1",
            fb_user_id,
        )
    if over_since is None:
        cache[fb_user_id] = None
        return False
    if datetime.now(timezone.utc) < over_since + timedelta(days=GRACE_PERIOD_DAYS):
        cache[fb_user_id] = None
        return False
    # Grace expired AND user has been over → keep only the oldest cap
    # configs alive. created_at sort means new additions are blocked
    # first, which matches the user's mental model (they remember the
    # ones they set up early).
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.id::text AS id FROM campaign_line_push_configs c
            JOIN line_groups g ON g.group_id = c.group_id
            JOIN line_channels ch ON ch.id = g.channel_id
            WHERE ch.owner_fb_user_id = $1
            ORDER BY c.created_at ASC
            LIMIT $2
            """,
            fb_user_id,
            cap,
        )
    allowed = {r["id"] for r in rows}
    cache[fb_user_id] = allowed
    return config_id not in allowed


async def _get_group_owner(group_id: str) -> Optional[str]:
    """Return the owner fb_user_id for a given LINE group via its
    channel ownership. Used by the scheduler to look up the user
    whose monthly_push limit a queued push counts against."""
    if _db_pool is None or not group_id:
        return None
    async with _db_pool.acquire() as conn:
        uid = await conn.fetchval(
            """
            SELECT ch.owner_fb_user_id
            FROM line_groups g
            JOIN line_channels ch ON ch.id = g.channel_id
            WHERE g.group_id = $1
            LIMIT 1
            """,
            group_id,
        )
    return uid


async def _fb_user_display_name(uid: Optional[str]) -> Optional[str]:
    """Best-effort display name (暱稱 → FB name) for a fb_user_id, so a
    token-expired push error can name WHO must re-log in. Returns None if
    unknown / no DB."""
    if not uid or _db_pool is None:
        return None
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT nickname, name FROM fb_user_profiles WHERE fb_user_id = $1",
                uid,
            )
        if row:
            return (row["nickname"] or row["name"] or None)
    except Exception:
        pass
    return None


async def _fb_user_display_names(uids: "set[str]") -> "dict[str, str]":
    """Batch-resolve many fb_user_ids to display names (暱稱 → FB name)
    in one query. Used by the 工程模式 panel so every table can show WHO
    triggered each call. Returns {} on no DB / empty input."""
    clean = {u for u in uids if u}
    if not clean or _db_pool is None:
        return {}
    try:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT fb_user_id, nickname, name FROM fb_user_profiles "
                "WHERE fb_user_id = ANY($1)",
                list(clean),
            )
        out: dict[str, str] = {}
        for r in rows:
            nm = r["nickname"] or r["name"]
            if nm:
                out[str(r["fb_user_id"])] = nm
        return out
    except Exception:
        return {}


def _tier_limit_error(resource: str, limit: int, tier: str, message: str) -> HTTPException:
    """Build the 403 we raise on every tier-limit miss. Frontend reads
    `code` to switch into the upgrade modal flow rather than a plain
    error toast."""
    return HTTPException(
        status_code=403,
        detail={
            "code": "tier_limit_exceeded",
            "resource": resource,
            "limit": limit,
            "tier": tier,
            "message": message,
        },
    )


# Days the user keeps full access after their usage first goes over
# the new tier's cap (typically because they downgraded). Mirrors the
# SaaS-standard "grace period" pattern — gives the user a window to
# trim resources or change their mind without immediately losing
# functionality. After expiry, the scheduler stops firing the excess
# push configs (which is the only resource that incurs ongoing cost).
GRACE_PERIOD_DAYS = 30


async def _refresh_over_limit_since(fb_user_id: str, usage: dict, limits: dict) -> Optional[datetime]:
    """Lazily maintain the `over_limit_since` timestamp on the
    subscriptions row. Called from /api/billing/usage so the grace
    timer starts the first time we observe an over-limit state and
    clears as soon as the user trims back under the cap.

    Returns the current `over_limit_since` value (after potential
    update) so the caller can compute `grace_expires_at`."""
    if _db_pool is None or not fb_user_id:
        return None
    over = any(
        not _is_unlimited(limits[k]) and usage[k] > limits[k]
        for k in ("ad_accounts", "line_channels", "line_groups")
    )
    async with _db_pool.acquire() as conn:
        existing = await conn.fetchval(
            "SELECT over_limit_since FROM subscriptions WHERE fb_user_id = $1",
            fb_user_id,
        )
        if over and existing is None:
            now = datetime.now(timezone.utc)
            await conn.execute(
                "UPDATE subscriptions SET over_limit_since = $1 WHERE fb_user_id = $2",
                now,
                fb_user_id,
            )
            return now
        if not over and existing is not None:
            await conn.execute(
                "UPDATE subscriptions SET over_limit_since = NULL WHERE fb_user_id = $1",
                fb_user_id,
            )
            return None
        return existing


@app.get("/api/billing/usage")
async def get_billing_usage(fb_user_id: str = Query(...)):
    """Return the user's tier limits + current usage for each capped
    resource. Frontend uses this to render "X / Y 已使用" indicators
    and decide whether to disable / intercept Add buttons.

    Also surfaces grace-period state when the user is currently
    above one or more caps (typically post-downgrade): we maintain
    `over_limit_since` lazily here so the timer starts immediately
    on the first usage check after they go over."""
    _assert_known_user(fb_user_id)
    limits = await _get_user_limits(fb_user_id)
    usage = {
        "ad_accounts": await _count_selected_accounts(fb_user_id),
        "line_channels": await _count_line_channels(fb_user_id),
        "line_groups": await _count_user_push_configs(fb_user_id),
        "monthly_push": await _count_monthly_pushes(fb_user_id),
        "agent_advice": await _count_advice_runs_for_quota(fb_user_id, limits["tier"]),
    }
    # Grace period only watches the three "stock" resources (the ones
    # the user explicitly configured) — monthly_push and agent_advice
    # are flow-based metrics that reset every month, so going over
    # them just means the rest of the month is gated, not that the
    # user has zombie data sitting around past their plan.
    over_since = await _refresh_over_limit_since(fb_user_id, usage, {
        "ad_accounts": limits["ad_accounts"],
        "line_channels": limits["line_channels"],
        "line_groups": limits["line_groups"],
        "monthly_push": limits["monthly_push"],
    })
    grace_expires_at: Optional[datetime] = None
    grace_expired = False
    if over_since is not None:
        grace_expires_at = over_since + timedelta(days=GRACE_PERIOD_DAYS)
        grace_expired = datetime.now(timezone.utc) >= grace_expires_at
    return {
        "data": {
            "tier": limits["tier"],
            "limits": {
                "ad_accounts": limits["ad_accounts"],
                "line_channels": limits["line_channels"],
                "line_groups": limits["line_groups"],
                "monthly_push": limits["monthly_push"],
                "agent_advice": limits["agent_advice"],
            },
            "usage": usage,
            # Free tier counts AI 幕僚 lifetime ("trial"); paid tiers
            # reset every calendar month. Frontend reads this to
            # pick the right wording ("免費試用" vs "本月").
            "agent_advice_period": "lifetime" if str(limits["tier"]).lower() == "free" else "monthly",
            "grace": {
                "over_limit_since": over_since.isoformat() if over_since else None,
                "expires_at": grace_expires_at.isoformat() if grace_expires_at else None,
                "expired": grace_expired,
                "period_days": GRACE_PERIOD_DAYS,
            },
        }
    }


POLAR_API_BASE = os.getenv("POLAR_API_BASE", "https://api.polar.sh/v1")


async def _polar_request(method: str, path: str, json_body: Optional[dict] = None) -> dict:
    """Thin wrapper around Polar's REST API. Raises HTTPException on
    non-2xx responses with the upstream error body so callers (and
    operators reading logs) can debug quickly."""
    if not POLAR_API_KEY:
        raise HTTPException(status_code=503, detail="POLAR_API_KEY not configured")
    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not ready")
    url = f"{POLAR_API_BASE.rstrip('/')}{path}"
    try:
        resp = await _http_client.request(
            method,
            url,
            json=json_body,
            headers={
                "Authorization": f"Bearer {POLAR_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=15.0,
        )
    except httpx.HTTPError as exc:
        print(f"[billing] polar request failed: {exc!r}", flush=True)
        raise HTTPException(status_code=502, detail=f"Polar API error: {exc}") from exc
    if resp.status_code >= 400:
        body = resp.text[:500]
        print(f"[billing] polar {method} {path} → {resp.status_code}: {body}", flush=True)
        raise HTTPException(status_code=resp.status_code, detail=f"Polar: {body}")
    if resp.status_code == 204 or not resp.content:
        return {}
    try:
        return resp.json()
    except Exception:
        return {"_raw": resp.text}


def _polar_secret_keys(secret: str) -> List[bytes]:
    """Return every plausible HMAC key for a Polar webhook secret.

    Standard Webhooks publishes secrets in the form `whsec_<base64>`
    where the bytes after base64-decoding are the HMAC key. Polar's
    dashboard has shipped multiple prefix variants over time:
    `whsec_`, `polar_whsec_`, `polar_whs_`, and occasionally a raw
    string with no prefix. Rather than guessing which one the
    operator pasted, we generate all candidates and let the caller
    try each — the extra HMACs are a few microseconds each and we
    only run this when verifying a webhook.
    """
    if not secret:
        return []
    keys: List[bytes] = []
    seen: set = set()

    def add(b: bytes) -> None:
        if b and b not in seen:
            seen.add(b)
            keys.append(b)

    def try_b64(s: str) -> None:
        pad = "=" * (-len(s) % 4)
        try:
            add(base64.b64decode(s + pad))
        except Exception:
            pass

    # The literal secret as UTF-8 — covers raw / unprefixed secrets
    # and acts as a final fallback for any prefixed variant.
    add(secret.encode("utf-8"))

    for prefix in ("whsec_", "polar_whsec_", "polar_whs_"):
        if secret.startswith(prefix):
            stripped = secret[len(prefix):]
            try_b64(stripped)
            add(stripped.encode("utf-8"))
            break

    # No-prefix path: also attempt a base64-decode of the whole secret
    # in case the operator stripped the prefix manually.
    try_b64(secret)

    return keys


def _verify_polar_signature(headers, body: bytes) -> bool:
    """Verify the Standard Webhooks signature on the request.

    Returns True iff the signature matches. When POLAR_WEBHOOK_SECRET
    is unset we accept all requests (development / self-hosted mode).

    Polar follows https://www.standardwebhooks.com/ — signature header
    contains one or more space-separated `v1,<base64-sha256>` entries
    over `<webhook-id>.<webhook-timestamp>.<body>`.
    """
    if not POLAR_WEBHOOK_SECRET:
        return True
    wh_id = headers.get("webhook-id") or headers.get("x-polar-webhook-id") or ""
    wh_ts = headers.get("webhook-timestamp") or headers.get("x-polar-webhook-timestamp") or ""
    wh_sig = headers.get("webhook-signature") or headers.get("x-polar-webhook-signature") or ""
    if not (wh_id and wh_ts and wh_sig):
        print(
            f"[billing] webhook missing headers: id={bool(wh_id)} ts={bool(wh_ts)} sig={bool(wh_sig)}",
            flush=True,
        )
        return False

    signed = f"{wh_id}.{wh_ts}.".encode("utf-8") + body

    provided: List[str] = []
    for part in wh_sig.split(" "):
        if "," in part:
            _ver, sig = part.split(",", 1)
        else:
            sig = part
        sig = sig.strip()
        if sig:
            provided.append(sig)

    candidates = _polar_secret_keys(POLAR_WEBHOOK_SECRET)
    for key in candidates:
        expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
        for sig in provided:
            if hmac.compare_digest(sig, expected):
                return True

    # Diagnostic — emit a non-secret fingerprint so operators can see
    # which secret form was tried without leaking the signature.
    expected_preview = ""
    if candidates:
        first = base64.b64encode(hmac.new(candidates[0], signed, hashlib.sha256).digest()).decode()
        expected_preview = first[:8]
    provided_preview = provided[0][:8] if provided else ""
    print(
        f"[billing] signature mismatch: provided={provided_preview}… expected={expected_preview}… "
        f"key_variants={len(candidates)} body_len={len(body)}",
        flush=True,
    )
    return False


def _tier_from_polar_product_id(product_id: str) -> Optional[str]:
    """Reverse-lookup: given a Polar product id from a subscription
    payload, return our internal tier key (basic / plus / max) or
    None when it doesn't match any configured tier."""
    if not product_id:
        return None
    for tier_key, cfg in TIER_CONFIGS.items():
        if cfg.get("polar_product_id") == product_id:
            return tier_key
    return None


async def _apply_subscription_event(payload: dict) -> Optional[str]:
    """Upsert `subscriptions` from a subscription.{created,updated,
    canceled,revoked} event. Returns the resolved fb_user_id (for
    logging), or None when the event couldn't be matched to a user."""
    if _db_pool is None:
        return None
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        return None

    polar_sub_id = str(data.get("id") or "")
    polar_customer_id = str(data.get("customer_id") or data.get("customer", {}).get("id") or "")
    customer_obj = data.get("customer") if isinstance(data.get("customer"), dict) else {}
    # We pass `customer_external_id = fb_user_id` when creating the
    # checkout, so it round-trips here on every subscription event.
    fb_user_id = str(
        customer_obj.get("external_id")
        or data.get("customer_external_id")
        or data.get("metadata", {}).get("fb_user_id")
        or ""
    ).strip()

    # Fall back to the polar_customer_id ↔ fb_user_id mapping captured
    # by the prior customer.created event (or a previous subscription
    # event). Without this fallback, a subscription.updated that
    # arrives after we've already learned the mapping would be dropped.
    if not fb_user_id and polar_customer_id:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT fb_user_id FROM subscriptions WHERE polar_customer_id = $1",
                polar_customer_id,
            )
        if row:
            fb_user_id = row["fb_user_id"]

    if not fb_user_id:
        print(
            f"[billing] subscription event for sub={polar_sub_id[:12]} "
            f"could not map to fb_user_id (customer={polar_customer_id[:12]})",
            flush=True,
        )
        return None

    # Determine tier from product_id. Subscriptions can have a top-
    # level product_id, or a nested `product` object with .id.
    product_id = str(
        data.get("product_id")
        or (data.get("product") or {}).get("id")
        or ""
    )
    tier = _tier_from_polar_product_id(product_id)
    if not tier:
        print(
            f"[billing] unknown polar product_id {product_id} on sub {polar_sub_id[:12]} — "
            f"keeping any existing tier",
            flush=True,
        )

    # Map Polar's status to our internal status. Polar uses 'trialing'
    # while a trial is active; 'active' once charging begins;
    # 'past_due' on payment failures; 'canceled' / 'revoked' when the
    # subscription is no longer billable.
    polar_status = str(data.get("status") or "").lower()
    status_map = {
        "trialing": "trialing",
        "active": "active",
        "past_due": "past_due",
        "incomplete": "past_due",
        "canceled": "canceled",
        "cancelled": "canceled",
        "revoked": "canceled",
        "ended": "canceled",
    }
    status = status_map.get(polar_status, polar_status or "inactive")

    # Period boundaries for the trial / next-renewal display on /billing.
    def _parse_dt(v) -> Optional[datetime]:
        if not v:
            return None
        if isinstance(v, datetime):
            return v
        try:
            # Polar uses RFC3339 — datetime.fromisoformat handles the Z
            # suffix on Python 3.11+; replace defensively for older PG.
            return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        except Exception:
            return None

    trial_ends_at = _parse_dt(data.get("trial_ends_at") or data.get("trial_end"))
    current_period_end = _parse_dt(data.get("current_period_end"))
    cancel_at_period_end = bool(data.get("cancel_at_period_end") or False)

    cfg = TIER_CONFIGS.get(tier or "free", TIER_CONFIGS["free"])
    # `-1` (unlimited) becomes a sentinel int for the SQL column;
    # the JSON-facing /api/billing/me normalises this to a "is unlimited"
    # signal for the frontend.
    def _limit(v: int) -> int:
        return 999999 if v == -1 else int(v)

    async with _db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO subscriptions
              (fb_user_id, polar_customer_id, polar_subscription_id,
               tier, status, trial_ends_at, current_period_end,
               cancel_at_period_end,
               ad_accounts_limit, line_channels_limit,
               line_groups_limit, monthly_push_limit,
               agent_advice_limit,
               updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
            ON CONFLICT (fb_user_id) DO UPDATE SET
              polar_customer_id = COALESCE(EXCLUDED.polar_customer_id, subscriptions.polar_customer_id),
              polar_subscription_id = COALESCE(EXCLUDED.polar_subscription_id, subscriptions.polar_subscription_id),
              tier = EXCLUDED.tier,
              status = EXCLUDED.status,
              trial_ends_at = EXCLUDED.trial_ends_at,
              current_period_end = EXCLUDED.current_period_end,
              cancel_at_period_end = EXCLUDED.cancel_at_period_end,
              ad_accounts_limit = EXCLUDED.ad_accounts_limit,
              line_channels_limit = EXCLUDED.line_channels_limit,
              line_groups_limit = EXCLUDED.line_groups_limit,
              monthly_push_limit = EXCLUDED.monthly_push_limit,
              agent_advice_limit = EXCLUDED.agent_advice_limit,
              updated_at = NOW()
            """,
            fb_user_id,
            polar_customer_id or None,
            polar_sub_id or None,
            tier or "free",
            status,
            trial_ends_at,
            current_period_end,
            cancel_at_period_end,
            _limit(cfg["ad_accounts_limit"]),
            _limit(cfg["line_channels_limit"]),
            _limit(cfg["line_groups_limit"]),
            None if cfg["monthly_push_limit"] == -1 else int(cfg["monthly_push_limit"]),
            None if cfg["agent_advice_limit"] == -1 else int(cfg["agent_advice_limit"]),
        )
    return fb_user_id


async def _apply_customer_event(payload: dict) -> Optional[str]:
    """Capture polar_customer_id ↔ fb_user_id mapping on customer.created."""
    if _db_pool is None:
        return None
    data = payload.get("data") or {}
    if not isinstance(data, dict):
        return None
    polar_customer_id = str(data.get("id") or "")
    fb_user_id = str(data.get("external_id") or data.get("metadata", {}).get("fb_user_id") or "").strip()
    if not (polar_customer_id and fb_user_id):
        return None
    # Seed a free-tier row with the polar_customer_id captured. When
    # the subsequent subscription.created event arrives we'll upgrade
    # the tier in-place.
    async with _db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO subscriptions
              (fb_user_id, polar_customer_id, tier, status,
               ad_accounts_limit, line_channels_limit,
               line_groups_limit, monthly_push_limit,
               agent_advice_limit)
            VALUES ($1, $2, 'free', 'free', 1, 0, 0, 0, 40)
            ON CONFLICT (fb_user_id) DO UPDATE SET
              polar_customer_id = COALESCE(subscriptions.polar_customer_id, EXCLUDED.polar_customer_id),
              updated_at = NOW()
            """,
            fb_user_id,
            polar_customer_id,
        )
    return fb_user_id


@app.post("/api/billing/webhook")
async def polar_webhook(request: Request):
    """Receive a Polar webhook event.

    Flow:
      1. Verify the Standard Webhooks HMAC signature (skipped when
         POLAR_WEBHOOK_SECRET is unset, to keep dev simple).
      2. Persist the raw payload to `billing_events` (idempotent on
         polar_event_id) so we always have replayable history.
      3. Dispatch on `type` to upsert `subscriptions`.

    We always ACK 200 unless signature verification fails — Polar's
    retry loop should not be triggered by transient DB hiccups
    (operators see them in stdout instead).
    """
    raw = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}

    if not _verify_polar_signature(headers, raw):
        print("[billing] webhook signature verify FAILED", flush=True)
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    try:
        payload = _json.loads(raw or b"{}")
    except Exception:
        payload = {
            "_parse_error": True,
            "_raw_preview": raw.decode("utf-8", errors="replace")[:2000],
        }

    event_id = ""
    event_type = "unknown"
    if isinstance(payload, dict):
        event_id = str(payload.get("id") or headers.get("webhook-id") or "")
        event_type = str(payload.get("type") or "unknown")

    print(f"[billing] webhook: {event_type} {event_id[:16]}", flush=True)

    resolved_user: Optional[str] = None
    handler_error: Optional[str] = None
    try:
        if event_type == "customer.created":
            resolved_user = await _apply_customer_event(payload)
        elif event_type in (
            "subscription.created",
            "subscription.updated",
            "subscription.active",
            "subscription.canceled",
            "subscription.revoked",
        ):
            resolved_user = await _apply_subscription_event(payload)
    except Exception as exc:
        handler_error = str(exc)
        print(f"[billing] event handler error: {exc!r}", flush=True)

    if _db_pool is None:
        return {"ok": True, "stored": False}

    if not event_id:
        event_id = f"unsigned-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%f')}"

    try:
        async with _db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO billing_events
                  (polar_event_id, event_type, fb_user_id, payload, processed_at, error)
                VALUES ($1, $2, $3, $4::jsonb, NOW(), $5)
                ON CONFLICT (polar_event_id) DO NOTHING
                """,
                event_id,
                event_type,
                resolved_user,
                _json.dumps(payload),
                handler_error,
            )
        return {"ok": True, "stored": True, "matched_user": bool(resolved_user)}
    except Exception as exc:
        print(f"[billing] webhook persist failed: {exc}", flush=True)
        return {"ok": True, "stored": False, "error": str(exc)}


# ── Checkout / Portal ─────────────────────────────────────────────

class CheckoutPayload(BaseModel):
    tier: str  # 'basic' | 'plus' | 'max'
    fb_user_id: str
    email: Optional[str] = None


@app.post("/api/billing/checkout")
async def create_checkout(payload: CheckoutPayload):
    """Create a Polar checkout session and return its hosted URL.

    The frontend redirects the user to this URL; after they finish
    paying Polar redirects them back to our `success_url`. The
    fb_user_id is threaded through `customer_external_id` so the
    subsequent webhook events can map back to our user record.
    """
    cfg = TIER_CONFIGS.get(payload.tier)
    if not cfg or not cfg.get("polar_product_id"):
        raise HTTPException(status_code=400, detail=f"Unknown or unconfigured tier: {payload.tier}")

    site = (os.getenv("PUBLIC_SITE_URL") or "").rstrip("/")
    if not site:
        # Use the request scheme/host as a last resort. Manual setting
        # is preferred (PUBLIC_SITE_URL=https://luredash.lure.com.tw).
        site = DEFAULT_PUBLIC_SITE_URL

    body = {
        "products": [cfg["polar_product_id"]],
        "success_url": f"{site}/billing?success=true&checkout_id={{CHECKOUT_ID}}",
        "customer_external_id": payload.fb_user_id,
        "metadata": {"fb_user_id": payload.fb_user_id, "tier": payload.tier},
    }
    if payload.email:
        body["customer_email"] = payload.email

    resp = await _polar_request("POST", "/checkouts/", json_body=body)
    url = resp.get("url") or resp.get("checkout_url") or ""
    if not url:
        print(f"[billing] checkout response missing URL: {resp}", flush=True)
        raise HTTPException(status_code=502, detail="Polar did not return a checkout URL")
    return {"url": url, "checkout_id": resp.get("id")}


class PortalPayload(BaseModel):
    fb_user_id: str


@app.post("/api/billing/portal")
async def create_portal_session(payload: PortalPayload):
    """Generate a one-time Polar customer-portal URL the user can
    visit to change their plan, update card, or cancel."""
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="Database not configured")
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT polar_customer_id FROM subscriptions WHERE fb_user_id = $1",
            payload.fb_user_id,
        )
    polar_customer_id = (row or {}).get("polar_customer_id") if row else None
    if not polar_customer_id:
        raise HTTPException(status_code=404, detail="No subscription found for user")

    resp = await _polar_request(
        "POST",
        "/customer-sessions/",
        json_body={"customer_id": polar_customer_id},
    )
    url = resp.get("customer_portal_url") or resp.get("url") or ""
    if not url:
        print(f"[billing] portal response missing URL: {resp}", flush=True)
        raise HTTPException(status_code=502, detail="Polar did not return a portal URL")
    return {"url": url}


# ── Asset proxy ───────────────────────────────────────────────────────
#
# FB / IG creative URLs (scontent-*.fbcdn.net, *.cdninstagram.com) are
# served without permissive CORS, so the browser can't fetch them as
# blobs to feed into navigator.share() or a same-origin <a download>.
# Streaming the bytes through our own origin sidesteps that:
#   - The frontend fetch becomes same-origin → blob() works → File()
#     works → iOS Safari's Web Share API can offer "儲存影片 / 儲存
#     到相簿".
#   - The Content-Disposition: attachment header makes plain-navigation
#     to the proxy URL trigger a download instead of the iOS native
#     fullscreen video player (the failure mode users were hitting
#     when our fetch fallback opened the FB URL in a new tab).
#
# Allow-list is hostname-suffix based — any subdomain of the listed
# CDNs works (FB rotates `scontent-tpe1-1.fbcdn.net`, `video-tpe1-2…`
# etc. per region). Anything else 400s so the endpoint can't be
# turned into an open proxy.

_PROXY_ALLOWED_HOST_SUFFIXES = (
    ".fbcdn.net",
    ".cdninstagram.com",
    ".facebook.com",
    ".fb.com",
    ".instagram.com",
)


@app.get("/api/proxy-asset")
async def proxy_asset(
    url: str = Query(..., description="FB/IG CDN URL to proxy"),
    filename: Optional[str] = Query(None, description="Suggested download filename"),
):
    """Stream a remote FB/IG creative through our origin so the
    browser can save it as a file. Returns the raw bytes with
    Content-Disposition: attachment set."""
    from urllib.parse import quote, urlparse

    try:
        parsed = urlparse(url)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Unsupported scheme")
    host = (parsed.hostname or "").lower()
    if not any(host == s.lstrip(".") or host.endswith(s) for s in _PROXY_ALLOWED_HOST_SUFFIXES):
        raise HTTPException(status_code=400, detail="Host not allowed")

    safe_name = re.sub(r'[\\/:*?"<>|\n\r\t]', "_", (filename or "creative"))[:120].strip() or "creative"

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            upstream = await client.get(url, follow_redirects=True)
    except Exception as exc:
        print(f"[proxy] fetch failed for {host}: {exc!r}", flush=True)
        raise HTTPException(status_code=502, detail="Upstream fetch failed")

    if upstream.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Upstream {upstream.status_code}")

    # HTTP headers are latin-1 only — non-ASCII chars (e.g. Chinese
    # creative names) would 500 the response with UnicodeEncodeError
    # when ASGI tries to encode the header. Use RFC 6266's split
    # form: a stripped-down ASCII filename for legacy clients plus
    # filename*=UTF-8''<percent-encoded> for modern browsers (which
    # is what iOS Safari and Chrome both honour).
    ascii_name = re.sub(r"[^\x20-\x7e]", "_", safe_name).strip("._ ") or "creative"
    encoded_name = quote(safe_name, safe="")
    disposition = f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"

    return Response(
        content=upstream.content,
        media_type=upstream.headers.get("content-type", "application/octet-stream"),
        headers={
            "Content-Disposition": disposition,
            "Cache-Control": "no-store",
        },
    )


# ── 廣告帳戶 ─────────────────────────────────────────────────────────

@app.get("/api/accounts")
async def get_accounts():
    # The `campaigns.limit(0).summary(true)` subfield was removed: FB
    # computes that summary per-account which was the main trigger for
    # 80004 (per-ad-account throttling) under cold-load bursts. The
    # frontend doesn't actually use `campaign_count`.
    accounts = await fb_get_paginated(
        "me/adaccounts",
        {
            # Nested `business{id,name}` — without explicit sub-fields,
            # FB returns just `{id}` for the business object, so the
            # engineering panel was stuck showing every BM as "未知".
            "fields": "id,name,account_status,currency,timezone_name,business{id,name}",
            "limit": "500",
        },
        ttl=_ACCOUNTS_CACHE_TTL_SECONDS,
    )
    return {"data": accounts}


@app.get("/api/fb-usage")
async def get_fb_usage():
    """Latest parsed `X-Business-Use-Case-Usage` snapshot.

    Populated as a side-effect of every FB call. Entries age out after
    BUCU_USAGE_STALE_SECONDS so self-throttle can clear even when we
    intentionally stop making FB calls.
    """
    _fresh_bucu_entries()
    live_gate_reason = _live_bucu_gate_reason()
    return {
        "data": _fb_usage,
        "peak_regain_minutes": _peak_regain_minutes(),
        "peak_bucu_pct": _peak_bucu_pct(),
        "app_usage": dict(_app_usage),
        "peak_app_usage_pct": _peak_app_usage_pct(),
        "live_gate_reason": live_gate_reason,
        "live_gate_retry_after_seconds": _live_bucu_gate_wait_seconds()
        if live_gate_reason
        else 0,
    }


@app.get("/api/engineering/fb-calls")
async def get_engineering_fb_calls():
    """Recent FB Graph API call activity for the 工程模式 panel.

    Returns:
      - `recent`: last 200 call log entries (newest last)
      - `top_paths_5m`: paths sorted by call count in last 5 min
      - `top_accounts_5m`: account ids sorted by call count in last 5 min
      - `top_sources_5m`: source tags sorted by live/gated call volume
      - `status_counts_5m`: HTTP status distribution in last 5 min
      - `throttle_events`: DURABLE full throttle log (newest-first, up to
        200) from `fb_throttle_events` — account (80000-80014) + global
        (4/17/32/613) hits, each with scope/source/fb_user_id/bucu.
        Falls back to in-memory ring buffers if DB is unavailable.
      - `throttle_total`: total rows in the durable throttle log
      - Every table (`recent`, `top_*`, `throttle_events`) carries the
        triggering fb_user_id + resolved fb_user_name / top_user_name
      - `cache_hit_rate_5m`: fraction of calls served from cache (0-1)
      - `account_throttle_until`: per-account cooldown deadlines (epoch seconds)
      - `global_throttle_until`: process-wide cooldown deadline, if active
      - `error_count_5m`: count of non-200 responses in last 5 min
      - `live_total_5m`: non-cache, non-gated calls that actually hit FB
      - `blocked_total_5m`: fail-fast calls blocked by our cooldown gates
      - `total_5m`: total calls (cache + live) in last 5 min

    All read-only; doesn't itself hit FB."""
    now_wall = time.time()
    now_mono = time.monotonic()
    window = 300.0  # 5 min
    cutoff_ts = now_wall - window

    # Snapshot the deque before iterating — append-only / fixed maxlen,
    # but reading + iterating in parallel could still race in Python's
    # threaded event loop (we're single-threaded async but still).
    snapshot = list(_fb_call_log)

    recent_window = [e for e in snapshot if e["ts"] >= cutoff_ts]
    path_counts: "Counter[str]" = Counter()
    account_counts: "Counter[str]" = Counter()
    status_counts: "Counter[str]" = Counter()
    source_stats: dict[str, dict] = {}
    path_stats: dict[str, dict] = {}
    # account_id → Counter of fb_user_ids, so 帳戶表格 can show WHO drove
    # the calls to that account in the last 5 min.
    account_users: dict[str, "Counter[str]"] = {}
    cache_hits = 0
    error_count = 0
    live_total = 0
    blocked_total = 0
    retried_total = 0
    for e in recent_window:
        path = str(e.get("path") or "")
        source = str(e.get("source") or "unknown")
        status = int(e.get("status") or 0)
        ms = int(e.get("ms") or 0)
        cache_hit = bool(e.get("cache_hit"))
        uid = str(e.get("fb_user_id") or "")
        is_error = status >= 400
        is_blocked = status == 429 and ms == 0
        is_live = not cache_hit and not is_blocked

        path_counts[path] += 1
        if e.get("account_id"):
            aid_key = str(e["account_id"])
            account_counts[aid_key] += 1
            if uid:
                account_users.setdefault(aid_key, Counter())[uid] += 1
        status_counts[str(status)] += 1
        if cache_hit:
            cache_hits += 1
        if is_error:
            error_count += 1
        if is_live:
            live_total += 1
        if is_blocked:
            blocked_total += 1
        if e.get("retried"):
            retried_total += 1

        ss = source_stats.setdefault(
            source,
            {
                "source": source,
                "count": 0,
                "live": 0,
                "cache_hits": 0,
                "blocked": 0,
                "errors": 0,
                "retried": 0,
                "ms_total": 0,
                "last_ts": 0.0,
                "last_status": 0,
                "last_path": "",
                "users": Counter(),
            },
        )
        ss["count"] += 1
        ss["live"] += 1 if is_live else 0
        ss["cache_hits"] += 1 if cache_hit else 0
        ss["blocked"] += 1 if is_blocked else 0
        ss["errors"] += 1 if is_error else 0
        ss["retried"] += 1 if e.get("retried") else 0
        ss["ms_total"] += ms
        if uid:
            ss["users"][uid] += 1
        if float(e.get("ts") or 0) >= float(ss["last_ts"] or 0):
            ss["last_ts"] = float(e.get("ts") or 0)
            ss["last_status"] = status
            ss["last_path"] = path

        ps = path_stats.setdefault(
            path,
            {
                "path": path,
                "count": 0,
                "live": 0,
                "cache_hits": 0,
                "blocked": 0,
                "errors": 0,
                "sources": Counter(),
                "users": Counter(),
            },
        )
        ps["count"] += 1
        ps["live"] += 1 if is_live else 0
        ps["cache_hits"] += 1 if cache_hit else 0
        ps["blocked"] += 1 if is_blocked else 0
        ps["errors"] += 1 if is_error else 0
        ps["sources"][source] += 1
        if uid:
            ps["users"][uid] += 1
    total = len(recent_window)
    cache_hit_rate = (cache_hits / total) if total else 0.0

    # Throttle log — prefer the DURABLE DB table (full history, survives
    # restarts) so「保留限流事件，完整的、不只 5 分鐘」holds. Fall back to
    # the in-memory ring buffers if DB is unavailable.
    throttle_events: list[dict] = []
    throttle_total = 0
    if _db_pool is not None:
        try:
            async with _db_pool.acquire() as conn:
                rows = await conn.fetch(
                    """
                    SELECT scope, account_id, path, error_code, source,
                           fb_user_id, bucu_pct,
                           EXTRACT(EPOCH FROM ts) AS ts_epoch
                    FROM fb_throttle_events
                    ORDER BY ts DESC
                    LIMIT 200
                    """
                )
                throttle_total = await conn.fetchval(
                    "SELECT COUNT(*) FROM fb_throttle_events"
                )
            for r in rows:
                throttle_events.append(
                    {
                        "ts": float(r["ts_epoch"] or 0),
                        "scope": r["scope"] or "account",
                        "account_id": r["account_id"] or "",
                        "path": r["path"] or "",
                        "code": r["error_code"],
                        "source": r["source"] or "",
                        "fb_user_id": r["fb_user_id"] or "",
                        "bucu_pct": r["bucu_pct"],
                    }
                )
        except Exception:
            throttle_events = []
    if not throttle_events:
        # In-memory fallback (DB down / not yet migrated).
        for aid, events in _account_throttle_events.items():
            for ev in events:
                throttle_events.append(
                    {
                        "ts": ev["ts"],
                        "scope": "account",
                        "account_id": aid,
                        "path": ev.get("path") or "",
                        "code": ev.get("code"),
                        "source": ev.get("source") or "",
                        "fb_user_id": ev.get("fb_user_id") or "",
                        "bucu_pct": ev.get("bucu"),
                    }
                )
        for ev in _global_throttle_events:
            throttle_events.append(
                {
                    "ts": ev["ts"],
                    "scope": "global",
                    "account_id": "",
                    "path": ev.get("path") or "",
                    "code": ev.get("code"),
                    "source": ev.get("source") or "",
                    "fb_user_id": ev.get("fb_user_id") or "",
                    "bucu_pct": ev.get("bucu"),
                }
            )
        throttle_events.sort(key=lambda x: x["ts"], reverse=True)
        throttle_total = len(throttle_events)
        throttle_events = throttle_events[:200]

    # Snapshot per-account cooldowns + convert monotonic → wall clock
    # so the frontend can render a real countdown. Drop expired entries
    # while we're at it.
    cooldowns: dict[str, float] = {}
    for aid, deadline_mono in list(_account_throttle_until.items()):
        remaining = deadline_mono - now_mono
        if remaining <= 0:
            _account_throttle_until.pop(aid, None)
            continue
        cooldowns[aid] = now_wall + remaining

    global_remaining = _global_throttle_remaining()

    # Recent slice trimmed to last 200 (the full deque is 500; we send
    # less to keep the panel payload small).
    recent_slice = snapshot[-200:]

    def _top_uid(counter: "Counter[str]") -> str:
        return counter.most_common(1)[0][0] if counter else ""

    top_paths = [
        {
            "path": p,
            "count": c,
            "live": int(path_stats[p]["live"]),
            "cache_hits": int(path_stats[p]["cache_hits"]),
            "blocked": int(path_stats[p]["blocked"]),
            "errors": int(path_stats[p]["errors"]),
            "top_source": path_stats[p]["sources"].most_common(1)[0][0]
            if path_stats[p]["sources"]
            else "unknown",
            "top_user_id": _top_uid(path_stats[p]["users"]),
        }
        for p, c in path_counts.most_common(15)
    ]
    top_accounts = [
        {"account_id": a, "count": c, "top_user_id": _top_uid(account_users.get(a, Counter()))}
        for a, c in account_counts.most_common(15)
    ]
    top_sources = [
        {
            "source": s["source"],
            "count": int(s["count"]),
            "live": int(s["live"]),
            "cache_hits": int(s["cache_hits"]),
            "blocked": int(s["blocked"]),
            "errors": int(s["errors"]),
            "retried": int(s["retried"]),
            "avg_ms": round(float(s["ms_total"]) / max(1, int(s["count"]))),
            "last_status": int(s["last_status"]),
            "last_path": s["last_path"],
            "top_user_id": _top_uid(s["users"]),
        }
        for s in sorted(
            source_stats.values(),
            key=lambda x: (int(x["live"]) + int(x["blocked"]), int(x["errors"]), int(x["count"])),
            reverse=True,
        )[:15]
    ]

    # Batch-resolve every fb_user_id that appears anywhere in the payload
    # to a display name, so ALL tables can show WHO. One query total.
    uid_set: "set[str]" = set()
    for e in recent_slice:
        if e.get("fb_user_id"):
            uid_set.add(str(e["fb_user_id"]))
    for ev in throttle_events:
        if ev.get("fb_user_id"):
            uid_set.add(str(ev["fb_user_id"]))
    for row in (*top_paths, *top_accounts, *top_sources):
        if row.get("top_user_id"):
            uid_set.add(str(row["top_user_id"]))
    name_map = await _fb_user_display_names(uid_set)

    def _name(uid: object) -> str:
        u = str(uid or "")
        return name_map.get(u, "") if u else ""

    # Attach resolved names in place (recent is a raw dict list → copy so
    # we don't mutate the ring buffer's shared dicts).
    recent_out = [{**e, "fb_user_name": _name(e.get("fb_user_id"))} for e in recent_slice]
    for ev in throttle_events:
        ev["fb_user_name"] = _name(ev.get("fb_user_id"))
    for row in (*top_paths, *top_accounts, *top_sources):
        row["top_user_name"] = _name(row.get("top_user_id"))

    return {
        "recent": recent_out,
        "top_paths_5m": top_paths,
        "top_accounts_5m": top_accounts,
        "top_sources_5m": top_sources,
        "status_counts_5m": [
            {"status": status, "count": count} for status, count in status_counts.most_common()
        ],
        "throttle_events": throttle_events,
        "throttle_total": int(throttle_total or 0),
        "global_throttle_events": list(_global_throttle_events),
        "cache_hit_rate_5m": round(cache_hit_rate, 3),
        "account_throttle_until": cooldowns,
        "global_throttle_until": (now_wall + global_remaining) if global_remaining > 0 else None,
        "live_bucu_gate_reason": _live_bucu_gate_reason(),
        "live_bucu_gate_retry_after_seconds": _live_bucu_gate_wait_seconds()
        if _live_bucu_gate_reason()
        else 0,
        "error_count_5m": error_count,
        "live_total_5m": live_total,
        "blocked_total_5m": blocked_total,
        "retried_total_5m": retried_total,
        "total_5m": total,
    }


# ── 行銷活動 ─────────────────────────────────────────────────────────

# Metadata cache TTL — campaign list / names / budgets don't change as
# fast as insights numbers, so we cache the metadata layer 15 min while
# the insights layer stays at the default 5 min. This means switching
# date pickers shares the metadata across cache entries instead of
# re-fetching the (expensive, adset-nested) /campaigns response.
_CAMPAIGNS_META_TTL_SECONDS = 15 * 60


async def _fetch_campaigns_metadata(
    account_id: str,
    include_archived: bool,
    include_adsets: bool,
) -> List[dict]:
    """Fetch campaign metadata (no insights).

    Long-TTL cached layer of the campaigns fetch. Returns campaign list
    with stable fields (id/name/status/objective/budgets/created_time/
    updated_time) and optionally the `adsets.limit(50){...}` nesting
    needed by 安全監控's effectiveDailyBudget.

    Splitting metadata from insights:
      1. Cache hit rate goes up (date changes don't invalidate metadata)
      2. FB-side cost per call goes way down (no per-campaign insights
         aggregation, no n×insight-field compute)
      3. Heavy accounts (e.g. 吸引力 LURE — 100+ campaigns) drop from
         ~5-15 BUCU per /campaigns to ~1-2 BUCU
    """
    # Two orthogonal toggles: adsets nesting (expensive payload) and
    # the `effective_status` archived filter. Either one is enough for
    # FB to reject the whole call with fb=100 on certain accounts /
    # burst scenarios. We start with the caller's full request and
    # progressively drop pieces until something succeeds — same
    # philosophy as the old 5-tier insights chain, just for the
    # metadata layer now.
    base_no_adsets = (
        "id,name,status,objective,daily_budget,lifetime_budget,"
        "created_time,updated_time"
    )
    adset_nest = "adsets.limit(50){daily_budget,lifetime_budget,status}"
    full_fields = base_no_adsets + (f",{adset_nest}" if include_adsets else "")
    archived_filter = {"effective_status": '["ACTIVE","PAUSED","ARCHIVED","DELETED"]'}
    archived_filter_blocked = _campaigns_capability_blocked(account_id, "archived_filter")
    adsets_nesting_blocked = _campaigns_capability_blocked(account_id, "adsets_nesting")

    attempts: list[tuple[str, dict]] = []
    if include_archived and include_adsets and not archived_filter_blocked and not adsets_nesting_blocked:
        attempts.append(
            ("full+archived", {"fields": full_fields, "limit": "500", **archived_filter})
        )
    if include_archived and not archived_filter_blocked:
        attempts.append(
            (
                "no-adsets+archived",
                {"fields": base_no_adsets, "limit": "500", **archived_filter},
            )
        )
    if include_adsets and not adsets_nesting_blocked:
        attempts.append(("full", {"fields": full_fields, "limit": "500"}))
    attempts.append(("no-adsets", {"fields": base_no_adsets, "limit": "500"}))
    # Last-ditch: just id/name/status. Sufficient for the dashboard
    # tree to render (zero budget / metric data) and for security view
    # to at least show the campaign existed, instead of nothing.
    attempts.append(("minimal", {"fields": "id,name,status", "limit": "500"}))

    last_error: Optional[HTTPException] = None
    for tier, params in attempts:
        if "archived" in tier and _campaigns_capability_blocked(account_id, "archived_filter"):
            continue
        if tier in {"full+archived", "full"} and _campaigns_capability_blocked(account_id, "adsets_nesting"):
            continue
        try:
            camps = await fb_get_paginated(
                f"{account_id}/campaigns", params, ttl=_CAMPAIGNS_META_TTL_SECONDS
            )
            if last_error is not None:
                print(
                    f"[campaigns meta] {account_id} recovered at tier={tier} "
                    f"after earlier failure: {last_error.detail}",
                    flush=True,
                )
            return camps
        except HTTPException as e:
            print(
                f"[campaigns meta] {account_id} tier={tier} failed: "
                f"{e.status_code} {e.detail}",
                flush=True,
            )
            last_error = e
            if _is_rate_limit_exception(e):
                raise
            if _fb_detail_has_code(e.detail, 100):
                if "archived" in tier:
                    _remember_campaigns_unsupported(account_id, "archived_filter", e.detail)
                if tier == "full":
                    _remember_campaigns_unsupported(account_id, "adsets_nesting", e.detail)
            continue
    if last_error is not None:
        raise last_error
    raise HTTPException(status_code=502, detail="Failed to load campaign metadata")


async def _fetch_campaign_insights_bulk(
    account_id: str,
    date_preset: str,
    time_range: Optional[str],
) -> dict[str, dict]:
    """Fetch per-campaign aggregated insights for one account in ONE FB
    call via `act_xxx/insights?level=campaign`.

    Returns `{campaign_id: insights_row}`. Caller stitches the rows
    onto the metadata response under `c["insights"]["data"][0]` to
    preserve the shape the frontend expects (`getIns(c)`).

    The account-level insights endpoint with `level=campaign` is FB's
    own optimized path for this aggregation pattern — much cheaper
    than the nested expansion inside the `/campaigns` edge, which
    forces FB to iterate each campaign separately.

    Errors are NON-fatal: if FB rejects the bulk call (e.g. specific
    field unsupported on this account), we log and return an empty
    map. The caller will still surface campaigns, just without metric
    numbers — better than failing the whole overview.
    """
    # Field sets ordered from richest to leanest. Certain accounts /
    # objectives reject specific fields (purchase_roas on lead-gen
    # accounts, action-cost on accounts with no conversion events
    # defined). We progressively drop optional fields until something
    # succeeds — matches the metadata fallback's "try less, ship
    # something" philosophy.
    full_fields = (
        "campaign_id,spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,"
        "inline_link_clicks,cost_per_inline_link_click,"
        "cost_per_action_type,purchase_roas,website_purchase_roas"
    )
    mid_fields = (
        "campaign_id,spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,"
        "inline_link_clicks"
    )
    min_fields = "campaign_id,spend,impressions,clicks,ctr,cpc,cpm,actions"

    base_params: dict = {"level": "campaign", "limit": "500"}
    if time_range:
        base_params["time_range"] = time_range
    else:
        base_params["date_preset"] = date_preset

    rows: list = []
    last_err: Optional[HTTPException] = None
    for tier, fields in (("full", full_fields), ("mid", mid_fields), ("min", min_fields)):
        try:
            rows = await fb_get_paginated(
                f"{account_id}/insights", {**base_params, "fields": fields}
            )
            if last_err is not None:
                print(
                    f"[campaigns insights] {account_id} recovered at tier={tier} "
                    f"after earlier failure: {last_err.detail}",
                    flush=True,
                )
            break
        except HTTPException as e:
            print(
                f"[campaigns insights] {account_id} tier={tier} failed: "
                f"{e.status_code} {e.detail}",
                flush=True,
            )
            last_err = e
            if _is_rate_limit_exception(e):
                raise
            continue
    else:
        # All tiers failed — non-fatal, return empty so the caller
        # still surfaces campaign metadata without metric numbers.
        return {}

    out: dict[str, dict] = {}
    for r in rows:
        cid = r.get("campaign_id")
        if cid:
            # Drop campaign_id from the row before nesting — frontend
            # already keys by the parent campaign.id.
            row_copy = {k: v for k, v in r.items() if k != "campaign_id"}
            out[cid] = row_copy
    return out


async def _fetch_single_entity_insights(
    entity_id: str,
    date_preset: str,
    time_range: Optional[str],
) -> dict:
    """Fetch ONE entity's aggregated insights via its `/insights` edge
    (`GET /{entity_id}/insights`). Works at ANY level — campaign, adset,
    or ad — because the `/insights` edge is level-agnostic (it aggregates
    for whatever object the id points at). Returns the insights row dict,
    or {} when the entity had no delivery in the window.

    Why the edge and NOT field-expansion (`GET /{id}?fields=insights...`):
    the LINE push used field-expansion, but expanded insights on an entity
    NODE can come back EMPTY for some entities (awareness objectives /
    certain delivery structures) even when they clearly spent — while the
    /insights edge returns the real numbers for the SAME entity + window
    (this is what the dashboard reads at campaign level via
    `act_xxx/insights?level=campaign`). Reading the edge at every level
    keeps the push in lock-step with the dashboard. Tiered fields mirror
    _fetch_campaign_insights_bulk (drop optional fields some accounts
    reject; e.g. an ad without frequency support falls to a leaner tier)."""
    full_fields = (
        "spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,"
        "inline_link_clicks,cost_per_inline_link_click,"
        "cost_per_action_type,purchase_roas,website_purchase_roas"
    )
    mid_fields = (
        "spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,inline_link_clicks"
    )
    min_fields = "spend,impressions,clicks,ctr,cpc,cpm,actions"

    params: dict = {}
    if time_range:
        params["time_range"] = time_range
    else:
        params["date_preset"] = date_preset

    for fields in (full_fields, mid_fields, min_fields):
        try:
            resp = await fb_get(f"{entity_id}/insights", {**params, "fields": fields})
            data = resp.get("data") if isinstance(resp, dict) else None
            return data[0] if isinstance(data, list) and data else {}
        except HTTPException as e:
            if _is_rate_limit_exception(e):
                raise
            continue
    return {}


async def _fetch_child_insights_bulk(
    parent_id: str,
    level: str,
    date_preset: str,
    time_range: Optional[str],
) -> dict[str, dict]:
    """Fetch aggregated insights for ALL children of one parent in a
    single FB call via `{parent_id}/insights?level={adset|ad}` — the
    same canonical bulk pattern as `_fetch_campaign_insights_bulk`
    (which does level=campaign on the account node), one level down.

    Returns `{child_id: insights_row}` keyed by adset_id / ad_id.
    Callers stitch the rows onto metadata under
    `c["insights"]["data"][0]` — the shape `getIns(c)` expects.

    This replaces nested field-expansion (`{parent}/adsets?fields=
    ...insights.date_preset(X){...}`), which shares the node-expansion
    failure mode: FB returns EMPTY nested insights for some entities
    (awareness objectives / certain delivery structures) even when
    they spent. Errors are NON-fatal (empty map) except rate limits,
    mirroring the account-level bulk helper."""
    id_field = "adset_id" if level == "adset" else "ad_id"
    # Ad level carries the video metrics the 成效報告 creative cards
    # need (平均播放時間 / 完整觀看率 / ThruPlay 率); non-video ads
    # simply return empty arrays for them.
    video_fields = (
        ",video_avg_time_watched_actions,video_p100_watched_actions,"
        "video_thruplay_watched_actions,video_play_actions"
        if level == "ad"
        else ""
    )
    full_fields = (
        f"{id_field},spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,"
        "inline_link_clicks,cost_per_inline_link_click,"
        f"cost_per_action_type,purchase_roas,website_purchase_roas{video_fields}"
    )
    mid_fields = (
        f"{id_field},spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,"
        f"inline_link_clicks{video_fields}"
    )
    min_fields = f"{id_field},spend,impressions,clicks,ctr,cpc,cpm,actions"

    base_params: dict = {"level": level, "limit": "500"}
    if time_range:
        base_params["time_range"] = time_range
    else:
        base_params["date_preset"] = date_preset

    rows: list = []
    for fields in (full_fields, mid_fields, min_fields):
        try:
            rows = await fb_get_paginated(
                f"{parent_id}/insights", {**base_params, "fields": fields}
            )
            break
        except HTTPException as e:
            if _is_rate_limit_exception(e):
                raise
            continue
    else:
        return {}

    out: dict[str, dict] = {}
    for r in rows:
        cid = r.get(id_field)
        if cid:
            out[cid] = {k: v for k, v in r.items() if k != id_field}
    return out


async def _fetch_campaigns_for_account(
    account_id: str,
    date_preset: str,
    time_range: Optional[str],
    include_archived: bool,
    lite: bool = False,
    include_adsets: bool = True,
) -> List[dict]:
    """Fetch campaigns with insights for one account.

    Internally splits into two cheaper FB calls:
      1. Metadata (long TTL, no date dependency)
      2. Bulk insights via `/insights?level=campaign` (date-keyed, but
         a single FB call per account instead of per-campaign
         expansion)

    Then stitches the insights rows into each metadata campaign under
    `c["insights"]["data"][0]` — the shape the frontend's `getIns(c)`
    expects, so callers don't need to change.

    Parameters:
      ``lite``: skip the insights stitch entirely (metadata only).
        Used by the two-phase loading pattern to paint the table
        immediately. Same call sequence as before.
      ``include_adsets``: keep the heavy `adsets.limit(50){...}`
        nesting that 安全監控 needs for `effectiveDailyBudget`. Default
        ``True`` for back-compat; set ``False`` from views that only
        need campaign-level fields (~20-30% smaller FB payload).

    Raises ``HTTPException`` if the metadata call fails entirely so
    callers can surface or swallow per their semantics. A failed
    insights call is non-fatal (campaigns still returned, just
    without numbers).
    """
    # Register the (metadata + insights) combo as a warm target so the
    # cache-warm loop refreshes it before TTL. Lite reads (skeleton)
    # aren't registered.
    if not lite:
        _register_warm_target(account_id, "campaigns", date_preset, time_range)

    if lite:
        # Lite path is just metadata — return without stitching.
        return await _fetch_campaigns_metadata(
            account_id, include_archived, include_adsets
        )

    # Parallel fetch of metadata + bulk insights. Both have their own
    # cache layers (metadata 15min, insights 5min), so this is cheap
    # on warm cache hits. asyncio.gather lets us overlap the two FB
    # calls on cold start instead of paying their latency serially.
    metadata_task = _fetch_campaigns_metadata(
        account_id, include_archived, include_adsets
    )
    insights_task = _fetch_campaign_insights_bulk(account_id, date_preset, time_range)
    try:
        metadata, insights_by_id = await asyncio.gather(metadata_task, insights_task)
    except HTTPException:
        # Re-raise the metadata error; insights errors are already
        # swallowed inside _fetch_campaign_insights_bulk.
        raise

    # CRITICAL: shallow-copy each campaign dict before stitching.
    # `metadata` is the SHARED reference from the metadata cache —
    # writing `c["insights"]` directly mutates the cached list, so
    # parallel callers with different date ranges would end up
    # cross-contaminating each other's insights. The 歷史花費 view
    # fires 6 parallel queries (one per month) against the same
    # cached metadata; without this copy, all 6 months ended up
    # showing whichever month's insights stitched last.
    stitched: List[dict] = []
    for c in metadata:
        c_copy = dict(c)
        cid = c_copy.get("id")
        if cid and cid in insights_by_id:
            c_copy["insights"] = {"data": [insights_by_id[cid]]}
        stitched.append(c_copy)
    return stitched


@app.get("/api/accounts/{account_id}/campaigns")
async def get_campaigns(account_id: str, date_preset: str = "last_30d", time_range: Optional[str] = None, include_archived: bool = False, include_adsets: bool = True):
    """List campaigns for an account.

    Delegates to :func:`_fetch_campaigns_for_account` so the batch
    ``/api/overview`` endpoint shares the same metadata + insights
    split. ``include_adsets`` defaults to True for backward compat;
    set to false from views that only need campaign-level fields to
    save ~20-30% of the FB payload.
    """
    camps = await _fetch_campaigns_for_account(
        account_id, date_preset, time_range, include_archived, include_adsets=include_adsets
    )
    return {"data": camps}


@app.get("/api/accounts/{account_id}/activities")
async def get_account_activities(
    account_id: str,
    since: int = Query(..., description="Unix timestamp (inclusive) lower bound"),
    until: int = Query(..., description="Unix timestamp (exclusive) upper bound"),
    object_id: Optional[str] = Query(
        None,
        description=(
            "Optional FB object id (campaign/adset/ad). When set, ask FB to "
            "return activities for that object instead of walking the whole account log."
        ),
    ),
    event_types: Optional[str] = Query(
        None,
        description=(
            "Comma-separated FB event_type filter (e.g. 'create_campaign_group'). "
            "When set, FB returns only matching rows AND we cap pages to 2 "
            "since filtered hits are rare. Omit for full activity log."
        ),
    ),
):
    """Proxy the FB Activity Log for an ad account.

    Powers the 安全監控 view's per-campaign edit-history expand. When
    ``object_id`` is provided we first ask FB to narrow the account log
    to that campaign/ad object (``oid``). Returns raw activity rows so
    the frontend can still defensively group by ``object_id``.

    Activity fields requested: who (actor_name), what (event_type +
    translated_event_type), when (event_time), which object
    (object_id, object_name, object_type), and a JSON-string
    ``extra_data`` blob with before/after for status / budget / name
    changes (FB's shape is unstable so we surface it verbatim).

    Two modes:
      - ``object_id`` set (row expand): apply FB-side object narrowing,
        max_pages=1. This avoids walking the whole account log for the
        common "show me this campaign's edits" action.
      - ``event_types`` set (e.g. creator-name prefetch): apply FB-side
        ``filtering`` so we only walk through hits, plus max_pages=2.
        High-activity accounts that previously fanned out to 10+ pages
        (one per ~500 events, BUCU climbing each page) now stop at
        the first 1000 matching rows.
      - ``event_types`` omitted (full edit-history expand): max_pages=3
        as a safety cap. 1500 newest events covers ~30 days for very
        active accounts and is plenty for the per-campaign timeline.
    """
    params: dict = {
        "since": str(since),
        "until": str(until),
        "fields": (
            "actor_id,actor_name,event_time,event_type,extra_data,"
            "object_id,object_name,object_type,translated_event_type"
        ),
        "limit": "500",
    }
    if object_id:
        # FB's ad-account Activity Log accepts object narrowing as `oid`
        # on supported object types. Keep `object_id` as our public API
        # name because it matches the returned field.
        params["oid"] = object_id
    if event_types:
        types_list = [t.strip() for t in event_types.split(",") if t.strip()]
        if types_list:
            params["filtering"] = _json.dumps(
                [{"field": "event_type", "operator": "IN", "value": types_list}]
            )
            max_pages = 2
        else:
            max_pages = 1 if object_id else 3
    elif object_id:
        max_pages = 1
    else:
        max_pages = 3
    try:
        data = await fb_get_paginated(
            f"{account_id}/activities", params, max_pages=max_pages
        )
    except HTTPException as exc:
        detail = str(exc.detail or "")
        is_param_error = exc.status_code == 400 and (
            "[code=100" in detail
            or "Invalid parameter" in detail
            or "Unsupported" in detail
            or "unknown field" in detail.lower()
        )
        if not object_id or not is_param_error:
            raise
        fallback_params = dict(params)
        fallback_params.pop("oid", None)
        data = await fb_get_paginated(
            f"{account_id}/activities", fallback_params, max_pages=3
        )
    return {"data": data}


@app.get("/api/campaigns/{campaign_id}")
async def get_campaign(
    campaign_id: str,
    date_preset: str = "last_30d",
    time_range: Optional[str] = None,
):
    """Fetch a single campaign + insights — for the report / share page.

    Avoids ``/api/accounts/{id}/campaigns`` (the full account list)
    when the caller only needs ONE campaign. Heavy accounts (e.g. 吸引力
    LURE with 100+ campaigns) previously paid the full account scan
    just to surface one row.

    Metadata and insights are fetched SEPARATELY, in parallel: the
    numbers come from the campaign's `/insights` EDGE
    (`_fetch_single_entity_insights`) — the same canonical path the
    dashboard's bulk fetch uses — NOT from field-expanding `insights`
    on the campaign node, which returns an EMPTY row for some
    campaigns (awareness objectives / certain delivery structures)
    even when they clearly spent. A failed insights fetch is
    non-fatal (campaign returned without numbers)."""
    base_fields = (
        "id,name,status,objective,daily_budget,lifetime_budget,"
        "created_time,updated_time,account_id"
    )

    async def _ins_row() -> dict:
        try:
            return await _fetch_single_entity_insights(
                campaign_id, date_preset, time_range
            )
        except HTTPException as e:
            if _is_rate_limit_exception(e):
                raise
            print(
                f"[campaign] {campaign_id} insights fetch failed: "
                f"{e.status_code} {e.detail} — returning without insights",
                flush=True,
            )
            return {}

    data, ins_row = await asyncio.gather(
        fb_get(campaign_id, {"fields": base_fields}), _ins_row()
    )
    if isinstance(data, dict) and ins_row:
        data["insights"] = {"data": [ins_row]}
    # Attach the team-wide nickname (店家 · 設計師) so the report / share
    # page can show it instead of the raw campaign name. Scoped to this
    # one campaign — we never expose the whole nickname list publicly.
    if isinstance(data, dict):
        data["nickname"] = await _campaign_nickname_display(campaign_id)
    return {"data": data}


@app.post("/api/campaigns/{campaign_id}/status")
async def update_campaign_status(campaign_id: str, status: str = Query(...)):
    return await fb_post(campaign_id, {"status": status}, invalidate_entity=campaign_id)


@app.post("/api/campaigns/{campaign_id}/budget")
async def update_campaign_budget(campaign_id: str, daily_budget: int = Query(None), lifetime_budget: int = Query(None)):
    payload = {}
    if daily_budget is not None:
        payload["daily_budget"] = str(daily_budget)
    if lifetime_budget is not None:
        payload["lifetime_budget"] = str(lifetime_budget)
    return await fb_post(campaign_id, payload, invalidate_entity=campaign_id)


# ── 廣告組合 ─────────────────────────────────────────────────────────

@app.get("/api/campaigns/{campaign_id}/adsets")
async def get_adsets(
    campaign_id: str,
    date_preset: str = "last_30d",
    time_range: Optional[str] = None,
    budget_only: bool = Query(False),
):
    if budget_only is True:
        # `is True` (not truthiness): when this function is called
        # directly from Python (snapshot gather), budget_only is the
        # fastapi Query(False) DEFAULT OBJECT, which is truthy — the
        # snapshot path was silently getting budget-only adsets with
        # no insights, freezing every adset as $0. Direct callers
        # should use _fetch_adsets_with_insights instead.
        return await fb_get(f"{campaign_id}/adsets", {
            "fields": "id,name,status,daily_budget,lifetime_budget",
            "limit": "500"
        })
    return await _fetch_adsets_with_insights(campaign_id, date_preset, time_range)


async def _fetch_adsets_with_insights(
    campaign_id: str,
    date_preset: str = "last_30d",
    time_range: Optional[str] = None,
) -> dict:
    """Adsets metadata + insights for one campaign.

    Metadata and insights are fetched SEPARATELY, in parallel: numbers
    come from the campaign's `/insights?level=adset` bulk EDGE
    (`_fetch_child_insights_bulk`) — one FB call for all adsets — and
    are stitched under `adset["insights"]["data"][0]`. This replaces
    the nested field-expansion (`/adsets?fields=...insights...`),
    which returned EMPTY nested insights for some campaigns even when
    they spent (same failure family as the campaign-node expansion).
    A failed insights call is non-fatal — adsets still return, just
    without numbers."""
    meta_task = fb_get(f"{campaign_id}/adsets", {
        "fields": "id,name,status,daily_budget,lifetime_budget",
        "limit": "500"
    })

    async def _ins_map() -> dict:
        try:
            return await _fetch_child_insights_bulk(
                campaign_id, "adset", date_preset, time_range
            )
        except HTTPException as e:
            if _is_rate_limit_exception(e):
                raise
            return {}

    data, ins_by_id = await asyncio.gather(meta_task, _ins_map())
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        stitched = []
        for a in data["data"]:
            a_copy = dict(a) if isinstance(a, dict) else a
            if isinstance(a_copy, dict):
                aid = a_copy.get("id")
                if aid and aid in ins_by_id:
                    a_copy["insights"] = {"data": [ins_by_id[aid]]}
            stitched.append(a_copy)
        data["data"] = stitched
    return data


@app.get("/api/campaigns/{campaign_id}/ads")
async def get_campaign_ads(campaign_id: str):
    """All ads (3rd level) under a campaign — name/status metadata
    only, no insights. Backs the LINE-push「以廣告播報」multi-picker,
    which needs the flat ad list without the operator drilling
    through each adset. FB exposes the /ads edge directly on the
    campaign node so this is a single paginate-free call for typical
    campaign sizes (limit 500)."""
    return await fb_get(f"{campaign_id}/ads", {
        "fields": "id,name,status",
        "limit": "500",
    })


@app.post("/api/adsets/{adset_id}/status")
async def update_adset_status(adset_id: str, status: str = Query(...)):
    return await fb_post(adset_id, {"status": status}, invalidate_entity=adset_id)


@app.post("/api/adsets/{adset_id}/budget")
async def update_adset_budget(adset_id: str, daily_budget: int = Query(None)):
    payload = {}
    if daily_budget is not None:
        payload["daily_budget"] = str(daily_budget)
    return await fb_post(adset_id, payload, invalidate_entity=adset_id)


# ── 廣告 ─────────────────────────────────────────────────────────────

@app.get("/api/adsets/{adset_id}/ads")
async def get_ads(adset_id: str, date_preset: str = "last_30d", time_range: Optional[str] = None):
    # Metadata (creative fields) and insights are fetched SEPARATELY:
    # numbers come from the adset's `/insights?level=ad` bulk EDGE
    # (`_fetch_child_insights_bulk`, one FB call for all ads, includes
    # the video metrics 成效報告 needs) and are stitched under
    # `ad["insights"]["data"][0]`. Nested field-expansion returned
    # EMPTY insights for some entities even when they spent — same
    # failure family as the campaign-node expansion.
    async def _ins_map() -> dict:
        try:
            return await _fetch_child_insights_bulk(
                adset_id, "ad", date_preset, time_range
            )
        except HTTPException as e:
            if _is_rate_limit_exception(e):
                raise
            return {}

    ins_task = asyncio.ensure_future(_ins_map())
    last_error: Optional[HTTPException] = None
    # Progressive fallback so a partial failure (e.g. account lacks
    # creative permission) still returns something usable.
    #
    # We request BOTH ``thumbnail_url`` (small, for the 30x30 row
    # icon) and ``image_url`` (full-resolution source asset, used by
    # the preview modal). FB's default ``thumbnail_url`` is ~64x64,
    # which looks blurry when scaled up to the 520px modal; the
    # ``thumbnail_width``/``thumbnail_height`` query params only
    # apply when you hit /{creative_id} directly and are ignored
    # when the thumbnail is requested through field expansion on
    # the Ad edge. ``image_url`` returns the original CDN asset
    # (typically 1080px+) for image-based creatives, which is sharp
    # at any reasonable preview scale. For video / carousel /
    # dynamic creatives ``image_url`` may be absent — the frontend
    # falls back to ``thumbnail_url`` in that case.
    # `effective_object_story_id` + `instagram_permalink_url` let the
    # preview modal show a "open original FB/IG post" link. They're
    # cheap string fields so we include them from tier 1 down until
    # FB forces us to drop creative entirely.
    # ``object_story_spec`` sub-fields are requested in an expanded
    # form so the frontend can tell an inline-authored dark post
    # (``link_data`` / ``photo_data`` / ``video_data`` / ``template_data``
    # populated) apart from an ad that reuses an existing organic
    # post (``object_story_spec`` absent or empty). Without these
    # fields the "前台貼文" badge misfires on every ad because FB
    # returns ``effective_object_story_id`` for everything.
    # ``link_data`` is expanded to include ``child_attachments`` so the
    # preview modal can render a CAROUSEL ad's multiple cards (each card's
    # ``picture`` is a proper display-size image, unlike the 120px row
    # ``thumbnail_url``). ``picture`` on the parent link_data is the single
    # non-carousel card image. If an account rejects this deeper expansion
    # the fetch falls through to tier 2 (object_story_spec dropped).
    # Each carousel card may itself be a VIDEO — ``video_id`` on the child
    # attachment lets the preview resolve a playable source per card
    # (``picture`` is then only that card's poster frame).
    oss_expanded = (
        "object_story_spec{video_data,"
        "link_data{message,name,description,picture,"
        "child_attachments{picture,image_hash,video_id,link,name,description}},"
        "photo_data,template_data}"
    )
    # Note: ``creative{id,...}`` — we explicitly request the creative
    # id so the frontend can hit /api/creatives/{id}/hires-thumbnail
    # as a 600px fallback when /api/posts/{post_id}/media fails
    # (typically when the token lacks pages_read_engagement).
    # asset_feed_spec is where Advantage+ / dynamic-creative video ads
    # keep their video (video_id lives in asset_feed_spec.videos[], NOT
    # object_story_spec.video_data) — without it those ads can't play and
    # fall back to a still image in the report preview.
    afs = "asset_feed_spec{videos{video_id,thumbnail_url},images{url}}"
    attempts = [
        # Tier 1: everything — image_url for sharp still preview,
        # expanded object_story_spec so we can classify inline vs
        # front-stage, asset_feed_spec for dynamic-creative videos, plus
        # the two permalink fields.
        f"id,name,status,creative{{id,thumbnail_url,image_url,{oss_expanded},{afs},effective_object_story_id,instagram_permalink_url,title,body}}",
        # Tier 2: drop object_story_spec (some accounts reject it) but keep
        # asset_feed_spec so dynamic-creative videos still resolve.
        f"id,name,status,creative{{id,thumbnail_url,image_url,{afs},effective_object_story_id,instagram_permalink_url,title,body}}",
        # Tier 3: drop image_url.
        f"id,name,status,creative{{id,thumbnail_url,effective_object_story_id,instagram_permalink_url,title,body}}",
        "id,name,status",
    ]
    data: Optional[dict] = None
    for fields in attempts:
        try:
            params = {"fields": fields, "limit": "500"}
            if "thumbnail_url" in fields:
                # 120px is 4× DPR for the 30×30 row icon displayed in
                # the Dashboard tree. Preview modal uses image_url
                # (full resolution) so shrinking thumbnail_url only
                # affects the tiny list icons — saves ~20× per-image
                # bytes.
                params["thumbnail_width"] = "120"
                params["thumbnail_height"] = "120"
            data = await fb_get(f"{adset_id}/ads", params)
            break
        except HTTPException as e:
            last_error = e
            if _is_rate_limit_exception(e):
                ins_task.cancel()
                raise
            continue
    if data is None:
        # All attempts failed — surface the most recent error so the
        # frontend can display the actual reason instead of a silent 500.
        ins_task.cancel()
        if last_error is not None:
            raise last_error
        raise HTTPException(status_code=502, detail="Failed to load ads from Facebook API")

    ins_by_id = await ins_task
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        stitched = []
        for ad in data["data"]:
            ad_copy = dict(ad) if isinstance(ad, dict) else ad
            if isinstance(ad_copy, dict):
                aid = ad_copy.get("id")
                if aid and aid in ins_by_id:
                    ad_copy["insights"] = {"data": [ins_by_id[aid]]}
            stitched.append(ad_copy)
        data["data"] = stitched
    return data


# ── Insights breakdowns (for the share / dashboard report) ────
#
# A single helper covers both adset and ad levels. FB Graph API
# accepts ``breakdowns=`` on the entity's insights edge directly, so
# we just proxy with the right path. Permitted dimensions are
# whitelisted to avoid arbitrary FB params being passed through.

_BREAKDOWN_DIMS = {
    "age",
    "gender",
    "region",
    "publisher_platform",
}


@app.get("/api/breakdown")
async def get_insights_breakdown(
    level: str,
    id: str,
    dim: str,
    date_preset: str = "last_30d",
    time_range: Optional[str] = None,
):
    """Return per-bucket insights for a given adset/ad ID, broken
    down by `dim` (age / gender / region / publisher_platform).

    Result rows include `key` (the bucket label) plus the standard
    spend / impressions / clicks / ctr / cpc and a derived `msgs`
    count (mirrors `_extract_msg_count` so message-driven UIs match
    the rest of the dashboard).
    """
    if level not in ("adset", "ad"):
        raise HTTPException(status_code=400, detail="Invalid level")
    if dim not in _BREAKDOWN_DIMS:
        raise HTTPException(status_code=400, detail="Invalid breakdown dim")

    fields = "spend,impressions,clicks,ctr,cpc,cpm,actions"
    params: dict[str, Any] = {
        "fields": fields,
        "breakdowns": dim,
        "limit": "200",
    }
    if time_range:
        params["time_range"] = time_range
    else:
        params["date_preset"] = date_preset

    rows = await fb_get_paginated(f"{id}/insights", params)
    out: list[dict[str, Any]] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        out.append(
            {
                "key": str(r.get(dim, "")) or "—",
                "spend": r.get("spend"),
                "impressions": r.get("impressions"),
                "clicks": r.get("clicks"),
                "ctr": r.get("ctr"),
                "cpc": r.get("cpc"),
                "cpm": r.get("cpm"),
                "msgs": _extract_msg_count(r.get("actions")),
            }
        )
    return {"data": out, "level": level, "dim": dim}


@app.get("/api/debug/entity-actions")
async def debug_entity_actions(
    level: str,
    id: str,
    date_preset: str = "last_90d",
    time_range: Optional[str] = None,
):
    """Dump EVERY action_type Facebook attributes to an entity (ad /
    adset / campaign). Diagnostic only — surfaced in 工程模式 → 其他 to
    answer 'is metric X in the API?' questions (e.g. IG 追蹤次數): if an
    IG-follow action_type ever comes back here, we can wire it as a
    field; if it never appears, it confirms the API doesn't expose it.

    Not a product endpoint. Uses a wide 90-day default window to
    maximise the chance any low-volume conversion has attributed rows.
    """
    if level not in ("ad", "adset", "campaign"):
        raise HTTPException(status_code=400, detail="Invalid level")
    params: dict[str, Any] = {
        "fields": "actions,action_values,cost_per_action_type,outbound_clicks,inline_link_clicks",
    }
    if time_range:
        params["time_range"] = time_range
    else:
        params["date_preset"] = date_preset
    rows = await fb_get_paginated(f"{id}/insights", params)
    actions: list = []
    cost_per: list = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        for a in r.get("actions") or []:
            if isinstance(a, dict):
                actions.append(a)
        for a in r.get("cost_per_action_type") or []:
            if isinstance(a, dict):
                cost_per.append(a)
    action_types = sorted(
        {str(a.get("action_type")) for a in actions if a.get("action_type")}
    )
    # Flag anything that smells like an IG / follow conversion so the
    # operator doesn't have to eyeball the whole list.
    follow_like = [t for t in action_types if any(k in t.lower() for k in ("follow", "instagram", "ig_"))]
    return {
        "level": level,
        "id": id,
        "action_types": action_types,
        "follow_like": follow_like,
        "actions": actions,
        "cost_per_action_type": cost_per,
        "rows": len(rows),
    }


@app.get("/api/videos/{video_id}/source")
async def get_video_source(video_id: str):
    """Fetch the playable source URL + poster for a FB video asset.

    Used by the 3rd-level creative preview modal so video ads play
    inline instead of showing a tiny thumbnail. The Graph API
    ``/{video_id}`` edge returns a signed ``source`` URL that the
    browser can use directly in a ``<video>`` element, plus a
    ``picture`` poster frame.

    This call is intentionally LAZY from the frontend (the React
    Query hook enables only when the preview modal opens) so we
    don't pay per-row latency to fetch a URL most users never view.
    """
    data = await fb_get(video_id, {"fields": "source,picture"})
    return {
        "source": data.get("source"),
        "picture": data.get("picture"),
    }


@app.get("/api/posts/{post_id}/media")
async def get_post_media(post_id: str):
    """Fetch the full-resolution image / video source from a FB page post.

    Used by the 3rd-level creative preview modal when the ad is a
    "front-stage post" — i.e. it reuses an existing organic FB post
    instead of being authored inline via ``object_story_spec``.

    In the front-stage case the creative endpoint returns no
    ``image_url`` and no ``object_story_spec.video_data.video_id``;
    only a compressed ~120px ``thumbnail_url`` is available. Rendering
    that in the 520px modal looks blurry, and video ads can't play
    at all because we lack the video handle.

    Fetching ``/{post_id}?fields=full_picture,attachments{...}``
    directly returns the actual asset URLs from the underlying post:
      - ``full_picture`` — the post's hero image (highest res)
      - ``attachments[0].media.image.src`` — image asset CDN URL
      - ``attachments[0].media.source`` — playable video source
        (same kind of URL the /{video_id} edge would return)

    Errors are propagated back to the client as the ``error`` field
    so the frontend can tell the user what went wrong (typically
    "Insufficient permissions" — the default FB Login scopes don't
    include ``pages_read_engagement``, which is required to read
    arbitrary Page post content). The frontend then gracefully
    falls back to the 600px creative thumbnail path and, if even
    that fails, to a blurred thumbnail with a "view original post"
    call-to-action.
    """
    try:
        data = await fb_get(
            post_id,
            {
                "fields": (
                    "full_picture,"
                    "attachments{media_type,media{image{src},source}}"
                )
            },
        )
    except HTTPException as exc:
        # Pass the FB / Graph error detail back to the client so the
        # modal can decide what to fall back to and (optionally) show
        # a diagnostic. DON'T 500 the endpoint — a failed post fetch
        # is expected behavior when the token lacks pages_read_engagement.
        return {"image_url": None, "video_source": None, "error": str(exc.detail)}

    image_url: Optional[str] = None
    video_source: Optional[str] = None

    attachments = data.get("attachments") if isinstance(data, dict) else None
    if isinstance(attachments, dict):
        items = attachments.get("data") or []
        if items and isinstance(items, list):
            first = items[0]
            if isinstance(first, dict):
                media = first.get("media")
                if isinstance(media, dict):
                    # Video attachment — media.source is the playable URL
                    src = media.get("source")
                    if isinstance(src, str) and src:
                        video_source = src
                    # Image attachment — media.image.src is the full-res CDN URL
                    img = media.get("image")
                    if isinstance(img, dict):
                        img_src = img.get("src")
                        if isinstance(img_src, str) and img_src:
                            image_url = img_src

    # full_picture is the safest image fallback — always present on
    # image-style posts, unaffected by attachment structure variants.
    if not image_url:
        fp = data.get("full_picture") if isinstance(data, dict) else None
        if isinstance(fp, str) and fp:
            image_url = fp

    return {"image_url": image_url, "video_source": video_source, "error": None}


@app.get("/api/creatives/{creative_id}/hires-thumbnail")
async def get_creative_hires_thumbnail(creative_id: str, size: int = 600):
    """Return a larger-dimension server-rendered thumbnail for a single
    ``AdCreative`` via the FB-documented ``thumbnail_width`` /
    ``thumbnail_height`` params.

    These params are honored when you hit the creative edge directly
    (``/{creative_id}``) but NOT when you request ``thumbnail_url``
    through field expansion on the ad edge (that's why
    ``main.py:get_ads`` only gets a compressed ~120px icon).

    This endpoint is the graceful-degradation fallback for the
    preview modal when ``get_post_media`` fails (e.g. token lacks
    ``pages_read_engagement`` so we can't read the underlying post).
    The 600px version is **still a server-side preview**, not the
    original CDN source — so it can still look soft on large
    displays — but it's ~25× larger than the 120px row icon and
    usually looks fine at modal scale.

    ``size`` clamps to the 120..1080 range to keep pathological
    callers from hammering FB with enormous renders.
    """
    clamped = max(120, min(1080, int(size)))
    try:
        data = await fb_get(
            creative_id,
            {
                "fields": "thumbnail_url",
                "thumbnail_width": str(clamped),
                "thumbnail_height": str(clamped),
            },
        )
    except HTTPException as exc:
        return {"thumbnail_url": None, "error": str(exc.detail)}
    url = data.get("thumbnail_url") if isinstance(data, dict) else None
    return {"thumbnail_url": url if isinstance(url, str) and url else None, "error": None}


# ── 報告快照 (frozen share-link reports) ──────────────────────────────
#
# 分享連結不再每次跟 FB 拿:操作者按「生成快照」時,後端一次抓完整份
# 報告(活動 + 廣告組合 + 每組廣告 + 每組受眾洞察 breakdowns),連縮圖
# 也下載存進 DB,整包凍結成一列 report_snapshots。之後 /r/s/{id} 直接
# 讀凍結副本,零 FB 呼叫。每次生成都是新的一列(各有 id),舊連結保留
# 舊資料。

_SNAPSHOT_BREAKDOWN_DIMS = ("publisher_platform", "gender", "age", "region")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


async def _download_snapshot_asset(url: Optional[str]) -> Optional[tuple]:
    """Fetch a FB/IG CDN image → (bytes, content_type), or None on any
    failure (a broken thumbnail must never abort the whole snapshot)."""
    if not url or not isinstance(url, str):
        return None
    try:
        from urllib.parse import urlparse

        host = (urlparse(url).hostname or "").lower()
        if not any(host == s.lstrip(".") or host.endswith(s) for s in _PROXY_ALLOWED_HOST_SUFFIXES):
            return None
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(url, follow_redirects=True)
        if r.status_code != 200 or not r.content:
            return None
        ctype = r.headers.get("content-type", "image/jpeg")
        if not ctype.startswith("image/"):
            ctype = "image/jpeg"
        return r.content, ctype
    except Exception as exc:
        print(f"[snapshot] asset fetch failed: {exc!r}", flush=True)
        return None


async def _freeze_all_thumbnails(conn, sid: str, ads: list) -> None:
    """Download every ad's display image, store under the snapshot, and
    rewrite `creative.image_url` / `thumbnail_url` to the stored asset URL.
    Downloads run concurrently (bounded); DB inserts stay serial on the
    shared connection.

    Client-supplied payloads already set `image_url` to the best URL the
    browser had loaded, so NO hires FB call is needed. Only server-fetched
    video ads without image_url fall back to the hires edge."""
    entries: list = []  # (creative_dict, src_url)
    for ad in ads:
        if not isinstance(ad, dict):
            continue
        creative = ad.get("creative")
        if not isinstance(creative, dict):
            continue
        src = creative.get("image_url") or creative.get("thumbnail_url")
        if not creative.get("image_url") and creative.get("id"):
            try:
                hires = await get_creative_hires_thumbnail(str(creative["id"]), 600)
                if isinstance(hires, dict) and hires.get("thumbnail_url"):
                    src = hires["thumbnail_url"]
            except Exception:
                pass
        if src:
            entries.append((creative, src))

    sem = asyncio.Semaphore(8)

    async def _dl(url):
        async with sem:
            return await _download_snapshot_asset(url)

    downloaded = await asyncio.gather(*[_dl(src) for (_, src) in entries])

    for (creative, src), fetched in zip(entries, downloaded):
        if not fetched:
            continue
        content, ctype = fetched
        h = hashlib.sha1(str(src).encode("utf-8")).hexdigest()[:24]
        await conn.execute(
            """
            INSERT INTO report_snapshot_assets (snapshot_id, hash, content_type, bytes)
            VALUES ($1::uuid, $2, $3, $4)
            ON CONFLICT (snapshot_id, hash) DO NOTHING
            """,
            sid, h, ctype, content,
        )
        asset_url = f"/api/report-snapshots/{sid}/asset/{h}"
        creative["image_url"] = asset_url
        creative["thumbnail_url"] = asset_url


async def _gather_report_snapshot(
    conn,
    sid: str,
    campaign_id: str,
    date_preset: str,
    time_range: Optional[str],
    variant: str,
    provided: Optional[dict] = None,
) -> dict:
    """Build the frozen payload. When `provided` (the browser's ALREADY-
    loaded report data) is present, use ONLY it — zero FB Graph calls, the
    fast path that avoids the ad-account rate limit (code 17). Otherwise
    fall back to re-fetching the whole tree from FB."""

    def _spend_of(entity) -> float:
        try:
            ins = (entity.get("insights") or {}).get("data") or []
            return float(ins[0].get("spend") or 0) if ins else 0.0
        except Exception:
            return 0.0

    if provided:
        campaign = provided.get("campaign") if isinstance(provided.get("campaign"), dict) else {}
        if not campaign:
            campaign = {"id": campaign_id}
        adsets = provided.get("adsets") if isinstance(provided.get("adsets"), list) else []
        p_ads = provided.get("adsByAdset") if isinstance(provided.get("adsByAdset"), dict) else {}
        p_bd = provided.get("breakdownsByAdset") if isinstance(provided.get("breakdownsByAdset"), dict) else {}
        ads_by_adset: dict = {}
        breakdowns_by_adset: dict = {}
        for adset in adsets:
            if not isinstance(adset, dict):
                continue
            aid = str(adset.get("id") or "")
            if not aid:
                continue
            ads = p_ads.get(aid)
            ads_by_adset[aid] = ads if isinstance(ads, list) else []
            if variant == "standard":
                bd = p_bd.get(aid)
                breakdowns_by_adset[aid] = bd if isinstance(bd, dict) else {}
        # Nickname is a cheap DB lookup (NOT FB) — always attach so the
        # frozen page shows 店家·設計師 even if the browser's campaign
        # object didn't carry it.
        try:
            campaign["nickname"] = await _campaign_nickname_display(campaign_id)
        except Exception:
            pass
    else:
        campaign_resp = await get_campaign(campaign_id, date_preset, time_range)
        campaign = campaign_resp.get("data") if isinstance(campaign_resp, dict) else None
        if not isinstance(campaign, dict):
            raise HTTPException(status_code=502, detail="無法載入行銷活動資料")
        # NOT get_adsets(): calling the route function directly passes the
        # fastapi Query(False) default OBJECT as budget_only, which is
        # truthy — the snapshot froze budget-only adsets with no insights
        # (every adset $0,「此區間無花費的廣告組合」).
        adsets_resp = await _fetch_adsets_with_insights(campaign_id, date_preset, time_range)
        adsets = adsets_resp.get("data", []) if isinstance(adsets_resp, dict) else []
        if not isinstance(adsets, list):
            adsets = []
        ads_by_adset = {}
        breakdowns_by_adset = {}
        for adset in adsets:
            if not isinstance(adset, dict):
                continue
            aid = str(adset.get("id") or "")
            if not aid:
                continue
            try:
                ads_resp = await get_ads(aid, date_preset, time_range)
                ads = ads_resp.get("data", []) if isinstance(ads_resp, dict) else []
            except Exception as exc:
                print(f"[snapshot] ads fetch failed for {aid}: {exc!r}", flush=True)
                ads = []
            ads_by_adset[aid] = ads if isinstance(ads, list) else []
            if variant == "standard":
                if _spend_of(adset) > 0:
                    dims: dict = {}
                    for dim in _SNAPSHOT_BREAKDOWN_DIMS:
                        try:
                            bd = await get_insights_breakdown("adset", aid, dim, date_preset, time_range)
                            dims[dim] = bd.get("data", []) if isinstance(bd, dict) else []
                        except Exception as exc:
                            print(f"[snapshot] breakdown {dim} failed for {aid}: {exc!r}", flush=True)
                            dims[dim] = []
                    breakdowns_by_adset[aid] = dims
                else:
                    breakdowns_by_adset[aid] = {dim: [] for dim in _SNAPSHOT_BREAKDOWN_DIMS}

    flat_ads = [ad for ads in ads_by_adset.values() for ad in (ads or []) if isinstance(ad, dict)]
    await _freeze_all_thumbnails(conn, sid, flat_ads)

    date_from = None
    date_to = None
    if time_range:
        try:
            tr = json.loads(time_range)
            date_from = tr.get("since")
            date_to = tr.get("until")
        except Exception:
            pass

    return {
        "version": 1,
        "campaign": campaign,
        "adsets": adsets,
        "adsByAdset": ads_by_adset,
        "breakdownsByAdset": breakdowns_by_adset,
        "meta": {
            "variant": variant,
            "date_preset": date_preset,
            "time_range": time_range,
            "from": date_from,
            "to": date_to,
        },
    }


@app.post("/api/report-snapshots")
async def create_report_snapshot(request: Request, fb_user_id: Optional[str] = Query(None)):
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="資料庫尚未連線")
    body = await request.json()
    campaign_id = str(body.get("campaign_id") or "").strip()
    if not campaign_id:
        raise HTTPException(status_code=400, detail="缺少 campaign_id")
    account_id = (str(body.get("account_id") or "").strip() or None)
    variant = "perf" if body.get("variant") == "perf" else "standard"
    date_preset = body.get("date_preset") or "last_30d"
    time_range = body.get("time_range") or None
    date_label = body.get("date_label") or ""
    uid = (fb_user_id or _current_fb_user_id.get() or "").strip() or None

    async with _db_pool.acquire() as conn:
        # Shell row first so the assets FK is satisfiable while we stream
        # thumbnails in, then UPDATE the payload once gathering finishes.
        row = await conn.fetchrow(
            """
            INSERT INTO report_snapshots (campaign_id, account_id, variant, created_by, date_label)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            """,
            campaign_id, account_id, variant, uid, date_label,
        )
        sid = str(row["id"])
        # The browser posts its already-loaded report tree as `payload`
        # so we DON'T re-fetch from FB (avoids the ad-account rate limit).
        provided = body.get("payload") if isinstance(body.get("payload"), dict) else None
        try:
            payload = await _gather_report_snapshot(
                conn, sid, campaign_id, date_preset, time_range, variant, provided
            )
        except Exception:
            # Roll back the shell row so a failed generation leaves no
            # empty record in the history list.
            await conn.execute("DELETE FROM report_snapshots WHERE id = $1::uuid", sid)
            raise
        payload["meta"].update(
            {
                "hide_money": bool(body.get("hide_money")),
                "use_spend_plus": bool(body.get("use_spend_plus")),
                "markup_percent": body.get("markup_percent"),
                "selected_fields": body.get("selected_fields"),
                "creative_fields": body.get("creative_fields"),
                "date_label": date_label,
            }
        )
        camp = payload.get("campaign") or {}
        label = (camp.get("nickname") or camp.get("name")) if isinstance(camp, dict) else None
        await conn.execute(
            "UPDATE report_snapshots SET payload = $2::jsonb, label = $3 WHERE id = $1::uuid",
            sid, json.dumps(payload), label,
        )
    return {"id": sid, "variant": variant}


@app.get("/api/report-snapshots")
async def list_report_snapshots(
    campaign_id: str = Query(...), fb_user_id: Optional[str] = Query(None)
):
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="資料庫尚未連線")
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, variant, label, date_label, created_at
            FROM report_snapshots
            WHERE campaign_id = $1
            ORDER BY created_at DESC
            LIMIT 100
            """,
            campaign_id,
        )
    return {
        "data": [
            {
                "id": str(r["id"]),
                "variant": r["variant"],
                "label": r["label"],
                "date_label": r["date_label"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]
    }


@app.get("/api/report-snapshots/{snapshot_id}")
async def get_report_snapshot(snapshot_id: str):
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="資料庫尚未連線")
    if not _UUID_RE.match(snapshot_id):
        raise HTTPException(status_code=404, detail="找不到報告快照")
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT variant, label, date_label, created_at, payload FROM report_snapshots WHERE id = $1::uuid",
            snapshot_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="找不到報告快照")
    payload = row["payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    return {
        "data": payload,
        "variant": row["variant"],
        "label": row["label"],
        "date_label": row["date_label"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


@app.get("/api/report-snapshots/{snapshot_id}/asset/{asset_hash}")
async def get_report_snapshot_asset(snapshot_id: str, asset_hash: str):
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="資料庫尚未連線")
    if not _UUID_RE.match(snapshot_id):
        raise HTTPException(status_code=404, detail="asset not found")
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT content_type, bytes FROM report_snapshot_assets WHERE snapshot_id = $1::uuid AND hash = $2",
            snapshot_id, asset_hash,
        )
    if not row:
        raise HTTPException(status_code=404, detail="asset not found")
    return Response(
        content=row["bytes"],
        media_type=row["content_type"] or "image/jpeg",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.delete("/api/report-snapshots/{snapshot_id}")
async def delete_report_snapshot(snapshot_id: str, fb_user_id: Optional[str] = Query(None)):
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="資料庫尚未連線")
    if not _UUID_RE.match(snapshot_id):
        return {"ok": True}
    async with _db_pool.acquire() as conn:
        await conn.execute("DELETE FROM report_snapshots WHERE id = $1::uuid", snapshot_id)
    return {"ok": True}


@app.get("/api/pages/{page_id}/info")
async def get_page_info(page_id: str):
    """Fetch the Facebook Page's display name + profile picture URL.

    Used by the 3rd-level creative preview modal so the dialog can
    render a "real FB post" header row (avatar + page name) instead
    of just the raw ad name. Called lazily from the frontend — only
    when the modal opens and the creative has an
    ``effective_object_story_id`` to extract the page id from.

    Returns ``{"name": str | None, "picture_url": str | None, "error": str | None}``.
    Errors are passed through to the client as the ``error`` field
    (not raised as HTTP errors) so a single unreachable page never
    blocks the preview from rendering the image and body text that
    we DO have. Most commonly the error is "insufficient
    permissions" — the default FB Login scopes
    (``ads_read,ads_management,business_management``) don't include
    ``pages_read_engagement`` which is what Graph requires to read
    arbitrary Page metadata.
    """
    # Page name + avatar are slow-moving; cache 1h instead of the
    # default 5min. The dashboard 3rd level renders a page chip on
    # every creative row, so this path is hit far more often than
    # when only the preview modal used it — a short TTL would burn
    # the page-level (code 32) rate-limit bucket for no benefit.
    #
    # NOTE: `displayed_message_response_time` was tried here
    # (2026-06-11) and removed the same day — every page the team
    # manages uses automatic responsiveness, so FB only ever returned
    # the literal "AUTOMATIC", never a usable number. The measured
    # 回覆率/回覆時間 in Business Suite has no public API; the only
    # route is computing it from /{page}/conversations (needs
    # pages_messaging + page-admin tokens + App Review).
    try:
        data = await fb_get(
            page_id,
            {"fields": "name,picture.width(80).height(80)"},
            cache_ttl=3600,
        )
    except HTTPException as exc:
        return {"name": None, "picture_url": None, "error": str(exc.detail)}
    picture = data.get("picture")
    picture_url = None
    if isinstance(picture, dict):
        inner = picture.get("data")
        if isinstance(inner, dict):
            picture_url = inner.get("url")
    return {"name": data.get("name"), "picture_url": picture_url, "error": None}


@app.post("/api/ads/{ad_id}/status")
async def update_ad_status(ad_id: str, status: str = Query(...)):
    return await fb_post(ad_id, {"status": status}, invalidate_entity=ad_id)


# ── 帳戶整體成效 ──────────────────────────────────────────────────────

async def _fetch_account_insights(
    account_id: str,
    date_preset: str,
    time_range: Optional[str],
) -> dict:
    """Core account-insights fetch. Returns the raw FB envelope
    (``{"data": [...], "paging": {...}}``) so callers can pluck the
    first entry or keep the full shape. Shared by the per-account
    route and the batch ``/api/overview`` endpoint.

    ``slow_ok=True`` because FB's insights endpoint for a large
    account is one of the slowest fan-out paths in the dashboard:
    under parallel load during a cold page-load it routinely
    takes 10-15s before returning, which was pushing the old 10s
    GET timeout into "sometimes works, sometimes doesn't" territory.
    """
    _register_warm_target(account_id, "insights", date_preset, time_range)
    params = {
        "fields": "spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,actions",
    }
    if time_range:
        params["time_range"] = time_range
    else:
        params["date_preset"] = date_preset
    return await fb_get(f"{account_id}/insights", params, slow_ok=True)


@app.get("/api/accounts/{account_id}/insights")
async def get_account_insights(
    account_id: str,
    date_preset: str = "last_30d",
    time_range: Optional[str] = None,
):
    return await _fetch_account_insights(account_id, date_preset, time_range)


# ── 批次總覽（多帳戶並行）──────────────────────────────────────

# 上個月要等到本月幾號(含)才視為「結算完成、可存快照」。FB insights
# 在月底翻頁後 1~2 天內仍會回補(花費修正、私訊歸因),7/1 就把 6 月
# 凍結進 DB 會存到未結算的數字,而且之後所有人讀的都是那份髒快照。
_SNAPSHOT_SETTLE_DAY = 3


def _latest_snapshotable_month() -> str:
    """最後一個「可以存快照」的月份 ('YYYY-MM', SCHEDULER_TZ)。

    本月 1、2 號期間,上個月還在結算緩衝期 → 只回上上個月;3 號(含)
    之後才把上個月納入。lazy-fill 與工程模式預熱都走這個判斷。"""
    tz = _scheduler_tz()
    today = datetime.now(timezone.utc).astimezone(tz).date()
    prev = date(today.year, today.month, 1) - timedelta(days=1)
    if today.day < _SNAPSHOT_SETTLE_DAY:
        prev = date(prev.year, prev.month, 1) - timedelta(days=1)
    return f"{prev.year:04d}-{prev.month:02d}"


def _overview_snapshot_month(date_preset: str, time_range: Optional[str]) -> Optional[str]:
    """If this query is exactly a COMPLETE PAST calendar month, return
    'YYYY-MM' (safe to serve from a DB snapshot — past months are
    immutable). Otherwise None → serve live.

    Two shapes map to a complete past month:
      1. A ``time_range`` whose ``since`` is the 1st and ``until`` is the
         last day of the same, past month (歷史花費 / custom 整月).
      2. ``date_preset=last_month`` — the previous calendar month, which
         is always complete and in the past (date picker「上個月」).
    Everything else (this_month / today / yesterday / last_7d|30d|90d) is
    partial or rolling → None → live.

    「過去月份」不是月份一翻頁就算:上個月要過了結算緩衝期
    (_latest_snapshotable_month) 才回傳,不然 1~2 號的 lazy-fill 會把
    FB 還沒回補完的數字永久凍結進 account_month_snapshots。"""
    if time_range:
        try:
            tr = json.loads(time_range)
            sy, sm, sd = (int(x) for x in str(tr.get("since") or "").split("-"))
            uy, um, ud = (int(x) for x in str(tr.get("until") or "").split("-"))
        except Exception:
            return None
        if sd != 1 or sy != uy or sm != um:
            return None
        nxt = date(uy + 1, 1, 1) if um == 12 else date(uy, um + 1, 1)
        if ud != (nxt - timedelta(days=1)).day:
            return None
        month = f"{sy:04d}-{sm:02d}"
        return month if month <= _latest_snapshotable_month() else None
    if (date_preset or "") == "last_month":
        tz = _scheduler_tz()
        today = datetime.now(timezone.utc).astimezone(tz).date()
        prev = date(today.year, today.month, 1) - timedelta(days=1)
        month = f"{prev.year:04d}-{prev.month:02d}"
        return month if month <= _latest_snapshotable_month() else None
    return None


async def _overview_snapshot_read(
    account_id: str, month: str, include_archived: bool, include_adsets: bool
) -> Optional[dict]:
    """Return a stored {"campaigns", "insights"} bundle for a complete
    past month, or None. Failures fall back to None (→ live fetch)."""
    if _db_pool is None:
        return None
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT payload FROM account_month_snapshots "
                "WHERE account_id=$1 AND month=$2 AND include_archived=$3 AND include_adsets=$4",
                account_id, month, include_archived, include_adsets,
            )
    except Exception:
        return None
    if not row:
        return None
    payload = row["payload"]
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            return None
    return payload if isinstance(payload, dict) else None


async def _overview_snapshot_store(
    account_id: str,
    month: str,
    include_archived: bool,
    include_adsets: bool,
    campaigns: list,
    insights: Optional[dict],
) -> None:
    """Cache a complete-past-month overview bundle. Best-effort: any DB
    error is swallowed so the live response is never affected."""
    if _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO account_month_snapshots
                    (account_id, month, include_archived, include_adsets, payload, captured_at)
                VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
                ON CONFLICT (account_id, month, include_archived, include_adsets)
                DO UPDATE SET payload = EXCLUDED.payload, captured_at = NOW()
                """,
                account_id, month, include_archived, include_adsets,
                json.dumps({"campaigns": campaigns, "insights": insights}, ensure_ascii=False),
            )
    except Exception as e:
        print(f"[overview-snapshot] store {account_id} {month} failed: {e}", flush=True)


@app.get("/api/overview")
async def get_overview(
    ids: str = Query(..., description="Comma-separated account ids (e.g. 'act_1,act_2')"),
    date_preset: str = "last_30d",
    time_range: Optional[str] = None,
    include_archived: bool = False,
    lite: bool = False,
    include_adsets: bool = False,
    force: bool = False,
):
    """Batch multi-account overview endpoint.

    Fetches campaigns + insights for *every* account in ``ids``
    concurrently on the backend via ``asyncio.gather`` and returns
    them in a single response. This consolidates what would otherwise
    be ``2 × N`` parallel browser requests (one campaigns call + one
    insights call per account) into a single client round-trip,
    completely bypassing the 6-connection-per-origin HTTP/1.1 limit
    that was the real bottleneck on Analytics / Alerts / Finance
    first-load — the slowest-account tail no longer queues behind
    other requests on the browser side, only on the backend-to-FB
    leg (where there's no 6-connection cap).

    Response shape::

        {
          "data": {
            "act_1": {
              "campaigns": [...],
              "insights": {...} | null,   # flat first entry
              "error": null | "message"
            },
            "act_2": {...}
          }
        }

    Per-account errors are captured (not raised) so one bad account
    doesn't blow up the whole batch — the caller can render partial
    data and surface errors inline.
    """
    account_ids = [aid.strip() for aid in ids.split(",") if aid.strip()]
    if not account_ids:
        return {"data": {}}

    # When the requested range is a complete PAST calendar month, serve
    # it from (and lazily fill) a DB snapshot instead of FB — past months
    # are immutable, so 歷史花費 / 月報表型頁面 load instantly without
    # burning FB rate limit. None → live path (current month / rolling).
    snap_month = _overview_snapshot_month(date_preset, time_range)

    async def _fetch_one(aid: str):
        """Campaigns + insights for one account in parallel. Sub-fetch
        failures are captured as an ``error`` string so the outer
        gather always resolves cleanly.

        In ``lite`` mode, only campaign metadata is fetched (no insights)
        so the frontend can show campaign rows within ~1-2s. The full
        data follows from a parallel non-lite request.
        """
        if not lite and snap_month is not None and not force:
            cached = await _overview_snapshot_read(
                aid, snap_month, include_archived, include_adsets
            )
            if cached is not None:
                return aid, {
                    "campaigns": cached.get("campaigns") or [],
                    "insights": cached.get("insights"),
                    "error": None,
                }
        camps_task = asyncio.create_task(
            _fetch_campaigns_for_account(
                aid, date_preset, time_range, include_archived,
                lite=lite, include_adsets=include_adsets,
            )
        )
        if lite:
            # Lite mode: skip the insights call entirely for speed.
            try:
                camps = await camps_task
            except (HTTPException, Exception) as e:
                detail = e.detail if isinstance(e, HTTPException) else str(e)
                return aid, {"campaigns": [], "insights": None, "error": f"campaigns: {detail}"}
            return aid, {"campaigns": camps, "insights": None, "error": None}

        ins_task = asyncio.create_task(
            _fetch_account_insights(aid, date_preset, time_range)
        )
        await asyncio.gather(camps_task, ins_task, return_exceptions=True)

        error_parts: list[str] = []
        camps: List[dict] = []
        ins_flat: Optional[dict] = None

        camps_exc = camps_task.exception()
        if camps_exc is not None:
            detail = (
                camps_exc.detail if isinstance(camps_exc, HTTPException) else str(camps_exc)
            )
            error_parts.append(f"campaigns: {detail}")
        else:
            camps = camps_task.result()

        ins_exc = ins_task.exception()
        if ins_exc is not None:
            detail = (
                ins_exc.detail if isinstance(ins_exc, HTTPException) else str(ins_exc)
            )
            error_parts.append(f"insights: {detail}")
        else:
            raw = ins_task.result()
            items = raw.get("data") or [] if isinstance(raw, dict) else []
            ins_flat = items[0] if items else None

        # Cache a complete past month once fetched cleanly (no error) so
        # the next view of it serves from DB instead of FB. Empty result
        # is cached too — a past month with no campaigns is final.
        if snap_month is not None and not error_parts:
            await _overview_snapshot_store(
                aid, snap_month, include_archived, include_adsets, camps, ins_flat
            )

        return aid, {
            "campaigns": camps,
            "insights": ins_flat,
            "error": "; ".join(error_parts) if error_parts else None,
        }

    # Outer gather is bounded: a dashboard may have 80 accounts selected,
    # and each account can need campaigns + insights. Creating 160 live FB
    # attempts at once leaves all throttling to the low-level semaphore and
    # still creates a burst. Keep account-level concurrency modest so the
    # request is paced before it reaches Graph.
    overview_sem = asyncio.Semaphore(_OVERVIEW_ACCOUNT_CONCURRENCY)

    async def _fetch_one_bounded(aid: str):
        try:
            async with overview_sem:
                return await asyncio.wait_for(_fetch_one(aid), timeout=30.0)
        except asyncio.TimeoutError:
            return aid, {
                "campaigns": [],
                "insights": None,
                "error": "timeout: account took more than 30s",
            }

    results = await asyncio.gather(*[_fetch_one_bounded(aid) for aid in account_ids])
    return {"data": dict(results)}


# ── LINE push scheduler ───────────────────────────────────────
#
# Persistence model:
#   - `line_groups`  : (group_id, label, joined_at, left_at)
#   - `campaign_line_push_configs`
#   - `line_push_logs`
#
# Flow:
#   1. LINE bot added to a group → LINE sends `join` webhook
#      → /api/line/webhook upserts line_groups row
#   2. User opens LinePushModal on a campaign row, picks a group
#      + frequency + time → POST /api/line-push/configs
#   3. Scheduler loop (_scheduler_loop) ticks every 60s, selects
#      rows with next_run_at <= now AND enabled, pushes a Flex
#      Message via line_client.line_push(), advances next_run_at
#   4. 3 consecutive failures flip `enabled=false` so a broken
#      token / revoked group doesn't keep retrying forever

FREQUENCY_DAILY = "daily"
FREQUENCY_WEEKLY = "weekly"
FREQUENCY_BIWEEKLY = "biweekly"
FREQUENCY_MONTHLY = "monthly"
_VALID_FREQUENCIES = {
    FREQUENCY_DAILY,
    FREQUENCY_WEEKLY,
    FREQUENCY_BIWEEKLY,
    FREQUENCY_MONTHLY,
}
_VALID_DATE_RANGES = {
    "yesterday",
    "last_7d",
    "last_14d",
    "last_30d",
    "this_month",
    "month_to_yesterday",
    "custom",
}


def _compute_next_run(
    frequency: str,
    weekdays: List[int],
    month_day: Optional[int],
    hour: int,
    minute: int,
    *,
    after: Optional[datetime] = None,
) -> datetime:
    """Return the next run timestamp (UTC) strictly after `after`.

    All scheduling is expressed in the user's local timezone
    (`SCHEDULER_TZ`, default Asia/Taipei). We compute the next
    matching local datetime then convert back to UTC for storage.
    """
    tz = _scheduler_tz()
    now_local = (after or datetime.now(timezone.utc)).astimezone(tz)

    def at(d: datetime) -> datetime:
        return d.replace(hour=hour, minute=minute, second=0, microsecond=0)

    if frequency == FREQUENCY_DAILY:
        candidate = at(now_local)
        if candidate <= now_local:
            candidate = at(now_local + timedelta(days=1))
        return candidate.astimezone(timezone.utc)

    if frequency == FREQUENCY_WEEKLY:
        # Python weekday(): Monday=0..Sunday=6. We store 0=Sunday..6=Saturday
        # to match JS `Date.getDay()`, so translate.
        wanted = set(weekdays or [])
        if not wanted:
            # Fall back to daily to avoid an infinite loop.
            return _compute_next_run(FREQUENCY_DAILY, [], None, hour, minute, after=after)
        for offset in range(0, 8):
            probe = now_local + timedelta(days=offset)
            py_dow = probe.weekday()  # Mon=0
            js_dow = (py_dow + 1) % 7  # Sun=0
            if js_dow not in wanted:
                continue
            candidate = at(probe)
            if candidate > now_local:
                return candidate.astimezone(timezone.utc)
        # Unreachable — 8 days is >= 1 full week.
        return (now_local + timedelta(days=7)).astimezone(timezone.utc)

    if frequency == FREQUENCY_BIWEEKLY:
        # Same weekday selection as WEEKLY, but only fires on even ISO
        # weeks. The choice of "even week" as the anchor is arbitrary
        # but stable — every config in the system fires on the same
        # cadence so operators can reason about it consistently.
        wanted = set(weekdays or [])
        if not wanted:
            return _compute_next_run(FREQUENCY_DAILY, [], None, hour, minute, after=after)
        # Search up to 21 days — guarantees we hit at least one even
        # ISO week × matching weekday × time-of-day combo.
        for offset in range(0, 22):
            probe = now_local + timedelta(days=offset)
            py_dow = probe.weekday()
            js_dow = (py_dow + 1) % 7
            if js_dow not in wanted:
                continue
            iso_week = probe.isocalendar()[1]
            if iso_week % 2 != 0:
                continue
            candidate = at(probe)
            if candidate > now_local:
                return candidate.astimezone(timezone.utc)
        return (now_local + timedelta(days=14)).astimezone(timezone.utc)

    if frequency == FREQUENCY_MONTHLY:
        day = max(1, min(28, month_day or 1))
        year, month = now_local.year, now_local.month
        for _ in range(2):
            candidate = now_local.replace(
                year=year, month=month, day=day,
                hour=hour, minute=minute, second=0, microsecond=0,
            )
            if candidate > now_local:
                return candidate.astimezone(timezone.utc)
            month += 1
            if month > 12:
                month = 1
                year += 1
        # Unreachable — 2 months ahead always beats `now`.
        return (now_local + timedelta(days=31)).astimezone(timezone.utc)

    raise HTTPException(status_code=400, detail=f"Unknown frequency: {frequency}")


def _coerce_date(v: Any) -> Any:
    """Accept date / datetime / ISO string / None → return a date or None.

    Helpers like `_date_range_to_preset` are called with values pulled
    from both Pydantic payloads (str) and asyncpg row dicts already
    serialised by `_config_row_to_dict` (also str via .isoformat()) AND
    raw asyncpg.Record values (date). Normalise here so the helpers
    don't have to care which path the value came from.
    """
    if v is None:
        return None
    if hasattr(v, "month"):  # date / datetime
        return v
    try:
        return datetime.fromisoformat(str(v)).date()
    except (TypeError, ValueError):
        return None


def _month_to_yesterday_bounds() -> tuple[Any, Any]:
    """Return (since, until) date objects for 本月1日 → 昨日 in SCHEDULER_TZ.

    Edge case: when today is the 1st of the month, "本月1日 → 昨日" has
    no in-month yesterday. We clamp until = today so the FB query stays
    valid (a 0-day range covering today only).
    """
    tz = _scheduler_tz()
    today = datetime.now(tz).date()
    if today.day == 1:
        return (today, today)
    return (today.replace(day=1), today - timedelta(days=1))


def _date_range_to_preset(
    date_range: str,
    date_from: Any = None,
    date_to: Any = None,
) -> tuple[str, Optional[str]]:
    """Map the UI's date_range choice to FB insights (date_preset, time_range).

    `custom` reads date_from / date_to (Python date or ISO string).
    """
    if date_range == "yesterday":
        return ("yesterday", None)
    if date_range == "last_7d":
        return ("last_7d", None)
    if date_range == "last_14d":
        return ("last_14d", None)
    if date_range == "last_30d":
        return ("last_30d", None)
    if date_range == "this_month":
        return ("this_month", None)
    if date_range == "month_to_yesterday":
        since, until = _month_to_yesterday_bounds()
        tr = _json.dumps(
            {"since": since.isoformat(), "until": until.isoformat()},
            separators=(",", ":"),
        )
        return ("last_30d", tr)
    if date_range == "custom" and date_from and date_to:
        s = _coerce_date(date_from)
        u = _coerce_date(date_to)
        if s is None or u is None:
            return ("last_7d", None)
        tr = _json.dumps(
            {"since": s.isoformat(), "until": u.isoformat()},
            separators=(",", ":"),
        )
        return ("last_30d", tr)
    return ("last_7d", None)


def _date_range_label(
    date_range: str,
    date_from: Any = None,
    date_to: Any = None,
) -> str:
    if date_range == "month_to_yesterday":
        since, until = _month_to_yesterday_bounds()
        return f"本月1日-昨日 ({since.month}/{since.day}-{until.month}/{until.day})"
    if date_range == "custom":
        s = _coerce_date(date_from)
        u = _coerce_date(date_to)
        if s and u:
            return f"自訂 ({s.month}/{s.day}-{u.month}/{u.day})"
        return "自訂"
    return {
        "yesterday": "昨日",
        "last_7d": "過去 7 天",
        "last_14d": "過去 14 天",
        "last_30d": "過去 30 天",
        "this_month": "本月",
    }.get(date_range, date_range)


def _extract_msg_count(actions: Any) -> int:
    """Mirror of frontend getMsgCount — first-found wins."""
    if not isinstance(actions, list):
        return 0
    keys = (
        "onsite_conversion.messaging_conversation_started_7d",
        "messaging_conversation_started_7d",
    )
    for k in keys:
        for a in actions:
            if isinstance(a, dict) and a.get("action_type") == k:
                try:
                    return int(float(a.get("value", 0)))
                except (TypeError, ValueError):
                    return 0
    return 0


def _extract_action_value(items: Any, candidate_types: tuple[str, ...]) -> float:
    """Pick the first matching action_type from an actions[]-shaped list
    and return its .value as float. Works for `actions` (counts),
    `cost_per_action_type` (per-action cost), and `purchase_roas` /
    `website_purchase_roas` (ratio). Returns 0.0 when nothing matches."""
    if not isinstance(items, list):
        return 0.0
    for k in candidate_types:
        for a in items:
            if isinstance(a, dict) and a.get("action_type") == k:
                try:
                    return float(a.get("value", 0))
                except (TypeError, ValueError):
                    return 0.0
    return 0.0


_PURCHASE_ACTION_TYPES = (
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "purchase",
)
_ATC_ACTION_TYPES = (
    "omni_add_to_cart",
    "offsite_conversion.fb_pixel_add_to_cart",
    "add_to_cart",
)


def _fmt_money(v: Any) -> str:
    try:
        n = float(v or 0)
    except (TypeError, ValueError):
        return "—"
    return f"${n:,.0f}"


def _fmt_int(v: Any) -> str:
    try:
        n = int(float(v or 0))
    except (TypeError, ValueError):
        return "—"
    return f"{n:,}"


def _fmt_pct(v: Any) -> str:
    try:
        n = float(v or 0)
    except (TypeError, ValueError):
        return "—"
    return f"{n:.2f}%"


def _date_range_concrete(
    date_range: str,
    date_from: Any = None,
    date_to: Any = None,
) -> str:
    """Concrete `M/D - M/D` (or single `M/D`) string for the given range,
    in SCHEDULER_TZ. Used for the LINE flex report header subtitle so
    recipients see the exact reporting window."""
    bounds = _date_range_iso_bounds(date_range, date_from, date_to)
    if bounds is None:
        return ""
    s, u = bounds
    if s == u:
        return f"{s.month}/{s.day}"
    return f"{s.month}/{s.day} - {u.month}/{u.day}"


def _date_range_iso_bounds(
    date_range: str,
    date_from: Any = None,
    date_to: Any = None,
) -> Optional[tuple[date, date]]:
    """Return concrete (since, until) date objects in SCHEDULER_TZ for any
    date_range value the LINE push UI can produce. Used both by the
    Chinese-label helper above and by the share-URL builder so the
    public `/r/<campaign_id>` page receives the exact reporting window
    the push covered (instead of a lossy preset like
    month_to_yesterday → this_month, which silently shifts the cutoff
    and confuses recipients)."""
    tz = _scheduler_tz()
    today = datetime.now(tz).date()
    if date_range == "yesterday":
        d = today - timedelta(days=1)
        return (d, d)
    if date_range == "this_month":
        return (today.replace(day=1), today)
    if date_range == "month_to_yesterday":
        return _month_to_yesterday_bounds()
    if date_range == "custom":
        s = _coerce_date(date_from)
        u = _coerce_date(date_to)
        if s and u:
            return (s, u)
        return None
    days = {"last_7d": 7, "last_14d": 14, "last_30d": 30}.get(date_range)
    if days is not None:
        since = today - timedelta(days=days)
        until = today - timedelta(days=1)
        return (since, until)
    return None


# ── LINE channel helpers (multi-OA) ───────────────────────────
#
# Every push or summary call needs the right (channel_secret,
# access_token) pair, picked by the group's `channel_id`. These
# helpers centralise the lookup so call sites don't all carry the
# same JOIN / fallback logic.


async def _channel_creds_by_id(channel_id: str) -> Optional[tuple[str, str, str]]:
    """Return (id, channel_secret, access_token) for one channel, or None."""
    if _db_pool is None:
        return None
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, channel_secret, access_token FROM line_channels WHERE id = $1::uuid AND enabled",
            channel_id,
        )
    if row is None:
        return None
    return str(row["id"]), row["channel_secret"], row["access_token"]


async def _default_channel_creds() -> Optional[tuple[str, str, str]]:
    """Return (id, secret, access_token) for the default channel."""
    if _db_pool is None:
        return None
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, channel_secret, access_token FROM line_channels WHERE is_default AND enabled LIMIT 1"
        )
    if row is None:
        return None
    return str(row["id"]), row["channel_secret"], row["access_token"]


async def _channel_role_for_user(channel_id: str, uid: str) -> Optional[str]:
    """Return the caller's relationship to a LINE channel:
       'owner'  → owns the channel
       'shared' → has an accepted grant
       None     → neither (no access)

    Used by the per-channel auth gates so both owners AND accepted-
    grant users can read / manage the channel's groups + push configs.
    Roles returned:
      - 'owner'  → full control (channel CRUD + grants)
      - 'admin'  → accepted grant with role=admin (manage groups + configs)
      - 'viewer' → accepted grant with role=viewer (read-only)
      - None     → no access
    Only owners can transfer / delete / share-invite — gated separately
    in the relevant endpoints."""
    if _db_pool is None or not channel_id or not uid:
        return None
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT c.owner_fb_user_id,
                   COALESCE(g.status, '') AS grant_status,
                   COALESCE(g.role, 'admin') AS grant_role
            FROM line_channels c
            LEFT JOIN line_channel_grants g
                ON g.channel_id = c.id AND g.fb_user_id = $2
            WHERE c.id = $1::uuid
            """,
            channel_id,
            uid,
        )
    if row is None:
        return None
    if row["owner_fb_user_id"] == uid:
        return "owner"
    if row["grant_status"] == "accepted":
        r = row["grant_role"]
        return "viewer" if r == "viewer" else "admin"
    return None


async def _assert_can_modify_config_for_group(group_id: str, fb_user_id: Optional[str]) -> None:
    """Authorize a config write (create/update/delete/test) on this group.

    Rule (Phase B — sharing):
      - Caller must own the channel the group is bound to, OR have an
        accepted grant with role='admin'. Viewers (role='viewer') can
        READ configs via the list endpoints but get 403 here.
      - Orphan channels (owner_fb_user_id IS NULL, legacy seeded data)
        cannot be modified by anyone — set ADMIN_FB_USER_ID env to
        claim them at startup.
    """
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT c.id AS channel_id, c.owner_fb_user_id,
                   COALESCE(gr.status, '') AS grant_status,
                   COALESCE(gr.role, 'admin') AS grant_role
            FROM line_groups g
            LEFT JOIN line_channels c ON c.id = g.channel_id
            LEFT JOIN line_channel_grants gr
                ON gr.channel_id = c.id AND gr.fb_user_id = $2
            WHERE g.group_id = $1
            """,
            group_id,
            uid,
        )
    if row is None or row["channel_id"] is None:
        raise HTTPException(status_code=404, detail="Group not found")
    owner = row["owner_fb_user_id"]
    if owner is None:
        raise HTTPException(
            status_code=403,
            detail="此群組綁定的官方帳號沒有擁有者(舊資料);請設 ADMIN_FB_USER_ID 認領後再操作",
        )
    if owner == uid:
        return
    if row["grant_status"] == "accepted":
        if row["grant_role"] == "viewer":
            raise HTTPException(
                status_code=403,
                detail="你的權限為唯讀,無法修改推播設定。請聯絡此官方帳號擁有者調整權限。",
            )
        return
    raise HTTPException(status_code=403, detail="此推播由其他用戶的官方帳號管理,無權限修改")


async def _channel_creds_for_group(group_id: str) -> Optional[tuple[str, str, str]]:
    """Resolve a group_id to its channel's (id, secret, token).

    Falls back to the default channel if the group's channel_id is NULL
    (legacy rows that haven't been backfilled yet).
    """
    if _db_pool is None:
        return None
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT c.id, c.channel_secret, c.access_token
            FROM line_groups g
            LEFT JOIN line_channels c
                ON c.id = COALESCE(g.channel_id, (SELECT id FROM line_channels WHERE is_default LIMIT 1))
            WHERE g.group_id = $1 AND c.enabled
            """,
            group_id,
        )
    if row is None:
        return None
    return str(row["id"]), row["channel_secret"], row["access_token"]


async def _backfill_line_group_names() -> None:
    """One-shot startup task: pull `groupName` from LINE for any
    `line_groups` rows where the bot is still in the group
    (`left_at IS NULL`) but `group_name` is empty (e.g. joined before
    that column existed). Failures are logged, never raised — this is
    a best-effort backfill.
    """
    if _db_pool is None or _http_client is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT g.group_id, c.access_token
                FROM line_groups g
                LEFT JOIN line_channels c
                    ON c.id = COALESCE(g.channel_id, (SELECT id FROM line_channels WHERE is_default LIMIT 1))
                WHERE g.left_at IS NULL AND COALESCE(g.group_name, '') = ''
                ORDER BY g.joined_at DESC
                """
            )
        if not rows:
            return
        print(
            f"[startup] backfill: {len(rows)} LINE group name(s) to fetch",
            flush=True,
        )

        sem = asyncio.Semaphore(8)

        async def _fetch_one(gid: str, token: str) -> tuple[str, Optional[str]]:
            async with sem:
                try:
                    summary = await line_client.get_group_summary(
                        _http_client, gid, access_token=token or ""
                    )
                except Exception as exc:
                    print(f"[startup] backfill summary failed {gid}: {exc}", flush=True)
                    return gid, None
                if not summary:
                    return gid, None
                return gid, (summary.get("groupName") or "").strip() or None

        results = await asyncio.gather(
            *[_fetch_one(r["group_id"], r["access_token"] or "") for r in rows],
            return_exceptions=False,
        )

        async with _db_pool.acquire() as conn:
            for gid, name in results:
                if not name:
                    continue
                try:
                    await conn.execute(
                        """
                        UPDATE line_groups SET group_name = $1
                        WHERE group_id = $2 AND COALESCE(group_name, '') = ''
                        """,
                        name,
                        gid,
                    )
                    print(f"[startup] backfill: {gid} → {name!r}", flush=True)
                except Exception as exc:
                    print(f"[startup] backfill update failed {gid}: {exc}", flush=True)
        print("[startup] backfill: done", flush=True)
    except Exception as exc:
        print(f"[startup] backfill error: {exc}", flush=True)


_OBJECTIVE_LABELS = {
    "OUTCOME_AWARENESS": "知名度",
    "OUTCOME_TRAFFIC": "流量",
    "OUTCOME_ENGAGEMENT": "互動",
    "OUTCOME_LEADS": "開發潛在顧客",
    "OUTCOME_APP_PROMOTION": "應用程式推廣",
    "OUTCOME_SALES": "銷售業績",
    "BRAND_AWARENESS": "品牌知名度",
    "REACH": "觸及人數",
    "LINK_CLICKS": "連結點擊",
    "VIDEO_VIEWS": "影片觀看",
    "POST_ENGAGEMENT": "貼文互動",
    "PAGE_LIKES": "粉絲專頁讚數",
    "EVENT_RESPONSES": "活動回應",
    "LEAD_GENERATION": "開發潛在顧客",
    "MESSAGES": "訊息",
    "CONVERSIONS": "轉換次數",
    "CATALOG_SALES": "目錄銷售",
    "STORE_VISITS": "來店造訪",
    "APP_INSTALLS": "應用程式安裝",
}

# 流量類目標 — 私訊指標對這些 campaign 是雜訊。對齊 frontend
# `lib/recommendations.ts` 的 TRAFFIC_OBJECTIVES。
_TRAFFIC_OBJECTIVES = {
    "OUTCOME_TRAFFIC",
    "LINK_CLICKS",
    "OUTCOME_AWARENESS",
    "BRAND_AWARENESS",
    "REACH",
    "VIDEO_VIEWS",
    "POST_ENGAGEMENT",
    "PAGE_LIKES",
}


def _translate_objective(raw: Optional[str]) -> str:
    if not raw:
        return ""
    return _OBJECTIVE_LABELS.get(raw, raw)


def _is_traffic_objective(raw: Optional[str]) -> bool:
    return raw is not None and raw in _TRAFFIC_OBJECTIVES


# (優化建議 rule engine `_evaluate_alert_recommendations` removed 2026-07-14 —
# reports and LINE pushes now carry raw numbers only.)

# Map a push-time date_range to a public-share-page DatePreset. Some
# values aren't supported by the share page (last_14d, month_to_yesterday)
# so we fall back to the closest available preset.
_SHARE_DATE_PRESET = {
    "yesterday": "yesterday",
    "last_7d": "last_7d",
    "last_14d": "last_30d",
    "last_30d": "last_30d",
    "this_month": "this_month",
    "month_to_yesterday": "this_month",
}

PUBLIC_SITE_URL = (os.getenv("PUBLIC_SITE_URL") or DEFAULT_PUBLIC_SITE_URL).rstrip("/")


def _security_view_url() -> Optional[str]:
    if not PUBLIC_SITE_URL:
        return None
    return f"{PUBLIC_SITE_URL}/security"


def _share_url_for_config(
    account_id: str,
    campaign_id: str,
    date_range: str,
    date_from: Any = None,
    date_to: Any = None,
    use_spend_plus: bool = False,
    markup_pct: float = 0.0,
    selected_fields: Optional[List[str]] = None,
    report_variant: str = "standard",
) -> Optional[str]:
    """Build the public /r/<campaign_id> share URL when PUBLIC_SITE_URL
    is configured. Returns None otherwise — the caller will simply omit
    the「查看完整報告」 footer button.

    The viewer must see the SAME reporting window as the LINE push that
    delivered the link. Since the share page only natively supports the
    7 standard FB presets (today / yesterday / last_7d / last_30d /
    last_90d / this_month / last_month), date_ranges like
    `month_to_yesterday`, `last_14d`, or `custom` would otherwise be
    silently downgraded to `this_month` / `last_30d` and shift the
    numbers under recipients' eyes. We sidestep that by always
    concretizing to ISO from/to dates and passing them as `from` /
    `to` query params, which the share page reads as a custom range."""
    if not PUBLIC_SITE_URL:
        return None
    from urllib.parse import quote, urlencode

    bounds = _date_range_iso_bounds(date_range, date_from, date_to)
    if bounds is not None:
        s, u = bounds
        params = {"acct": account_id, "from": s.isoformat(), "to": u.isoformat()}
    else:
        # Fallback for unknown date_range values — preserves the legacy
        # preset behaviour so old links keep working.
        preset = _SHARE_DATE_PRESET.get(date_range, "this_month")
        params = {"acct": account_id, "date": preset}
    # Mirror the spend / spend_plus selection. The push config picks
    # one (mutex pair in the report-fields multi-select); when
    # spend_plus is chosen we forward both the flag and the markup so
    # the share page renders the same「花費*」amount the LINE flex
    # showed instead of the raw spend.
    if use_spend_plus and markup_pct > 0:
        params["plus"] = "1"
        params["mkp"] = f"{markup_pct:g}"
    # Mirror the report_fields selection so the share page's KPI grid
    # only renders the cells the LINE flex showed (in the same order).
    # Empty / None → omit the param so the share page falls back to
    # its legacy "show everything" layout for non-push share links.
    if selected_fields:
        params["fields"] = ",".join(selected_fields)
    # 報告版本:'perf' → 以廣告報告(素材成效);其餘 → 標準的以廣告組合報告。
    if report_variant == "perf":
        params["report"] = "perf"
    qs = urlencode(params)
    return f"{PUBLIC_SITE_URL}/r/{quote(campaign_id, safe='')}?{qs}"


# (_snapshot_url_for_push removed 2026-07-14 — the LINE push report button
# links to the LIVE share page; frozen snapshots are generated only by the
# dashboard's manual 生成報告 flow via POST /api/report-snapshots.)


async def _campaign_nickname_display(campaign_id: str) -> str:
    """Return "店家 · 設計師" / 店家 / 設計師 if either is set, else ''.

    Mirrors the frontend's `formatNickname()` so flex messages match
    what operators see in the Finance view.
    """
    if _db_pool is None:
        return ""
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT store, designer FROM campaign_nicknames WHERE campaign_id = $1",
            campaign_id,
        )
    if not row:
        return ""
    store = (row["store"] or "").strip()
    designer = (row["designer"] or "").strip()
    if store and designer:
        return f"{store} · {designer}"
    return store or designer


async def _markup_for_campaign(campaign_id: str) -> float:
    """Resolve the markup % for a campaign — per-row override (set in
    費用中心) wins over the team-wide default. Returns 0 when no DB
    or no settings exist (i.e. spend_plus == spend).
    """
    if _db_pool is None:
        return 0.0
    try:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM shared_settings WHERE key = ANY($1)",
                ["finance_row_markups", "finance_default_markup"],
            )
    except Exception:
        return 0.0
    row_markups: dict = {}
    default_markup: float = 0.0
    for r in rows:
        v = r["value"]
        if isinstance(v, str):
            try:
                v = _json.loads(v)
            except Exception:
                continue
        if r["key"] == "finance_row_markups" and isinstance(v, dict):
            row_markups = v
        elif r["key"] == "finance_default_markup":
            try:
                default_markup = float(v)
            except (TypeError, ValueError):
                pass
    per_row = row_markups.get(campaign_id)
    if per_row is not None:
        try:
            return float(per_row)
        except (TypeError, ValueError):
            return default_markup
    return default_markup


def _kpis_from_insights(
    ins: dict,
    *,
    traffic_mode: bool,
    selected: list[str],
    markup_pct: float,
) -> tuple[list[tuple[str, str]], dict]:
    """Convert one FB insights row into (kpis, raw_inputs).

    `kpis` is the ordered list of (label, formatted_value) tuples for
    the Flex body; `raw_inputs` carries the extracted scalars (spend /
    msgs / cpc / ...) for callers that need the raw numbers.

    Used for BOTH the campaign-level single-bubble path AND the
    per-adset carousel path. The only thing that changes between the
    two is the source `ins` dict; everything downstream — rule
    thresholds, field catalog, spend_plus markup — is identical."""
    try:
        spend_f = float(ins.get("spend") or 0)
    except (TypeError, ValueError):
        spend_f = 0.0
    try:
        cpc_f = float(ins.get("cpc") or 0)
    except (TypeError, ValueError):
        cpc_f = 0.0
    try:
        freq_f = float(ins.get("frequency") or 0)
    except (TypeError, ValueError):
        freq_f = 0.0
    msgs = _extract_msg_count(ins.get("actions"))
    msg_cost_f = (spend_f / msgs) if msgs > 0 else 0.0

    actions_arr = ins.get("actions") or []
    cost_per_action_arr = ins.get("cost_per_action_type") or []
    purchases_n = int(_extract_action_value(actions_arr, _PURCHASE_ACTION_TYPES))
    atc_n = int(_extract_action_value(actions_arr, _ATC_ACTION_TYPES))
    cost_per_purchase_f = _extract_action_value(cost_per_action_arr, _PURCHASE_ACTION_TYPES)
    cost_per_atc_f = _extract_action_value(cost_per_action_arr, _ATC_ACTION_TYPES)
    try:
        link_clicks_n = int(float(ins.get("inline_link_clicks") or 0))
    except (TypeError, ValueError):
        link_clicks_n = 0
    try:
        cost_per_link_click_f = float(ins.get("cost_per_inline_link_click") or 0)
    except (TypeError, ValueError):
        cost_per_link_click_f = 0.0
    roas_arr = ins.get("purchase_roas") or ins.get("website_purchase_roas") or []
    roas_f = _extract_action_value(roas_arr, _PURCHASE_ACTION_TYPES)

    spend_plus_f = math.ceil(spend_f * (1 + markup_pct / 100)) if spend_f > 0 else 0.0
    msg_cost_str = _fmt_money(msg_cost_f) if msgs > 0 else "—"
    msgs_str = _fmt_int(msgs) if msgs > 0 else "—"
    catalog: dict[str, tuple[str, str]] = {
        "spend": ("花費", _fmt_money(spend_f)),
        "spend_plus": ("花費*", _fmt_money(spend_plus_f)),
        "impressions": ("曝光", _fmt_int(ins.get("impressions"))),
        "clicks": ("點擊", _fmt_int(ins.get("clicks"))),
        "ctr": ("CTR", _fmt_pct(ins.get("ctr"))),
        "cpc": ("CPC", _fmt_money(cpc_f)),
        "cpm": ("CPM", _fmt_money(ins.get("cpm"))),
        "frequency": ("頻次", f"{freq_f:.2f}" if freq_f else "—"),
        "reach": ("觸及", _fmt_int(ins.get("reach"))),
        "msgs": ("私訊數", msgs_str),
        "msg_cost": ("私訊成本", msg_cost_str),
        "link_clicks": (
            "連結點擊",
            _fmt_int(link_clicks_n) if link_clicks_n > 0 else "—",
        ),
        "cost_per_link_click": (
            "連結點擊成本",
            _fmt_money(cost_per_link_click_f) if cost_per_link_click_f > 0 else "—",
        ),
        "add_to_cart": (
            "加入購物車",
            _fmt_int(atc_n) if atc_n > 0 else "—",
        ),
        "cost_per_add_to_cart": (
            "加入購物車成本",
            _fmt_money(cost_per_atc_f) if cost_per_atc_f > 0 else "—",
        ),
        "purchases": (
            "購買數",
            _fmt_int(purchases_n) if purchases_n > 0 else "—",
        ),
        "cost_per_purchase": (
            "購買成本",
            _fmt_money(cost_per_purchase_f) if cost_per_purchase_f > 0 else "—",
        ),
        "roas": (
            "ROAS",
            f"{roas_f:.2f}" if roas_f > 0 else "—",
        ),
    }
    if selected:
        kpis = [catalog[c] for c in selected if c in catalog]
    else:
        default_codes = ["spend", "impressions", "clicks", "ctr", "cpc"]
        if not traffic_mode:
            default_codes += ["msgs", "msg_cost"]
        kpis = [catalog[c] for c in default_codes]

    return kpis, {
        "spend": spend_f,
        "msgs": msgs,
        "msg_cost": msg_cost_f,
        "cpc": cpc_f,
        "frequency": freq_f,
        "purchases": purchases_n,
        "cost_per_purchase": cost_per_purchase_f,
        "roas": roas_f,
        "add_to_cart": atc_n,
        "cost_per_add_to_cart": cost_per_atc_f,
        "link_clicks": link_clicks_n,
        "cost_per_link_click": cost_per_link_click_f,
    }


def _entity_status_chip(entity: dict) -> "tuple[str, str]":
    """(label, hex color) for the flex header status chip. Works for
    any FB entity carrying `status` (campaign / adset / ad).

    For PAUSED the label is prefixed with M/D parsed from
    `updated_time` when present (FB doesn't expose a dedicated
    paused-at timestamp without the Activity Log endpoint, but
    updated_time is the last modification — close enough for
    "paused since").
    """
    status_raw = (entity.get("status") or "").upper()
    status_color_map = {
        "ACTIVE": "#16A34A",   # green
        "PAUSED": "#DC2626",   # red
        "ARCHIVED": "#888888", # grey
        "DELETED": "#888888",  # grey
    }
    status_label_map = {
        "ACTIVE": "進行中",
        "PAUSED": "已暫停",
        "ARCHIVED": "已封存",
        "DELETED": "已刪除",
    }
    status_label = status_label_map.get(status_raw, status_raw or "")
    status_color = status_color_map.get(status_raw, "#888888")
    if status_raw == "PAUSED":
        updated_raw = entity.get("updated_time") or ""
        try:
            # FB returns "2026-04-12T08:30:00+0000" — parse to local M/D
            dt = datetime.fromisoformat(updated_raw.replace("+0000", "+00:00"))
            status_label = f"{dt.month}/{dt.day} {status_label}"
        except (TypeError, ValueError):
            pass
    return status_label, status_color


async def _build_flex_for_config(cfg: dict) -> dict:
    """Produce the LINE Flex Message for one push config row.

    Hits FB's per-campaign Graph endpoint directly (`GET /{campaign_id}`)
    instead of `_fetch_campaigns_for_account` which would page through
    every campaign on the account just to pick one — that fan-out is
    the dominant latency in the manual「測試」button (5–15 s for big
    accounts). Single-campaign lookup is one HTTP round-trip and
    completes in well under a second.

    When `cfg["adset_ids"]` is non-empty, the push reports per-adset:
    one Flex carousel bubble per selected adset, KPI scoped to that
    adset's own insights, bubble title = adset name.

    When `cfg["ad_ids"]` is non-empty (以廣告播報), same carousel shape
    but one bubble per selected AD (3rd level) — the FB request is
    identical (`GET /{ad_id}?fields=id,name,status,insights...`), so
    both modes share the member loop below. Mutually exclusive with
    adset_ids (enforced at save time).
    """
    account_id = cfg["account_id"]
    campaign_id = cfg["campaign_id"]
    date_range = cfg["date_range"]
    date_from = cfg.get("date_from")
    date_to = cfg.get("date_to")
    date_preset, time_range = _date_range_to_preset(date_range, date_from, date_to)

    # Campaign KPIs: fetch metadata + insights SEPARATELY. The numbers
    # come from the campaign's `/insights` EDGE (the same canonical path
    # the dashboard uses via act_xxx/insights?level=campaign) instead of
    # field-expanding `insights` on the campaign node. Field-expansion
    # can return an EMPTY insights row for some campaigns (awareness
    # objectives / certain delivery structures) even when they clearly
    # spent — the bug where a LINE card showed 花費 $0 while the
    # dashboard showed real spend for the SAME campaign + window. The
    # edge keeps the two surfaces in lock-step.
    meta_fields = "id,name,status,objective,daily_budget,lifetime_budget,updated_time"
    try:
        camp, ins = await asyncio.gather(
            fb_get(campaign_id, {"fields": meta_fields}),
            _fetch_single_entity_insights(campaign_id, date_preset, time_range),
        )
    except HTTPException:
        # Metadata call failed — fall back to the account-wide path,
        # which pulls metadata AND insights via the bulk /insights edge
        # (so the numbers still match the dashboard).
        campaigns = await _fetch_campaigns_for_account(
            account_id, date_preset, time_range,
            include_archived=True, lite=False, include_adsets=False,
        )
        camp = next((c for c in campaigns if c.get("id") == campaign_id), None)
        if camp is None:
            raise RuntimeError(f"Campaign {campaign_id} not found under {account_id}")
        ins_list = (camp.get("insights") or {}).get("data") or []
        ins = ins_list[0] if ins_list else {}

    objective = camp.get("objective")
    traffic_mode = _is_traffic_objective(objective)
    objective_label = _translate_objective(objective)

    markup_pct = await _markup_for_campaign(campaign_id)
    selected = list(cfg.get("report_fields") or [])
    kpis, _raw_inputs = _kpis_from_insights(
        ins, traffic_mode=traffic_mode, selected=selected, markup_pct=markup_pct
    )
    # 優化建議 removed (2026-07-14) — flex cards carry raw numbers only.
    # `include_recommendations` stays in the DB/API for row compatibility
    # but is no longer honoured anywhere.
    recommendations = None

    # Title: campaign nickname (store · designer) if set, else FB name.
    nickname = await _campaign_nickname_display(campaign_id)
    title = nickname or camp.get("name", campaign_id)
    concrete_range = _date_range_concrete(date_range, date_from, date_to)
    subtitle = (
        f"報告區間: {concrete_range}"
        if concrete_range
        else _date_range_label(date_range, date_from, date_to)
    )

    # Status chip in header top-right — recipients can tell at a glance
    # whether the entity behind these numbers is still ACTIVE or has
    # been paused / archived.
    status_label, status_color = _entity_status_chip(camp)

    # Footer button is opt-in per config (column added 2026-04-29).
    # Pass date_from / date_to so the share page lands on the same
    # reporting window as the push (custom / month_to_yesterday /
    # last_14d would otherwise be downgraded by _SHARE_DATE_PRESET).
    # spend_plus mirrors the spend / spend_plus mutex pair from
    # report_fields so the share page's「花費」cell shows the same
    # marked-up amount that appeared on the LINE flex (`花費*`).
    selected_codes = list(cfg.get("report_fields") or [])
    use_spend_plus = "spend_plus" in selected_codes
    # Mirror the flex builder's default-fallback so an unconfigured
    # config (empty report_fields) sends the same KPI set to the share
    # page as it shows in the LINE card. Keeps the two surfaces in
    # lock-step without forcing the operator to manually pick fields.
    if selected_codes:
        share_fields = selected_codes
    else:
        share_fields = ["spend", "impressions", "clicks", "ctr", "cpc"]
        if not traffic_mode:
            share_fields += ["msgs", "msg_cost"]
    # Report button links to the LIVE share page (/r/:campaignId, with
    # the reporting window concretized to from/to inside
    # _share_url_for_config). Pushes are inherently periodic — every
    # send covers a fresh window and re-reads FB anyway — so the button
    # simply opens the current numbers. Frozen snapshots (/r/s/:id) are
    # reserved for the dashboard's manual 生成報告 flow (2026-07-14
    # decision; the earlier push-time snapshot generation was removed —
    # it made 測試 slow/504-prone and cluttered 生成紀錄).
    report_variant = str(cfg.get("report_variant") or "standard")
    report_url = (
        _share_url_for_config(
            account_id,
            campaign_id,
            date_range,
            date_from,
            date_to,
            use_spend_plus=use_spend_plus,
            markup_pct=markup_pct,
            selected_fields=share_fields,
            report_variant=report_variant,
        )
        if cfg.get("include_report_button")
        else None
    )

    # Member scoping: adset_ids (以廣告組合播報) or ad_ids (以廣告播報).
    # Mutually exclusive (enforced at save time); the FB request shape
    # is identical for both levels so they share one loop.
    adset_ids = list(cfg.get("adset_ids") or [])
    ad_ids = list(cfg.get("ad_ids") or [])
    member_ids = adset_ids if adset_ids else ad_ids
    member_kind = "adset" if adset_ids else "ad"
    if not member_ids:
        return line_client.build_flex_report(
            title=title,
            subtitle=subtitle,
            objective_label=objective_label,
            status_label=status_label,
            status_color=status_color,
            kpis=kpis,
            recommendations=recommendations,
            report_url=report_url,
            alt_text=f"{title} {concrete_range or _date_range_label(date_range, date_from, date_to)}",
        )

    # Per-member carousel: one bubble per selected adset / ad. Title =
    # member name (campaign name moves into the subtitle as context).
    # Each bubble re-derives KPI from that member's own insights so the
    # numbers are scoped, not pro-rated. Members are fetched in
    # parallel because FB rate-limits per-edge, not per-account.
    # `updated_time` feeds the per-member status chip's「M/D 已暫停」.
    #
    # Metadata + insights are fetched SEPARATELY, with the numbers coming
    # from the member's `/insights` EDGE (same as the campaign-level path
    # above) rather than field-expanding `insights` on the adset/ad node —
    # node-level expansion has the same empty-row failure mode that showed
    # 花費 $0 at campaign level. The edge is level-agnostic, so this keeps
    # adset / ad pushes in lock-step with the dashboard too.
    member_meta_fields = "id,name,status,updated_time"

    async def _fetch_member(mid: str) -> dict:
        meta, ins_row = await asyncio.gather(
            fb_get(mid, {"fields": member_meta_fields}),
            _fetch_single_entity_insights(mid, date_preset, time_range),
        )
        m = dict(meta) if isinstance(meta, dict) else {}
        m["insights"] = {"data": [ins_row]} if ins_row else {"data": []}
        return m

    member_results = await asyncio.gather(
        *[_fetch_member(mid) for mid in member_ids], return_exceptions=True
    )
    bubbles: list[dict] = []
    for mid, res in zip(member_ids, member_results):
        if isinstance(res, BaseException):
            # Skip members that FB can't return — better to ship a
            # partial carousel than to fail the entire push because
            # one adset / ad got archived.
            print(f"[flex] skip {member_kind} {mid}: {res}", flush=True)
            continue
        member_data = res if isinstance(res, dict) else {}
        member_name = member_data.get("name") or mid
        member_ins_list = (member_data.get("insights") or {}).get("data") or []
        member_ins = member_ins_list[0] if member_ins_list else {}
        member_kpis, _member_raw = _kpis_from_insights(
            member_ins, traffic_mode=traffic_mode, selected=selected, markup_pct=markup_pct
        )
        member_recs = None  # 優化建議 removed (2026-07-14)
        # Each bubble shows ITS OWN entity's status — a paused ad must
        # render「已暫停」even when the parent campaign is still ACTIVE
        # (using the campaign chip here was the bug where a paused ad
        # showed a green 進行中 chip).
        member_status_label, member_status_color = _entity_status_chip(member_data)
        bubbles.append(
            line_client._build_flex_report_bubble(
                title=member_name,
                subtitle=f"{title} · {concrete_range or _date_range_label(date_range, date_from, date_to)}",
                objective_label=objective_label,
                status_label=member_status_label,
                status_color=member_status_color,
                kpis=member_kpis,
                recommendations=member_recs,
                report_url=report_url,
            )
        )
    if not bubbles:
        # All member lookups failed — fall back to the campaign-level
        # bubble rather than raise, so the operator still gets a push.
        return line_client.build_flex_report(
            title=title,
            subtitle=subtitle,
            objective_label=objective_label,
            status_label=status_label,
            status_color=status_color,
            kpis=kpis,
            recommendations=recommendations,
            report_url=report_url,
            alt_text=f"{title} {concrete_range or _date_range_label(date_range, date_from, date_to)}",
        )
    return line_client.build_flex_report_carousel(
        bubbles=bubbles,
        alt_text=f"{title} {concrete_range or _date_range_label(date_range, date_from, date_to)}",
    )


# ── LINE webhook ──────────────────────────────────────────────


async def _handle_line_webhook(request: Request, channel: tuple[str, str, str]) -> dict:
    """Shared webhook handling: verify signature with the channel's
    secret, then upsert line_groups rows tagged with the channel's id.
    """
    channel_id, channel_secret, access_token = channel
    raw = await request.body()
    sig = request.headers.get("X-Line-Signature")
    if not line_client.verify_webhook_signature(raw, sig, secret=channel_secret):
        # Stamp last_webhook_at even on signature failure — this still
        # tells the user "LINE reached us, but the secret is wrong",
        # which is actionable. We use a separate column / flag if we
        # ever need to distinguish; for now just timestamp.
        if _db_pool is not None:
            try:
                async with _db_pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE line_channels SET last_webhook_at = NOW() WHERE id = $1::uuid",
                        channel_id,
                    )
            except Exception:
                pass
        print(f"[line_webhook] 401 invalid signature channel={channel_id}", flush=True)
        raise HTTPException(status_code=401, detail="Invalid signature")

    if _db_pool is None:
        return {"ok": True, "skipped": "no DB"}

    # Stamp the activity timestamp so the UI can show「上次接收: 5 分鐘前」
    # — the visibility cue for "is LINE actually reaching us?".
    try:
        async with _db_pool.acquire() as conn:
            await conn.execute(
                "UPDATE line_channels SET last_webhook_at = NOW() WHERE id = $1::uuid",
                channel_id,
            )
    except Exception:
        pass

    try:
        payload = await request.json()
    except Exception:
        return {"ok": True, "skipped": "non-json body"}

    events = payload.get("events") or []
    async with _db_pool.acquire() as conn:
        for ev in events:
            if not isinstance(ev, dict):
                continue
            etype = ev.get("type")
            source = ev.get("source") or {}
            if source.get("type") != "group":
                continue
            group_id = source.get("groupId")
            if not group_id:
                continue
            if etype == "join":
                group_name = ""
                if _http_client is not None:
                    summary = await line_client.get_group_summary(
                        _http_client, group_id, access_token=access_token
                    )
                    if summary:
                        group_name = (summary.get("groupName") or "").strip()
                await conn.execute(
                    """
                    INSERT INTO line_groups (group_id, group_name, channel_id, joined_at, left_at)
                    VALUES ($1, $2, $3::uuid, NOW(), NULL)
                    ON CONFLICT (group_id) DO UPDATE
                    SET joined_at = NOW(),
                        left_at = NULL,
                        channel_id = EXCLUDED.channel_id,
                        group_name = CASE
                            WHEN EXCLUDED.group_name <> '' THEN EXCLUDED.group_name
                            ELSE line_groups.group_name
                        END
                    """,
                    group_id,
                    group_name,
                    channel_id,
                )
                print(
                    f"[line_webhook] joined group={group_id} name={group_name!r} channel={channel_id}",
                    flush=True,
                )
            elif etype == "leave":
                await conn.execute(
                    "UPDATE line_groups SET left_at = NOW() WHERE group_id = $1",
                    group_id,
                )
                print(f"[line_webhook] left group={group_id} channel={channel_id}", flush=True)
    return {"ok": True}


@app.post("/api/line/webhook")
async def line_webhook_default(request: Request):
    """Legacy webhook URL — routes to the default channel.

    Existing LINE Console setups point at this URL; we keep it as
    an alias so users don't have to update the webhook URL there
    after the multi-channel migration.
    """
    creds = await _default_channel_creds()
    if creds is None:
        raise HTTPException(status_code=503, detail="No default LINE channel configured")
    return await _handle_line_webhook(request, creds)


@app.post("/api/line/webhook/{channel_id}")
async def line_webhook_channel(channel_id: str, request: Request):
    """Per-channel webhook URL — paste this into LINE Developers
    Console for additional Official Accounts. Each OA has its own
    channel_id and verifies signatures with its own secret.
    """
    creds = await _channel_creds_by_id(channel_id)
    if creds is None:
        raise HTTPException(status_code=404, detail="Channel not found or disabled")
    return await _handle_line_webhook(request, creds)


# ── LINE channels (multi-OA) management ───────────────────────


class LineChannelPayload(BaseModel):
    name: str
    channel_secret: str
    access_token: str
    enabled: bool = True
    is_default: bool = False


def _public_channel_url(request: Request, channel_id: str) -> str:
    """Build the public webhook URL the user pastes into LINE Console.

    LINE rejects http:// webhook URLs outright (and won't deliver group
    events even if Verify somehow passes), so we MUST emit https://
    in production. Zeabur terminates TLS at the edge and proxies as
    plain HTTP internally, so request.base_url alone returns http://.
    Honor X-Forwarded-Proto / -Host (set by Zeabur's reverse proxy) to
    reconstruct the externally-visible URL.
    """
    fwd_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    fwd_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip()
    scheme = fwd_proto or request.url.scheme
    host = fwd_host or request.url.netloc
    # Final safety net: anything that's NOT obvious local dev gets
    # promoted to https. Catches edge cases where the reverse proxy
    # forgets to forward the scheme header.
    if scheme == "http" and host and not host.startswith(("localhost", "127.0.0.1", "0.0.0.0")):
        scheme = "https"
    return f"{scheme}://{host}/api/line/webhook/{channel_id}"


@app.get("/api/line-channels")
async def list_line_channels(request: Request, fb_user_id: Optional[str] = None):
    """List LINE Official Accounts visible to the calling FB user.

    Visibility (Phase B sharing model):
      - Channels owned by the caller → `is_owner: true`, full edit
      - Channels granted to the caller and accepted →
        `is_owner: false, is_shared: true` — can manage groups +
        push configs, but can't transfer ownership / delete the OA
      - Orphan channels (`owner_fb_user_id IS NULL`, pre-2026-04-30
        seed/legacy) → shown to ALL users with `is_orphan: true`
        and a「認領」 button (first-come-first-served claim).
      - Other users' private OAs → invisible.
    """
    if _db_pool is None:
        return {"data": []}
    uid = (fb_user_id or "").strip()
    if not uid:
        return {"data": []}
    async with _db_pool.acquire() as conn:
        # LEFT JOIN counts: active group bindings + accepted grants.
        # Visibility = owned OR orphan OR (granted AND accepted).
        rows = await conn.fetch(
            """
            SELECT c.id, c.name, c.channel_secret, c.access_token, c.enabled, c.is_default,
                   c.owner_fb_user_id, c.created_at, c.updated_at, c.last_webhook_at,
                   COALESCE(g.cnt, 0) AS bound_groups_count,
                   COALESCE(gr.shared_count, 0) AS shared_count,
                   COALESCE(gr.pending_count, 0) AS pending_count,
                   COALESCE(my_grant.status, '') AS my_grant_status,
                   COALESCE(my_grant.role, '') AS my_grant_role
            FROM line_channels c
            LEFT JOIN (
                SELECT channel_id, COUNT(*) AS cnt
                FROM line_groups
                WHERE left_at IS NULL
                GROUP BY channel_id
            ) g ON g.channel_id = c.id
            LEFT JOIN (
                SELECT channel_id,
                       COUNT(*) FILTER (WHERE status = 'accepted') AS shared_count,
                       COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
                FROM line_channel_grants
                GROUP BY channel_id
            ) gr ON gr.channel_id = c.id
            LEFT JOIN line_channel_grants my_grant
                ON my_grant.channel_id = c.id AND my_grant.fb_user_id = $1
            WHERE c.owner_fb_user_id = $1
               OR c.owner_fb_user_id IS NULL
               OR (my_grant.fb_user_id = $1 AND my_grant.status = 'accepted')
            ORDER BY
                (c.owner_fb_user_id IS NULL) ASC,
                (c.owner_fb_user_id <> $1) ASC,
                c.is_default DESC,
                c.created_at ASC
            """,
            uid,
        )
    def _mask(s: str) -> str:
        # Compact preview only: 4 dots + last 4 chars. The old
        # "•"*(len-4) version produced 100+ dot mask strings that
        # blew out the card layout for access tokens.
        if not s:
            return ""
        if len(s) <= 4:
            return s
        return "••••" + s[-4:]

    out = []
    for r in rows:
        cid = str(r["id"])
        tok = r["access_token"] or ""
        sec = r["channel_secret"] or ""
        owner = r["owner_fb_user_id"]
        is_orphan = owner is None
        is_owner = owner == uid
        is_shared = (r["my_grant_status"] == "accepted") and not is_owner
        # Resolve caller's role on this channel for downstream UI
        # gating (admin sees write controls, viewer sees read-only).
        if is_owner:
            my_role = "owner"
        elif is_shared:
            my_role = "viewer" if r["my_grant_role"] == "viewer" else "admin"
        else:
            my_role = ""
        out.append(
            {
                "id": cid,
                "name": r["name"],
                "channel_secret_masked": _mask(sec),
                "access_token_masked": _mask(tok),
                "enabled": r["enabled"],
                "is_default": r["is_default"],
                "is_orphan": is_orphan,
                "is_owner": is_owner,
                "is_shared": is_shared,
                "my_role": my_role,
                # `editable`: write access. Owner + admin grantees only.
                # Viewers can READ groups + configs but cannot mutate.
                "editable": is_owner or my_role == "admin",
                "bound_groups_count": int(r["bound_groups_count"] or 0),
                "shared_count": int(r["shared_count"] or 0),
                "pending_count": int(r["pending_count"] or 0),
                "last_webhook_at": r["last_webhook_at"].isoformat() if r["last_webhook_at"] else None,
                "webhook_url": _public_channel_url(request, cid),
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
        )
    return {"data": out}


@app.post("/api/line-channels/{channel_id}/claim")
async def claim_line_channel(channel_id: str, fb_user_id: Optional[str] = None):
    """Take ownership of an orphan channel (one created pre-ownership
    migration, owner_fb_user_id IS NULL). Refuses if the channel
    already has an owner — caller would have to ask the existing
    owner to transfer.
    """
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    # Tier limit gate — claiming an orphan counts toward the cap.
    limits = await _get_user_limits(uid)
    cap = limits["line_channels"]
    if not _is_unlimited(cap):
        current = await _count_line_channels(uid)
        if current >= cap:
            raise _tier_limit_error(
                "line_channels",
                cap,
                limits["tier"],
                f"目前方案最多可連結 {cap} 個 LINE 官方帳號,請升級方案",
            )
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT owner_fb_user_id FROM line_channels WHERE id = $1::uuid",
            channel_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        if row["owner_fb_user_id"] is not None:
            raise HTTPException(status_code=409, detail="此官方帳號已有擁有者")
        await conn.execute(
            "UPDATE line_channels SET owner_fb_user_id = $1, updated_at = NOW() WHERE id = $2::uuid",
            uid,
            channel_id,
        )
    return {"ok": True}


@app.post("/api/line-channels")
async def create_line_channel(payload: LineChannelPayload, fb_user_id: Optional[str] = None):
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    name = (payload.name or "").strip()
    secret = (payload.channel_secret or "").strip()
    token = (payload.access_token or "").strip()
    if not name or not secret or not token:
        raise HTTPException(status_code=400, detail="name / channel_secret / access_token 都必填")
    # Tier limit gate
    limits = await _get_user_limits(uid)
    cap = limits["line_channels"]
    if not _is_unlimited(cap):
        current = await _count_line_channels(uid)
        if current >= cap:
            raise _tier_limit_error(
                "line_channels",
                cap,
                limits["tier"],
                f"目前方案最多可連結 {cap} 個 LINE 官方帳號,請升級方案",
            )
    async with pool.acquire() as conn:
        if payload.is_default:
            await conn.execute("UPDATE line_channels SET is_default = FALSE WHERE is_default")
        new_id = await conn.fetchval(
            """
            INSERT INTO line_channels
                (name, channel_secret, access_token, enabled, is_default, owner_fb_user_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            """,
            name,
            secret,
            token,
            payload.enabled,
            payload.is_default,
            uid,
        )
    return {"ok": True, "id": str(new_id)}


@app.put("/api/line-channels/{channel_id}")
async def update_line_channel(
    channel_id: str, payload: LineChannelPayload, fb_user_id: Optional[str] = None
):
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    name = (payload.name or "").strip()
    secret = (payload.channel_secret or "").strip()
    token = (payload.access_token or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name 必填")
    async with pool.acquire() as conn:
        # Ownership gate — can only edit channels you own. Shared
        # (NULL owner) channels can't be edited per-user.
        existing = await conn.fetchrow(
            "SELECT owner_fb_user_id FROM line_channels WHERE id = $1::uuid",
            channel_id,
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        if existing["owner_fb_user_id"] != uid:
            raise HTTPException(status_code=403, detail="無權限修改此官方帳號")
        if payload.is_default:
            await conn.execute(
                "UPDATE line_channels SET is_default = FALSE WHERE is_default AND id <> $1::uuid",
                channel_id,
            )
        await conn.execute(
            """
            UPDATE line_channels
            SET name = $1,
                channel_secret = CASE WHEN $2 = '' THEN channel_secret ELSE $2 END,
                access_token = CASE WHEN $3 = '' THEN access_token ELSE $3 END,
                enabled = $4,
                is_default = $5,
                updated_at = NOW()
            WHERE id = $6::uuid
            """,
            name,
            secret,
            token,
            payload.enabled,
            payload.is_default,
            channel_id,
        )
    return {"ok": True}


@app.delete("/api/line-channels/{channel_id}")
async def delete_line_channel(channel_id: str, fb_user_id: Optional[str] = None):
    """Refuse to delete a channel that still owns groups — would orphan
    them and break per-channel push routing. Also requires ownership:
    only the user who created the channel can delete it.
    """
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT owner_fb_user_id FROM line_channels WHERE id = $1::uuid",
            channel_id,
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        if existing["owner_fb_user_id"] != uid:
            raise HTTPException(status_code=403, detail="無權限刪除此官方帳號")
        n = await conn.fetchval(
            "SELECT COUNT(*) FROM line_groups WHERE channel_id = $1::uuid AND left_at IS NULL",
            channel_id,
        )
        if n and int(n) > 0:
            raise HTTPException(
                status_code=409,
                detail=f"無法刪除:此官方帳號仍有 {n} 個進行中的群組綁定",
            )
        await conn.execute(
            "DELETE FROM line_channels WHERE id = $1::uuid",
            channel_id,
        )
    return {"ok": True}


@app.get("/api/line-channels/{channel_id}/quota")
async def get_line_channel_quota(channel_id: str, fb_user_id: Optional[str] = None):
    """Real-time LINE Official Account monthly push quota / consumption
    for one channel. The LINE Manager UI updates only daily, which
    confused operators on the「為什麼測試失敗 monthly limit」 thread —
    this endpoint hits LINE's quota API directly so the UI can show
    actual current usage.

    Auth: caller must own the channel OR have an accepted grant on it.
    """
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    role = await _channel_role_for_user(channel_id, uid)
    if role is None:
        raise HTTPException(status_code=403, detail="無權限查詢此官方帳號用量")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT access_token FROM line_channels "
            "WHERE id = $1::uuid AND enabled",
            channel_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Channel not found")
    try:
        return await line_client.get_quota(_http_client, access_token=row["access_token"])
    except line_client.LinePushError as e:
        raise HTTPException(status_code=502, detail=e.friendly_message)


@app.post("/api/line-channels/refresh-all")
async def refresh_all_line_channels(fb_user_id: Optional[str] = None):
    """For each user-owned channel, re-pull the bot's displayName from
    LINE's /v2/bot/info and update line_channels.name when it differs.
    Lets operators sync after renaming the LINE OA inside LINE
    Official Account Manager — paired with the existing
    `/api/line-groups/refresh-all` endpoint, the LINE 推播設定 page's
    top-right refresh button now keeps both channel names AND group
    names in sync with their LINE-side state."""
    pool = _require_db()
    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not ready")
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        # Owned channels OR accepted-grant channels — both should be
        # refreshable since both can see the channel and would benefit
        # from the displayName sync (renames in LINE Manager are visible
        # to all members of the OA).
        rows = await conn.fetch(
            """
            SELECT DISTINCT c.id, c.name, c.access_token
            FROM line_channels c
            LEFT JOIN line_channel_grants gr
                ON gr.channel_id = c.id AND gr.fb_user_id = $1 AND gr.status = 'accepted'
            WHERE c.enabled
              AND (c.owner_fb_user_id = $1 OR gr.fb_user_id = $1)
            """,
            uid,
        )
    if not rows:
        return {"ok": True, "refreshed": 0}

    sem = asyncio.Semaphore(4)
    refreshed = 0

    async def _one(channel_id: str, current_name: str, token: str) -> Optional[tuple[str, str]]:
        async with sem:
            info = await line_client.get_bot_info(_http_client, access_token=token)
        if info is None:
            return None
        new_name = (info.get("displayName") or "").strip()
        if not new_name or new_name == (current_name or "").strip():
            return None
        return str(channel_id), new_name

    results = await asyncio.gather(
        *(_one(str(r["id"]), r["name"], r["access_token"] or "") for r in rows),
        return_exceptions=True,
    )
    async with pool.acquire() as conn:
        for r in results:
            if isinstance(r, Exception) or r is None:
                continue
            channel_id, new_name = r
            await conn.execute(
                "UPDATE line_channels SET name = $1, updated_at = NOW() WHERE id = $2::uuid",
                new_name,
                channel_id,
            )
            refreshed += 1
    return {"ok": True, "refreshed": refreshed}


# ── LINE channel grants (sharing) ─────────────────────────────


_VALID_GRANT_ROLES = {"admin", "viewer"}


class ChannelGrantPayload(BaseModel):
    fb_user_id: str  # invitee
    role: Optional[str] = "admin"  # 'admin' | 'viewer'


class ChannelGrantRolePayload(BaseModel):
    role: str  # 'admin' | 'viewer'


@app.post("/api/line-channels/{channel_id}/grants")
async def invite_channel_user(
    channel_id: str,
    payload: ChannelGrantPayload,
    fb_user_id: Optional[str] = None,
):
    """Owner invites another FB user to share access to this channel.
    The invitee sees a pending invitation banner on next login and
    must accept before the channel becomes visible to them.

    `role` may be 'admin' (full edit, default) or 'viewer' (read-only).
    Owner can change the role later via the PUT-role endpoint."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    invitee = (payload.fb_user_id or "").strip()
    if not invitee:
        raise HTTPException(status_code=400, detail="invitee fb_user_id 必填")
    if invitee == uid:
        raise HTTPException(status_code=400, detail="不能邀請自己")
    role = (payload.role or "admin").strip()
    if role not in _VALID_GRANT_ROLES:
        raise HTTPException(status_code=400, detail=f"role 必須是 {_VALID_GRANT_ROLES} 之一")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT owner_fb_user_id FROM line_channels WHERE id = $1::uuid",
            channel_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Channel not found")
        if row["owner_fb_user_id"] != uid:
            raise HTTPException(status_code=403, detail="只有擁有者能邀請其他人")
        await conn.execute(
            """
            INSERT INTO line_channel_grants
              (channel_id, fb_user_id, granted_by_fb_user_id, status, role)
            VALUES ($1::uuid, $2, $3, 'pending', $4)
            ON CONFLICT (channel_id, fb_user_id) DO UPDATE
            SET status = 'pending',
                role = EXCLUDED.role,
                granted_by_fb_user_id = EXCLUDED.granted_by_fb_user_id,
                granted_at = NOW(),
                responded_at = NULL
            """,
            channel_id,
            invitee,
            uid,
            role,
        )
    return {"ok": True, "status": "pending", "role": role}


@app.put("/api/line-channels/{channel_id}/grants/{user_id}/role")
async def update_channel_grant_role(
    channel_id: str,
    user_id: str,
    payload: ChannelGrantRolePayload,
    fb_user_id: Optional[str] = None,
):
    """Owner changes a grantee's role (admin ↔ viewer). Takes effect
    immediately — next request from the grantee respects the new role
    via the auth gates."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    role = (payload.role or "").strip()
    if role not in _VALID_GRANT_ROLES:
        raise HTTPException(status_code=400, detail=f"role 必須是 {_VALID_GRANT_ROLES} 之一")
    async with pool.acquire() as conn:
        owner = await conn.fetchval(
            "SELECT owner_fb_user_id FROM line_channels WHERE id = $1::uuid",
            channel_id,
        )
        if owner != uid:
            raise HTTPException(status_code=403, detail="只有擁有者能變更權限")
        n = await conn.execute(
            """
            UPDATE line_channel_grants
            SET role = $1
            WHERE channel_id = $2::uuid AND fb_user_id = $3
            """,
            role,
            channel_id,
            user_id,
        )
    if n.endswith(" 0"):
        raise HTTPException(status_code=404, detail="找不到該共享紀錄")
    return {"ok": True, "role": role}


@app.get("/api/line-channels/{channel_id}/grants")
async def list_channel_grants(channel_id: str, fb_user_id: Optional[str] = None):
    """Owner lists who has been invited / accepted access to this channel."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        owner = await conn.fetchval(
            "SELECT owner_fb_user_id FROM line_channels WHERE id = $1::uuid",
            channel_id,
        )
        if owner != uid:
            raise HTTPException(status_code=403, detail="只有擁有者能查看共享名單")
        rows = await conn.fetch(
            """
            SELECT fb_user_id, status, role, granted_by_fb_user_id,
                   granted_at, responded_at
            FROM line_channel_grants
            WHERE channel_id = $1::uuid
            ORDER BY granted_at DESC
            """,
            channel_id,
        )
    return {
        "data": [
            {
                "fb_user_id": r["fb_user_id"],
                "status": r["status"],
                "role": r["role"] or "admin",
                "granted_at": r["granted_at"].isoformat() if r["granted_at"] else None,
                "responded_at": r["responded_at"].isoformat() if r["responded_at"] else None,
            }
            for r in rows
        ]
    }


@app.delete("/api/line-channels/{channel_id}/grants/{user_id}")
async def revoke_channel_grant(
    channel_id: str,
    user_id: str,
    fb_user_id: Optional[str] = None,
):
    """Owner revokes a previously-granted (or pending) access.
    Removed users immediately lose visibility of this channel + its
    groups + push configs."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        owner = await conn.fetchval(
            "SELECT owner_fb_user_id FROM line_channels WHERE id = $1::uuid",
            channel_id,
        )
        if owner != uid:
            raise HTTPException(status_code=403, detail="只有擁有者能移除共享")
        await conn.execute(
            """
            DELETE FROM line_channel_grants
            WHERE channel_id = $1::uuid AND fb_user_id = $2
            """,
            channel_id,
            user_id,
        )
    return {"ok": True}


@app.get("/api/line-channels/grants/pending")
async def my_pending_invitations(fb_user_id: Optional[str] = None):
    """Caller's pending invitations across all channels. Surfaced as
    a top-of-page banner on the LINE 推播設定 view."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        return {"data": []}
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT g.channel_id, g.granted_by_fb_user_id, g.granted_at,
                   c.name AS channel_name
            FROM line_channel_grants g
            JOIN line_channels c ON c.id = g.channel_id
            WHERE g.fb_user_id = $1 AND g.status = 'pending'
            ORDER BY g.granted_at DESC
            """,
            uid,
        )
    return {
        "data": [
            {
                "channel_id": str(r["channel_id"]),
                "channel_name": r["channel_name"],
                "granted_by_fb_user_id": r["granted_by_fb_user_id"],
                "granted_at": r["granted_at"].isoformat() if r["granted_at"] else None,
            }
            for r in rows
        ]
    }


@app.post("/api/line-channels/grants/{channel_id}/accept")
async def accept_channel_grant(channel_id: str, fb_user_id: Optional[str] = None):
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        n = await conn.execute(
            """
            UPDATE line_channel_grants
            SET status = 'accepted', responded_at = NOW()
            WHERE channel_id = $1::uuid AND fb_user_id = $2 AND status = 'pending'
            """,
            channel_id,
            uid,
        )
    if n.endswith(" 0"):
        raise HTTPException(status_code=404, detail="找不到待確認的邀請")
    return {"ok": True}


@app.post("/api/line-channels/grants/{channel_id}/reject")
async def reject_channel_grant(channel_id: str, fb_user_id: Optional[str] = None):
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        n = await conn.execute(
            """
            UPDATE line_channel_grants
            SET status = 'rejected', responded_at = NOW()
            WHERE channel_id = $1::uuid AND fb_user_id = $2 AND status = 'pending'
            """,
            channel_id,
            uid,
        )
    if n.endswith(" 0"):
        raise HTTPException(status_code=404, detail="找不到待確認的邀請")
    return {"ok": True}


# ── LINE group management ─────────────────────────────────────


@app.get("/api/line-groups")
async def list_line_groups(fb_user_id: Optional[str] = None):
    """Return groups visible to the calling FB user.

    Visibility rule (matches the channel list):
      - Groups whose channel is owned by the caller → visible
      - Groups whose channel is orphan (owner IS NULL) → visible
        (so the caller can claim the channel)
      - Groups whose channel is owned by someone else → invisible

    Rows with `left_at IS NOT NULL` (bot was kicked / left the group)
    stay in DB for history but are filtered out so the management UI
    only shows actionable groups.
    """
    if _db_pool is None:
        return {"data": []}
    uid = (fb_user_id or "").strip()
    if not uid:
        return {"data": []}
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT g.group_id, g.group_name, g.label, g.joined_at, g.left_at,
                   g.channel_id, g.folder_id,
                   COALESCE(c.name, '') AS channel_name,
                   c.owner_fb_user_id AS channel_owner_fb_user_id,
                   (c.owner_fb_user_id = $1) AS is_owner,
                   COALESCE(gr.status, '') AS my_grant_status,
                   COALESCE(gr.role, '') AS my_grant_role
            FROM line_groups g
            LEFT JOIN line_channels c ON c.id = g.channel_id
            LEFT JOIN line_channel_grants gr
                ON gr.channel_id = c.id AND gr.fb_user_id = $1
            WHERE g.left_at IS NULL
              AND (
                c.owner_fb_user_id = $1
                OR c.owner_fb_user_id IS NULL
                OR (gr.fb_user_id = $1 AND gr.status = 'accepted')
              )
            ORDER BY g.joined_at DESC
            """,
            uid,
        )
    return {
        "data": [
            {
                "group_id": r["group_id"],
                "group_name": r["group_name"],
                "label": r["label"],
                "channel_id": str(r["channel_id"]) if r["channel_id"] else None,
                "folder_id": str(r["folder_id"]) if r["folder_id"] else None,
                "channel_name": r["channel_name"] or "",
                "channel_owner_fb_user_id": r["channel_owner_fb_user_id"],
                "is_owner": bool(r["is_owner"]),
                "is_shared": (r["my_grant_status"] == "accepted") and not bool(r["is_owner"]),
                "my_role": (
                    "owner" if bool(r["is_owner"]) else
                    ("viewer" if r["my_grant_role"] == "viewer" else "admin")
                    if r["my_grant_status"] == "accepted"
                    else ""
                ),
                "joined_at": r["joined_at"].isoformat() if r["joined_at"] else None,
                "left_at": r["left_at"].isoformat() if r["left_at"] else None,
            }
            for r in rows
        ]
    }


# ── LINE 群組資料夾（每個 OA 自訂分類）─────────────────────────
#
# 每個群組(line_groups)最多屬於一個 folder(line_group_folders),folder
# 綁在一個 OA(channel)底下。前端 LINE 群組管理用 OA 分頁 + 左側資料夾清單
# 呈現;folder_id NULL = 未分類。


async def _folder_channel_for_write(folder_id: str, uid: str) -> str:
    """Resolve a folder to its channel_id and assert the caller can
    manage it (owner or admin grant). Returns the channel_id string.
    404 if the folder is gone; 403 if the caller lacks write access."""
    pool = _require_db()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT channel_id FROM line_group_folders WHERE id = $1::uuid",
            folder_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="資料夾不存在")
    channel_id = str(row["channel_id"])
    role = await _channel_role_for_user(channel_id, uid)
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="你沒有權限管理此官方帳號的資料夾")
    return channel_id


@app.get("/api/line-group-folders")
async def list_line_group_folders(fb_user_id: Optional[str] = None):
    """List folders for every channel visible to the caller (owned,
    orphan, or accepted-grant), with the group count in each folder.
    Same visibility rule as `/api/line-groups`."""
    if _db_pool is None:
        return {"data": []}
    uid = (fb_user_id or "").strip()
    if not uid:
        return {"data": []}
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT f.id, f.channel_id, f.name, f.sort_order,
                   COUNT(g.group_id) FILTER (WHERE g.left_at IS NULL) AS group_count
            FROM line_group_folders f
            JOIN line_channels c ON c.id = f.channel_id
            LEFT JOIN line_channel_grants gr
                ON gr.channel_id = c.id AND gr.fb_user_id = $1
            LEFT JOIN line_groups g ON g.folder_id = f.id
            WHERE c.owner_fb_user_id = $1
               OR c.owner_fb_user_id IS NULL
               OR (gr.fb_user_id = $1 AND gr.status = 'accepted')
            GROUP BY f.id, f.channel_id, f.name, f.sort_order
            ORDER BY f.sort_order, f.created_at
            """,
            uid,
        )
    return {
        "data": [
            {
                "id": str(r["id"]),
                "channel_id": str(r["channel_id"]),
                "name": r["name"],
                "sort_order": int(r["sort_order"]),
                "group_count": int(r["group_count"] or 0),
            }
            for r in rows
        ]
    }


class _FolderCreateBody(BaseModel):
    channel_id: str
    name: str


@app.post("/api/line-group-folders")
async def create_line_group_folder(
    body: _FolderCreateBody, fb_user_id: Optional[str] = None
):
    """Create a folder under a channel. Caller must own or be an admin
    grantee of that channel."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="資料夾名稱必填")
    role = await _channel_role_for_user(body.channel_id, uid)
    if role not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="你沒有權限在此官方帳號建立資料夾")
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO line_group_folders (channel_id, name, sort_order)
            VALUES ($1::uuid, $2,
                    COALESCE((SELECT MAX(sort_order) + 1 FROM line_group_folders
                              WHERE channel_id = $1::uuid), 0))
            RETURNING id, channel_id, name, sort_order
            """,
            body.channel_id,
            name,
        )
    return {
        "ok": True,
        "data": {
            "id": str(row["id"]),
            "channel_id": str(row["channel_id"]),
            "name": row["name"],
            "sort_order": int(row["sort_order"]),
            "group_count": 0,
        },
    }


class _FolderUpdateBody(BaseModel):
    name: Optional[str] = None
    sort_order: Optional[int] = None


@app.patch("/api/line-group-folders/{folder_id}")
async def update_line_group_folder(
    folder_id: str, body: _FolderUpdateBody, fb_user_id: Optional[str] = None
):
    """Rename and/or reorder a folder."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    await _folder_channel_for_write(folder_id, uid)
    sets: list = []
    args: list = []
    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="資料夾名稱不可為空")
        args.append(name)
        sets.append(f"name = ${len(args)}")
    if body.sort_order is not None:
        args.append(int(body.sort_order))
        sets.append(f"sort_order = ${len(args)}")
    if not sets:
        return {"ok": True}
    args.append(folder_id)
    async with pool.acquire() as conn:
        await conn.execute(
            f"UPDATE line_group_folders SET {', '.join(sets)} WHERE id = ${len(args)}::uuid",
            *args,
        )
    return {"ok": True}


@app.delete("/api/line-group-folders/{folder_id}")
async def delete_line_group_folder(folder_id: str, fb_user_id: Optional[str] = None):
    """Delete a folder. Its groups fall back to 未分類 (folder_id → NULL
    via ON DELETE SET NULL) — groups are never deleted."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    await _folder_channel_for_write(folder_id, uid)
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM line_group_folders WHERE id = $1::uuid", folder_id
        )
    return {"ok": True}


class _GroupFolderBody(BaseModel):
    folder_id: Optional[str] = None


@app.post("/api/line-groups/{group_id}/folder")
async def set_line_group_folder(
    group_id: str, body: _GroupFolderBody, fb_user_id: Optional[str] = None
):
    """Move a group into a folder (or clear it with folder_id=null).
    Caller must be able to manage the group's channel; the target folder
    must belong to that same channel."""
    pool = _require_db()
    uid = (fb_user_id or "").strip()
    # Owner/admin on the group's channel (reuses the config-write gate).
    await _assert_can_modify_config_for_group(group_id, uid)
    async with pool.acquire() as conn:
        grow = await conn.fetchrow(
            "SELECT channel_id FROM line_groups WHERE group_id = $1", group_id
        )
        if grow is None:
            raise HTTPException(status_code=404, detail="群組不存在")
        group_channel = str(grow["channel_id"]) if grow["channel_id"] else None
        target = (body.folder_id or "").strip() or None
        if target is not None:
            frow = await conn.fetchrow(
                "SELECT channel_id FROM line_group_folders WHERE id = $1::uuid", target
            )
            if frow is None:
                raise HTTPException(status_code=404, detail="資料夾不存在")
            if str(frow["channel_id"]) != group_channel:
                raise HTTPException(
                    status_code=400, detail="資料夾與群組不屬於同一個官方帳號"
                )
        await conn.execute(
            "UPDATE line_groups SET folder_id = $1::uuid WHERE group_id = $2",
            target,
            group_id,
        )
    return {"ok": True, "folder_id": target}


@app.get("/api/line-groups/{group_id}/push-configs")
async def list_group_push_configs(group_id: str, fb_user_id: Optional[str] = None):
    """List push configs that target this LINE group, joined with the
    campaign nickname (店家 · 設計師) so the UI can show "this group
    receives X campaigns" without making the user open every campaign.

    Scoped to the caller: refuses to list configs on a group whose
    channel is owned by another user AND not shared with the caller.
    Accepted-grant users see the same configs as the owner so they
    can co-manage the OA's push schedule.
    """
    if _db_pool is None:
        return {"data": []}
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with _db_pool.acquire() as conn:
        owner_row = await conn.fetchrow(
            """
            SELECT c.owner_fb_user_id,
                   COALESCE(gr.status, '') AS my_grant_status
            FROM line_groups g
            LEFT JOIN line_channels c ON c.id = g.channel_id
            LEFT JOIN line_channel_grants gr
                ON gr.channel_id = c.id AND gr.fb_user_id = $2
            WHERE g.group_id = $1
            """,
            group_id,
            uid,
        )
        if owner_row is None:
            raise HTTPException(status_code=404, detail="Group not found")
        owner = owner_row["owner_fb_user_id"]
        is_owner = owner == uid
        is_shared = owner_row["my_grant_status"] == "accepted"
        is_orphan = owner is None
        if not (is_owner or is_shared or is_orphan):
            raise HTTPException(status_code=403, detail="無權限檢視此群組的推播設定")
        rows = await conn.fetch(
            """
            SELECT pc.*, n.store, n.designer,
                   c.owner_fb_user_id AS channel_owner,
                   c.name AS channel_name
            FROM campaign_line_push_configs pc
            LEFT JOIN campaign_nicknames n ON n.campaign_id = pc.campaign_id
            LEFT JOIN line_groups g ON g.group_id = pc.group_id
            LEFT JOIN line_channels c ON c.id = g.channel_id
            WHERE pc.group_id = $1
            ORDER BY pc.created_at ASC
            """,
            group_id,
        )
    out = []
    for r in rows:
        d = _config_row_to_dict(r)
        store = (r["store"] or "").strip() if r["store"] is not None else ""
        designer = (r["designer"] or "").strip() if r["designer"] is not None else ""
        if store and designer:
            d["campaign_nickname"] = f"{store} · {designer}"
        elif store or designer:
            d["campaign_nickname"] = store or designer
        else:
            d["campaign_nickname"] = ""
        # Channel ownership info — frontend gates edit/delete/test buttons
        # by comparing `channel_owner` to the current user's id.
        d["channel_owner_fb_user_id"] = r["channel_owner"]
        d["channel_name"] = r["channel_name"] or ""
        out.append(d)
    return {"data": out}


@app.post("/api/line-groups/{group_id}/refresh-name")
async def refresh_line_group_name(group_id: str):
    """Re-query LINE for a group's display name and update DB.

    Used to backfill `group_name` for rows that joined before this
    feature shipped, or to pick up a manual rename inside LINE.
    """
    pool = _require_db()
    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not ready")
    creds = await _channel_creds_for_group(group_id)
    if creds is None:
        raise HTTPException(status_code=404, detail="Group not bound to an enabled channel")
    summary = await line_client.get_group_summary(
        _http_client, group_id, access_token=creds[2]
    )
    if not summary:
        raise HTTPException(
            status_code=502,
            detail="LINE API 沒有回傳群組資訊（可能 bot 已退出或 token 失效）",
        )
    group_name = (summary.get("groupName") or "").strip()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE line_groups SET group_name = $1 WHERE group_id = $2",
            group_name,
            group_id,
        )
        if result.endswith("0"):
            raise HTTPException(status_code=404, detail="Group not found")
    return {"ok": True, "group_id": group_id, "group_name": group_name}


@app.post("/api/line-groups/refresh-all")
async def refresh_all_line_groups(fb_user_id: Optional[str] = None):
    """Bulk refresh: for the calling user's channels only, re-fetch
    each group's LINE display name and detect stale memberships.

    Powered by the LINE 推播設定 page's top-right refresh button. For
    each row whose channel is owned by the caller (or is orphan, NULL):
      - Success → update `group_name` (picks up rename inside LINE).
      - None    → bot can't see the group anymore (kicked / token bad
                  / etc.). Set `left_at = NOW()` so the row drops out
                  of the management UI on the next GET.

    Concurrency-bounded by an asyncio.Semaphore(8) so we don't fan
    out 80 LINE API calls in parallel and tip into rate limits.
    """
    pool = _require_db()
    if _http_client is None:
        raise HTTPException(status_code=503, detail="HTTP client not ready")
    uid = (fb_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="fb_user_id 必填")
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT g.group_id, c.access_token
            FROM line_groups g
            LEFT JOIN line_channels c ON c.id = g.channel_id
            LEFT JOIN line_channel_grants gr
                ON gr.channel_id = c.id AND gr.fb_user_id = $1 AND gr.status = 'accepted'
            WHERE g.left_at IS NULL
              AND c.enabled
              AND (
                c.owner_fb_user_id = $1
                OR c.owner_fb_user_id IS NULL
                OR gr.fb_user_id = $1
              )
            """,
            uid,
        )
    targets = [(r["group_id"], r["access_token"] or "") for r in rows]
    if not targets:
        return {"ok": True, "refreshed": 0, "marked_left": 0}

    sem = asyncio.Semaphore(8)
    refreshed = 0
    marked_left = 0

    async def _one(gid: str, token: str) -> tuple[str, Optional[str]]:
        async with sem:
            summary = await line_client.get_group_summary(
                _http_client, gid, access_token=token
            )
        if summary is None:
            return gid, None
        return gid, (summary.get("groupName") or "").strip()

    results = await asyncio.gather(
        *(_one(gid, tok) for gid, tok in targets), return_exceptions=True
    )
    async with pool.acquire() as conn:
        for r in results:
            if isinstance(r, Exception):
                continue
            gid, name = r
            if name is None:
                await conn.execute(
                    "UPDATE line_groups SET left_at = NOW() WHERE group_id = $1 AND left_at IS NULL",
                    gid,
                )
                marked_left += 1
            else:
                await conn.execute(
                    "UPDATE line_groups SET group_name = $1 WHERE group_id = $2",
                    name,
                    gid,
                )
                refreshed += 1
    return {"ok": True, "refreshed": refreshed, "marked_left": marked_left}


# ── LINE push configs CRUD ────────────────────────────────────

class LinePushConfigPayload(BaseModel):
    id: Optional[str] = None
    campaign_id: str
    account_id: str
    group_id: str
    frequency: str
    weekdays: List[int] = []
    month_day: Optional[int] = None
    hour: int
    minute: int
    date_range: str = "last_7d"
    enabled: bool = True
    # User-selectable KPI fields for the LINE flex report. Codes:
    # spend, impressions, clicks, ctr, cpc, cpm, frequency, reach,
    # msgs, msg_cost. Empty → use the built-in defaults
    # (spend/impressions/clicks/ctr/cpc + msgs/msg_cost when not
    # traffic-objective).
    report_fields: List[str] = []
    # When True, append a「查看完整報告」footer button linking to the
    # public share page. Default False so the button is opt-in.
    include_report_button: bool = False
    # Which report version that button links to: 'standard' (以廣告組合
    # 報告) or 'perf' (以廣告報告 / 素材成效). Only used when
    # include_report_button is True.
    report_variant: str = "standard"
    # When True, render the「優化建議」bullet list in the flex body.
    # Default False — recommendations are opt-in because many recipients
    # are external (業主) and only want raw numbers.
    include_recommendations: bool = False
    # FB-side campaign name captured at save-time (frontend already has
    # it in the searchable combobox). Cached on the row so the group
    # management UI can show「ICONI 南京 · Cherry 燙髮」 instead of the
    # bare 16-digit campaign_id when no team-wide nickname is set.
    campaign_name: str = ""
    # Used only when date_range == "custom"; ISO YYYY-MM-DD strings.
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    # When non-empty, the flex push reports each selected adset as its
    # own bubble in a carousel (title = adset name). Empty = campaign-
    # level single bubble (original behaviour).
    adset_ids: List[str] = []
    # When non-empty, the flex push reports each selected AD (3rd
    # level) as its own bubble in a carousel (title = ad name).
    # Mutually exclusive with adset_ids.
    ad_ids: List[str] = []


def _config_row_to_dict(r: asyncpg.Record) -> dict:
    return {
        "id": str(r["id"]),
        "campaign_id": r["campaign_id"],
        "account_id": r["account_id"],
        "group_id": r["group_id"],
        "frequency": r["frequency"],
        "weekdays": list(r["weekdays"] or []),
        "month_day": r["month_day"],
        "hour": r["hour"],
        "minute": r["minute"],
        "date_range": r["date_range"],
        "enabled": r["enabled"],
        "report_fields": list(r["report_fields"] or []),
        "include_report_button": bool(r["include_report_button"]),
        "report_variant": r["report_variant"] or "standard",
        "include_recommendations": bool(r["include_recommendations"]),
        "campaign_name": r["campaign_name"] or "",
        "adset_ids": list(r["adset_ids"] or []),
        "ad_ids": list(r["ad_ids"] or []),
        "date_from": r["date_from"].isoformat() if r["date_from"] else None,
        "date_to": r["date_to"].isoformat() if r["date_to"] else None,
        "last_run_at": r["last_run_at"].isoformat() if r["last_run_at"] else None,
        "next_run_at": r["next_run_at"].isoformat() if r["next_run_at"] else None,
        "last_error": r["last_error"],
        "fail_count": r["fail_count"],
    }


def _norm_report_variant(v: Optional[str]) -> str:
    """Whitelist the report-button variant so only known values reach
    the DB / share URL."""
    return "perf" if str(v or "").strip() == "perf" else "standard"


def _validate_push_payload(p: LinePushConfigPayload) -> None:
    if p.frequency not in _VALID_FREQUENCIES:
        raise HTTPException(status_code=400, detail="Invalid frequency")
    if p.date_range not in _VALID_DATE_RANGES:
        raise HTTPException(status_code=400, detail="Invalid date_range")
    if not 0 <= p.hour <= 23:
        raise HTTPException(status_code=400, detail="Invalid hour")
    if not 0 <= p.minute <= 59:
        raise HTTPException(status_code=400, detail="Invalid minute")
    if p.frequency in (FREQUENCY_WEEKLY, FREQUENCY_BIWEEKLY):
        if not p.weekdays:
            raise HTTPException(
                status_code=400, detail="weekdays required for weekly/biweekly"
            )
        if any(w < 0 or w > 6 for w in p.weekdays):
            raise HTTPException(status_code=400, detail="Invalid weekday")
    if p.frequency == FREQUENCY_MONTHLY:
        if p.month_day is None or p.month_day < 1 or p.month_day > 28:
            raise HTTPException(status_code=400, detail="month_day must be 1..28")


@app.get("/api/line-push/configs")
async def list_push_configs(campaign_id: Optional[str] = None):
    if _db_pool is None:
        return {"data": []}
    async with _db_pool.acquire() as conn:
        if campaign_id:
            rows = await conn.fetch(
                """
                SELECT * FROM campaign_line_push_configs
                WHERE campaign_id = $1
                ORDER BY created_at ASC
                """,
                campaign_id,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM campaign_line_push_configs ORDER BY created_at ASC"
            )
    return {"data": [_config_row_to_dict(r) for r in rows]}


@app.post("/api/line-push/configs")
async def upsert_push_config(payload: LinePushConfigPayload, fb_user_id: Optional[str] = None):
    pool = _require_db()
    await _assert_can_modify_config_for_group(payload.group_id, fb_user_id)
    _validate_push_payload(payload)
    # Tier limit gate — only on create (payload.id == None). Edits
    # to an existing config don't grow the count, so they're free.
    # Charged against the CHANNEL OWNER's tier, not the caller's.
    # The OA owner paid for the channel; granted users can manage
    # configs without burning their own personal tier quota.
    if not payload.id:
        owner_uid = await _get_group_owner(payload.group_id) or fb_user_id
        if owner_uid:
            limits = await _get_user_limits(owner_uid)
            cap = limits["line_groups"]
            if not _is_unlimited(cap):
                current = await _count_user_push_configs(owner_uid)
                if current >= cap:
                    raise _tier_limit_error(
                        "line_groups",
                        cap,
                        limits["tier"],
                        f"此官方帳號擁有者方案最多 {cap} 個 LINE 群組推播,需擁有者升級",
                    )
    next_run = _compute_next_run(
        payload.frequency,
        payload.weekdays,
        payload.month_day,
        payload.hour,
        payload.minute,
    )
    async with pool.acquire() as conn:
        # Verify the target group actually exists — otherwise the FK
        # error would surface as a generic 500.
        grp = await conn.fetchrow(
            "SELECT group_id FROM line_groups WHERE group_id = $1",
            payload.group_id,
        )
        if grp is None:
            raise HTTPException(status_code=404, detail="LINE group not found")
        # Parse custom-range dates (YYYY-MM-DD strings) into Python date
        # objects for the asyncpg DATE binding. Non-custom ranges store
        # NULL in both columns regardless of what the payload carries.
        date_from_val = None
        date_to_val = None
        if payload.date_range == "custom":
            try:
                if payload.date_from:
                    date_from_val = datetime.fromisoformat(payload.date_from).date()
                if payload.date_to:
                    date_to_val = datetime.fromisoformat(payload.date_to).date()
            except ValueError:
                raise HTTPException(status_code=400, detail="自訂區間日期格式錯誤")
            if date_from_val is None or date_to_val is None:
                raise HTTPException(status_code=400, detail="自訂區間需要起訖日期")
            if date_from_val > date_to_val:
                raise HTTPException(status_code=400, detail="自訂區間起始日期不能晚於結束日期")
        # Dedup + cap to 10 entries (LINE carousel hard limit is 12; we
        # leave headroom for any future "summary" bubble). Order
        # preserved so the operator's picking order matches the push.
        def _clean_id_list(raw: Optional[List[str]]) -> "list[str]":
            out: list[str] = []
            seen: set[str] = set()
            for item in raw or []:
                s = (item or "").strip()
                if not s or s in seen:
                    continue
                seen.add(s)
                out.append(s)
                if len(out) >= 10:
                    break
            return out

        adset_ids_clean = _clean_id_list(payload.adset_ids)
        ad_ids_clean = _clean_id_list(payload.ad_ids)
        if adset_ids_clean and ad_ids_clean:
            raise HTTPException(
                status_code=400,
                detail="「以廣告播報」與「以廣告組合播報」只能擇一",
            )
        if payload.id:
            row = await conn.fetchrow(
                """
                UPDATE campaign_line_push_configs
                SET campaign_id = $1, account_id = $2, group_id = $3,
                    frequency = $4, weekdays = $5, month_day = $6,
                    hour = $7, minute = $8, date_range = $9, enabled = $10,
                    report_fields = $11, include_report_button = $12,
                    include_recommendations = $13, campaign_name = $14,
                    date_from = $15, date_to = $16, adset_ids = $17,
                    ad_ids = $18,
                    next_run_at = $19, report_variant = $21,
                    fail_count = 0, last_error = NULL,
                    updated_at = NOW()
                WHERE id = $20::uuid
                RETURNING *
                """,
                payload.campaign_id,
                payload.account_id,
                payload.group_id,
                payload.frequency,
                payload.weekdays,
                payload.month_day,
                payload.hour,
                payload.minute,
                payload.date_range,
                payload.enabled,
                payload.report_fields,
                payload.include_report_button,
                payload.include_recommendations,
                (payload.campaign_name or "").strip(),
                date_from_val,
                date_to_val,
                adset_ids_clean,
                ad_ids_clean,
                next_run,
                payload.id,
                _norm_report_variant(payload.report_variant),
            )
            if row is None:
                raise HTTPException(status_code=404, detail="Config not found")
        else:
            # ON CONFLICT key is (campaign_id, group_id, frequency) —
            # one row per (pair, frequency). Re-saving the same triple
            # updates that row in place.
            row = await conn.fetchrow(
                """
                INSERT INTO campaign_line_push_configs (
                    campaign_id, account_id, group_id,
                    frequency, weekdays, month_day, hour, minute,
                    date_range, enabled, report_fields, include_report_button,
                    include_recommendations, campaign_name,
                    date_from, date_to, adset_ids, ad_ids, next_run_at,
                    report_variant
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                ON CONFLICT (campaign_id, group_id, frequency) DO UPDATE
                SET account_id = EXCLUDED.account_id,
                    weekdays = EXCLUDED.weekdays,
                    month_day = EXCLUDED.month_day,
                    hour = EXCLUDED.hour,
                    minute = EXCLUDED.minute,
                    date_range = EXCLUDED.date_range,
                    enabled = EXCLUDED.enabled,
                    report_fields = EXCLUDED.report_fields,
                    include_report_button = EXCLUDED.include_report_button,
                    include_recommendations = EXCLUDED.include_recommendations,
                    campaign_name = EXCLUDED.campaign_name,
                    date_from = EXCLUDED.date_from,
                    date_to = EXCLUDED.date_to,
                    adset_ids = EXCLUDED.adset_ids,
                    ad_ids = EXCLUDED.ad_ids,
                    next_run_at = EXCLUDED.next_run_at,
                    report_variant = EXCLUDED.report_variant,
                    fail_count = 0,
                    last_error = NULL,
                    updated_at = NOW()
                RETURNING *
                """,
                payload.campaign_id,
                payload.account_id,
                payload.group_id,
                payload.frequency,
                payload.weekdays,
                payload.month_day,
                payload.hour,
                payload.minute,
                payload.date_range,
                payload.enabled,
                payload.report_fields,
                payload.include_report_button,
                payload.include_recommendations,
                (payload.campaign_name or "").strip(),
                date_from_val,
                date_to_val,
                adset_ids_clean,
                ad_ids_clean,
                next_run,
                _norm_report_variant(payload.report_variant),
            )
    return {"ok": True, "data": _config_row_to_dict(row)}


@app.delete("/api/line-push/configs/{config_id}")
async def delete_push_config(config_id: str, fb_user_id: Optional[str] = None):
    pool = _require_db()
    async with pool.acquire() as conn:
        cfg_row = await conn.fetchrow(
            "SELECT group_id FROM campaign_line_push_configs WHERE id = $1::uuid",
            config_id,
        )
    if cfg_row is None:
        return {"ok": True}
    await _assert_can_modify_config_for_group(cfg_row["group_id"], fb_user_id)
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM campaign_line_push_configs WHERE id = $1::uuid",
            config_id,
        )
    return {"ok": True}


@app.post("/api/line-push/configs/{config_id}/enable")
async def enable_push_config(config_id: str, fb_user_id: Optional[str] = None):
    """Re-enable a config the scheduler auto-disabled (5 consecutive
    failures). Clears the failure state and reschedules the next run —
    the one-click recovery for the「已停用」badge, so the operator
    doesn't have to open 編輯 and hunt for the enable checkbox."""
    pool = _require_db()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM campaign_line_push_configs WHERE id = $1::uuid",
            config_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Config not found")
    cfg = _config_row_to_dict(row)
    await _assert_can_modify_config_for_group(cfg["group_id"], fb_user_id)
    next_run = _compute_next_run(
        cfg["frequency"],
        cfg["weekdays"],
        cfg["month_day"],
        cfg["hour"],
        cfg["minute"],
    )
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE campaign_line_push_configs
            SET enabled = TRUE, fail_count = 0, last_error = NULL,
                next_run_at = $2, updated_at = NOW()
            WHERE id = $1::uuid
            """,
            config_id,
            next_run,
        )
    return {"ok": True, "next_run_at": next_run.isoformat()}


@app.post("/api/line-push/configs/{config_id}/test")
async def test_push_config(config_id: str, fb_user_id: Optional[str] = None):
    """Fire a push immediately without advancing next_run_at.

    Handy for validating a newly-saved config or a fresh group label.
    """
    pool = _require_db()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM campaign_line_push_configs WHERE id = $1::uuid",
            config_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="Config not found")
    cfg = _config_row_to_dict(row)
    await _assert_can_modify_config_for_group(cfg["group_id"], fb_user_id)
    try:
        # Wrap the FB-heavy flex build in a hard timeout so we
        # return a clear 504 instead of letting Zeabur's edge (~30s)
        # bounce the request as a generic "HTTP 502". FB throttle
        # recovery is the usual culprit — calls hang for 30+ s before
        # FB itself errors. 18s gives the flex build + LINE push +
        # logging some headroom under the 30s gateway cap.
        try:
            flex = await asyncio.wait_for(_build_flex_for_config(cfg), timeout=18.0)
        except asyncio.TimeoutError:
            raise HTTPException(
                status_code=504,
                detail="從 Facebook 拉取資料超時(很可能是 FB 限流中)。請等待 30–60 分鐘後再試。",
            ) from None
        assert _http_client is not None
        creds = await _channel_creds_for_group(cfg["group_id"])
        if creds is None:
            raise RuntimeError("No enabled LINE channel for this group")
        await line_client.line_push(
            _http_client, cfg["group_id"], [flex], access_token=creds[2]
        )
        async with pool.acquire() as conn:
            # A successful 測試 proves the token/bot are healthy again, so
            # clear any stale failure state — otherwise the red「上次失敗」
            # line lingers until the next scheduled push (confusing after
            # the owner re-logs in and tests to confirm the fix).
            await conn.execute(
                """
                UPDATE campaign_line_push_configs
                SET fail_count = 0, last_error = NULL, updated_at = NOW()
                WHERE id = $1::uuid
                """,
                config_id,
            )
            await conn.execute(
                """
                INSERT INTO line_push_logs (config_id, success, message_preview)
                VALUES ($1::uuid, TRUE, $2)
                """,
                config_id,
                (flex.get("altText") or "")[:200],
            )
        return {"ok": True}
    except line_client.LinePushError as e:
        # LINE-specific error → use friendly translated message so the
        # operator sees actionable Chinese instead of raw 「LINE push
        # failed: 429 You have reached your monthly limit」.
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO line_push_logs (config_id, success, error)
                VALUES ($1::uuid, FALSE, $2)
                """,
                config_id,
                e.friendly_message[:500],
            )
        raise HTTPException(status_code=502, detail=e.friendly_message)
    except HTTPException:
        # Already a properly-formed HTTP error (e.g. 504 from the
        # wait_for above) — preserve its status + detail.
        raise
    except Exception as e:
        # Translate to actionable Chinese (token-expired names the 官方帳號
        # owner who must re-log in) so the 測試 toast + log are readable.
        owner_uid = await _get_group_owner(cfg["group_id"])
        owner_name = await _fb_user_display_name(owner_uid)
        friendly = _friendly_push_error(e, owner_name=owner_name)
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO line_push_logs (config_id, success, error)
                VALUES ($1::uuid, FALSE, $2)
                """,
                config_id,
                friendly,
            )
        raise HTTPException(status_code=502, detail=friendly)


@app.get("/api/line-push/logs")
async def list_push_logs(config_id: Optional[str] = None, limit: int = 20):
    if _db_pool is None:
        return {"data": []}
    limit = max(1, min(limit, 100))
    async with _db_pool.acquire() as conn:
        if config_id:
            rows = await conn.fetch(
                """
                SELECT id, config_id, run_at, success, error, message_preview
                FROM line_push_logs
                WHERE config_id = $1::uuid
                ORDER BY run_at DESC
                LIMIT $2
                """,
                config_id,
                limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT id, config_id, run_at, success, error, message_preview
                FROM line_push_logs
                ORDER BY run_at DESC
                LIMIT $1
                """,
                limit,
            )
    return {
        "data": [
            {
                "id": r["id"],
                "config_id": str(r["config_id"]) if r["config_id"] else None,
                "run_at": r["run_at"].isoformat() if r["run_at"] else None,
                "success": r["success"],
                "error": r["error"],
                "message_preview": r["message_preview"],
            }
            for r in rows
        ]
    }


# ── 安全監控推播 CRUD ──────────────────────────────────────────


_ALLOWED_ANOMALY_TAGS = {"deep_night", "weekend", "high_budget", "burst", "abnormal_language"}


class SecurityPushConfigPayload(BaseModel):
    id: Optional[str] = None
    name: str
    channel_id: str
    group_ids: List[str] = []
    account_ids: List[str] = []
    anomaly_filters: List[str] = []
    # 1-hour default: even with 80 accounts the tick fires 80 FB
    # campaigns calls/hr (1 per account per tick), leaving plenty of
    # headroom under FB's per-user Graph API budget. Anything tighter
    # (5–30 min) at 80-account scale was tripping the app-level rate
    # limit and even blocking /me login.
    poll_interval_minutes: int = 60
    enabled: bool = True


def _sec_push_row_to_dict(r) -> dict:
    return {
        "id": str(r["id"]),
        "name": r["name"],
        "owner_fb_user_id": r["owner_fb_user_id"],
        "channel_id": str(r["channel_id"]),
        "group_ids": list(r["group_ids"] or []),
        "account_ids": list(r["account_ids"] or []),
        "anomaly_filters": list(r["anomaly_filters"] or []),
        "poll_interval_minutes": r["poll_interval_minutes"],
        "enabled": r["enabled"],
        "last_run_at": r["last_run_at"].isoformat() if r["last_run_at"] else None,
        "next_run_at": r["next_run_at"].isoformat() if r["next_run_at"] else None,
        "last_error": r["last_error"],
        "fail_count": r["fail_count"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
    }


_VALID_SECURITY_PUSH_INTERVALS = (1, 2, 6, 12, 24)


def _next_security_push_run_at(
    after: Optional[datetime] = None,
    interval_hours: int = 1,
) -> datetime:
    """Return the next scheduled scan boundary in UTC.

    `interval_hours` aligns the schedule to local-clock multiples
    (e.g. 6 → 0/6/12/18 local). Hourly mode (`interval_hours == 1`)
    keeps the previous behaviour of bumping to the next top-of-hour.

    Aligning at local-clock boundaries (rather than UTC or
    last_run_at + N hours) means the operator's intuition matches
    reality — "每6小時整點" should fire at 00:00 / 06:00 / 12:00 /
    18:00 local time, regardless of when the previous run completed.
    """
    base = after or datetime.now(timezone.utc)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    interval = int(interval_hours) if interval_hours else 1
    if interval not in _VALID_SECURITY_PUSH_INTERVALS:
        interval = 1
    # Compute in local timezone so 0/6/12/18 etc. align to wall clock.
    local_tz = _scheduler_tz()
    local = base.astimezone(local_tz).replace(minute=0, second=0, microsecond=0)
    # Hour rounded up to the next multiple of `interval`. If we're
    # exactly at a slot already, advance one full interval (don't
    # re-fire at the same boundary).
    next_hour = ((local.hour // interval) + 1) * interval
    if next_hour >= 24:
        # Roll into the next day at hour 0; works for 1/2/6/12/24
        # (the only valid intervals) because all of them divide 24.
        days_forward = next_hour // 24
        next_local = local.replace(hour=0) + timedelta(days=days_forward)
    else:
        next_local = local.replace(hour=next_hour)
    return next_local.astimezone(timezone.utc)


def _security_auto_scan_since_dt(now: Optional[datetime] = None) -> datetime:
    """Match the manual security scan's default window.

    Manual scan fetches a wide campaign list, then the UI filters by
    the default "this month" range. Auto-scan should be the same kind
    of full snapshot, not a delta from the previous hourly tick.
    """
    local_now = (now or datetime.now(timezone.utc)).astimezone(_scheduler_tz())
    month_start = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return month_start.astimezone(timezone.utc)


def _validate_security_push_payload(p: SecurityPushConfigPayload) -> None:
    if not p.name or not p.name.strip():
        raise HTTPException(status_code=400, detail="name 不可為空")
    if not p.channel_id:
        raise HTTPException(status_code=400, detail="必須選擇 LINE channel")
    if not p.group_ids:
        raise HTTPException(status_code=400, detail="至少選擇一個 LINE group")
    bad = [t for t in p.anomaly_filters if t not in _ALLOWED_ANOMALY_TAGS]
    if bad:
        raise HTTPException(status_code=400, detail=f"未知的 anomaly tag: {bad}")


@app.get("/api/security-push/configs")
async def list_security_push_configs(fb_user_id: str = Query(...)):
    _assert_known_user(fb_user_id)
    if _db_pool is None:
        return {"data": []}
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM security_push_configs
            WHERE owner_fb_user_id = $1
            ORDER BY created_at ASC
            """,
            fb_user_id,
        )
    return {"data": [_sec_push_row_to_dict(r) for r in rows]}


@app.post("/api/security-push/configs")
async def upsert_security_push_config(
    payload: SecurityPushConfigPayload,
    fb_user_id: str = Query(...),
):
    _assert_known_user(fb_user_id)
    _validate_security_push_payload(payload)
    pool = _require_db()
    filters = (
        payload.anomaly_filters
        if payload.anomaly_filters
        else ["deep_night", "weekend", "high_budget"]
    )
    # Hard-coded poll interval — exposed to users would let them set
    # 5 min and trip FB's per-user rate limit (locks /me login for
    # ~1 hr). 60 min keeps total FB calls per workspace well under
    # budget regardless of account count.
    poll_minutes = 60
    # Align `next_run_at` to the operator's currently-selected cadence
    # so a fresh config doesn't fire 1 hour later when they've set
    # 24h interval — it should follow the chosen rhythm.
    interval_hours = await _security_push_interval_hours() or 1
    next_run_at = _next_security_push_run_at(interval_hours=interval_hours)
    async with pool.acquire() as conn:
        if payload.id:
            row = await conn.fetchrow(
                "SELECT owner_fb_user_id FROM security_push_configs WHERE id = $1::uuid",
                payload.id,
            )
            if row is None:
                raise HTTPException(status_code=404, detail="config 不存在")
            if row["owner_fb_user_id"] != fb_user_id:
                raise HTTPException(status_code=403, detail="無權編輯此 config")
            updated = await conn.fetchrow(
                """
                UPDATE security_push_configs
                SET name = $2, channel_id = $3::uuid, group_ids = $4,
                    account_ids = $5, anomaly_filters = $6,
                    poll_interval_minutes = $7, enabled = $8,
                    next_run_at = CASE WHEN $8 THEN $9 ELSE next_run_at END,
                    updated_at = NOW()
                WHERE id = $1::uuid
                RETURNING *
                """,
                payload.id,
                payload.name.strip(),
                payload.channel_id,
                payload.group_ids,
                payload.account_ids,
                filters,
                poll_minutes,
                payload.enabled,
                next_run_at,
            )
            return {"ok": True, "data": _sec_push_row_to_dict(updated)}
        created = await conn.fetchrow(
            """
            INSERT INTO security_push_configs (
                name, owner_fb_user_id, channel_id, group_ids,
                account_ids, anomaly_filters, poll_interval_minutes,
                enabled, next_run_at
            )
            VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9)
            RETURNING *
            """,
            payload.name.strip(),
            fb_user_id,
            payload.channel_id,
            payload.group_ids,
            payload.account_ids,
            filters,
            # Use the hardcoded 60min — NOT payload.poll_interval_minutes.
            # The whole point of the local override above is to ignore
            # whatever the frontend / a tampered client sends. The
            # earlier INSERT bug (used payload directly) let a 5-minute
            # interval slip into the DB, scanning FB 12× more often
            # than intended.
            poll_minutes,
            payload.enabled,
            next_run_at,
        )
        return {"ok": True, "data": _sec_push_row_to_dict(created)}


@app.delete("/api/security-push/configs/{config_id}")
async def delete_security_push_config(config_id: str, fb_user_id: str = Query(...)):
    _assert_known_user(fb_user_id)
    pool = _require_db()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT owner_fb_user_id FROM security_push_configs WHERE id = $1::uuid",
            config_id,
        )
        if row is None:
            return {"ok": True}
        if row["owner_fb_user_id"] != fb_user_id:
            raise HTTPException(status_code=403, detail="無權刪除此 config")
        await conn.execute(
            "DELETE FROM security_push_configs WHERE id = $1::uuid",
            config_id,
        )
    return {"ok": True}


@app.get("/api/security-push/configs/{config_id}/logs")
async def list_security_push_logs(
    config_id: str,
    fb_user_id: str = Query(...),
    limit: int = Query(20, ge=1, le=200),
):
    """Recent scheduler-tick audit log for a single config — surfaces
    「過去 N 次跑了幾次,每次偵測到幾個異常,推到幾個群組」 to the
    settings modal. Ordered newest-first."""
    _assert_known_user(fb_user_id)
    pool = _require_db()
    async with pool.acquire() as conn:
        owner = await conn.fetchrow(
            "SELECT owner_fb_user_id FROM security_push_configs WHERE id = $1::uuid",
            config_id,
        )
        if owner is None:
            raise HTTPException(status_code=404, detail="config 不存在")
        if owner["owner_fb_user_id"] != fb_user_id:
            raise HTTPException(status_code=403, detail="無權查看此 config")
        rows = await conn.fetch(
            """
            SELECT run_at, matches_count, pushed_groups, duration_ms, error
            FROM security_push_logs
            WHERE config_id = $1::uuid
            ORDER BY run_at DESC
            LIMIT $2
            """,
            config_id,
            limit,
        )
    return {
        "data": [
            {
                "run_at": r["run_at"].isoformat() if r["run_at"] else None,
                "matches_count": r["matches_count"],
                "pushed_groups": r["pushed_groups"],
                "duration_ms": r["duration_ms"],
                "error": r["error"],
            }
            for r in rows
        ]
    }


# ── Scan records (full match snapshots, browseable) ──────────────
class _ScanRecordMatch(BaseModel):
    """Loose schema — frontend sends whatever it has. We don't
    validate the inner shape because it'll be persisted verbatim
    as JSONB; consumers parse defensively. Only `campaign_id` is
    structurally required so we can de-dupe / reference later."""
    campaign_id: str
    name: Optional[str] = None
    objective: Optional[str] = None
    status: Optional[str] = None
    created_time: Optional[str] = None
    daily_budget: Optional[int] = None
    lifetime_budget: Optional[int] = None
    account_id: Optional[str] = None
    account_name: Optional[str] = None
    anomalies: List[str] = []
    creator: Optional[str] = None


class _ScanRecordPayload(BaseModel):
    account_ids: List[str] = []
    matches: List[_ScanRecordMatch] = []
    duration_ms: int = 0


@app.post("/api/security-scan/records")
async def post_security_scan_record(
    payload: _ScanRecordPayload,
    fb_user_id: str = Query(...),
):
    """Persist a manual 立即掃描 result into security_scan_records.

    Auto-scan records are written by `_security_push_tick` directly.
    Manual scans are user-triggered in the browser and bypass the
    scheduler entirely, so the frontend POSTs the matches here right
    after 立即掃描 completes.

    Best-effort: returns 200 even when storage is unavailable — the
    primary user-facing scan UX has already rendered by the time this
    fires; we don't want a DB hiccup to surface as a scan failure.
    """
    _assert_known_user(fb_user_id)
    if _db_pool is None:
        return {"ok": False, "reason": "db unavailable"}
    try:
        await _persist_scan_record(
            config_id=None,
            fb_user_id=fb_user_id,
            trigger_type="manual",
            scanned_at=datetime.now(timezone.utc),
            account_ids=payload.account_ids,
            matches=[m.dict() for m in payload.matches],
            duration_ms=payload.duration_ms,
        )
        return {"ok": True, "matches_count": len(payload.matches)}
    except Exception as e:
        print(f"[security-scan] manual record insert failed: {e}", flush=True)
        return {"ok": False, "reason": str(e)[:200]}


@app.get("/api/security-scan/records")
async def list_security_scan_records(
    fb_user_id: str = Query(...),
    limit: int = Query(20, ge=1, le=100),
    trigger: Optional[str] = Query(None, description="auto / manual / null=all"),
):
    """Browse recent scan records. `trigger=auto` filters to scheduler
    ticks, `manual` to user-initiated 立即掃描, null returns both."""
    _assert_known_user(fb_user_id)
    pool = _require_db()
    where = ["fb_user_id = $1"]
    params: list = [fb_user_id]
    if trigger in ("auto", "manual"):
        where.append(f"trigger_type = ${len(params) + 1}")
        params.append(trigger)
    params.append(limit)
    q = f"""
        SELECT id, config_id, trigger_type, scanned_at,
               account_ids, matches, matches_count, duration_ms
        FROM security_scan_records
        WHERE {' AND '.join(where)}
        ORDER BY scanned_at DESC
        LIMIT ${len(params)}
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(q, *params)
    out = []
    for r in rows:
        # asyncpg returns jsonb as a JSON-encoded string (same quirk
        # as everywhere else — see _security_push_enabled comment).
        # Decode once before sending to the frontend.
        raw_matches = r["matches"]
        if isinstance(raw_matches, str):
            try:
                matches = json.loads(raw_matches)
            except ValueError:
                matches = []
        else:
            matches = raw_matches or []
        out.append({
            "id": str(r["id"]),
            "config_id": str(r["config_id"]) if r["config_id"] else None,
            "trigger_type": r["trigger_type"],
            "scanned_at": r["scanned_at"].isoformat() if r["scanned_at"] else None,
            "account_ids": list(r["account_ids"] or []),
            "matches": matches,
            "matches_count": r["matches_count"],
            "duration_ms": r["duration_ms"],
        })
    return {"data": out}


class _TestCardPayload(BaseModel):
    id: str
    name: str
    status: Optional[str] = None
    created_time: str
    daily_budget: Optional[int] = None  # raw FB value, same scale as dashboard
    # Raw FB spend string from `insights.data[0].spend` (account currency
    # major unit, e.g. "62845.34"). Optional — frontend may omit if the
    # insights query hasn't resolved.
    spend: Optional[str] = None
    # Short label for the spend's date range, e.g. "本月" / "近 7 天" /
    # "5/1 ~ 5/24". Mirrors the DatePicker's `toShortLabel(date)` output.
    spend_range_label: Optional[str] = None
    account_name: str = ""
    anomalies: List[str] = []
    creator: Optional[str] = None


class SecurityPushTestPayload(BaseModel):
    # Snapshot of the cards the user is currently looking at on the
    # 待查看 tab. When provided, backend pushes these directly without
    # touching FB at all — avoids the test 5x re-scanning the entire
    # account list and getting rate-limited.
    cards: List[_TestCardPayload] = []


def _security_test_match_from_record(raw: Any) -> Optional[dict]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return None
    if not isinstance(raw, dict):
        return None

    campaign = raw.get("campaign")
    if isinstance(campaign, dict):
        campaign = dict(campaign)
    else:
        cid = raw.get("campaign_id") or raw.get("id")
        if not cid:
            return None
        campaign = {
            "id": cid,
            "name": raw.get("name") or raw.get("campaign_name"),
            "status": raw.get("status"),
            "created_time": raw.get("created_time"),
            "daily_budget": raw.get("daily_budget"),
            "lifetime_budget": raw.get("lifetime_budget"),
        }

    if not campaign.get("id"):
        return None
    return {
        "campaign": campaign,
        "account_id": raw.get("account_id") or "",
        "account_name": raw.get("account_name") or "",
        "anomalies": _security_anomaly_tags(raw.get("anomalies")),
        "creator": raw.get("creator"),
        "spend": raw.get("spend"),
        "spend_range_label": raw.get("spend_range_label"),
    }


async def _latest_security_scan_matches_for_test(
    conn: Any,
    *,
    config_id: str,
    fb_user_id: str,
) -> list[dict]:
    row = await conn.fetchrow(
        """
        SELECT matches
        FROM security_scan_records
        WHERE matches_count > 0
          AND (
            config_id = $1::uuid
            OR fb_user_id = $2
          )
        ORDER BY
          CASE WHEN config_id = $1::uuid THEN 0 ELSE 1 END,
          scanned_at DESC
        LIMIT 1
        """,
        config_id,
        fb_user_id,
    )
    if not row:
        return []
    out: list[dict] = []
    for raw in _jsonb_list(row["matches"]):
        m = _security_test_match_from_record(raw)
        if m:
            out.append(m)
    return out


@app.post("/api/security-push/configs/{config_id}/test")
async def test_security_push_config(
    config_id: str,
    fb_user_id: str = Query(...),
    payload: Optional[SecurityPushTestPayload] = None,
):
    """Fire a "live sample" push to every group in this config.

    Preferred path: caller posts `cards` (the campaigns currently
    visible in the 待查看 tab) and we push exactly those — zero FB
    calls, instant.

    If no cards are supplied, we send a synthetic sample. The test
    button verifies LINE plumbing; it must never trigger an FB scan.

    Does NOT advance `last_run_at`, so the next scheduler tick
    processes real events normally."""
    _assert_known_user(fb_user_id)
    pool = _require_db()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM security_push_configs WHERE id = $1::uuid",
            config_id,
        )
    if row is None:
        raise HTTPException(status_code=404, detail="config 不存在")
    if row["owner_fb_user_id"] != fb_user_id:
        raise HTTPException(status_code=403, detail="無權測試此 config")

    async with pool.acquire() as conn:
        ch_row = await conn.fetchrow(
            "SELECT access_token FROM line_channels WHERE id = $1 AND enabled",
            row["channel_id"],
        )
    if not ch_row or not ch_row["access_token"]:
        raise HTTPException(status_code=400, detail="LINE channel 已停用或缺 access_token")

    cfg = dict(row)

    test_source = "screen"
    if payload and payload.cards:
        # Snapshot path — zero FB calls. Just transcode the cards
        # into the shape `build_security_alert_flex` expects.
        matches = [
            {
                "campaign": {
                    "id": c.id,
                    "name": c.name,
                    "status": c.status,
                    "created_time": c.created_time,
                    "daily_budget": str(c.daily_budget) if c.daily_budget else None,
                },
                "account_id": "",
                "account_name": c.account_name,
                "anomalies": _security_anomaly_tags(c.anomalies),
                "creator": c.creator,
                "spend": c.spend,
                "spend_range_label": c.spend_range_label,
            }
            for c in payload.cards
        ]
    else:
        matches = []

    if not matches:
        test_source = "scan_record"
        async with pool.acquire() as conn:
            matches = await _latest_security_scan_matches_for_test(
                conn,
                config_id=config_id,
                fb_user_id=fb_user_id,
            )

    synthetic_used = False
    if not matches:
        test_source = "synthetic"
        # Last-resort synthetic sample so the user can verify LINE
        # plumbing even when no recent campaigns exist (new accounts,
        # paused-only accounts, or accounts whose campaigns are all
        # older than 30 days). Labeled clearly so recipients know
        # this is a connectivity probe, not a real alert.
        synthetic_used = True
        now_iso = datetime.now(timezone.utc).isoformat()
        matches = [
            {
                "campaign": {
                    "id": "test_synthetic",
                    "name": "[範例] 測試廣告活動",
                    "created_time": now_iso,
                    "daily_budget": "500",
                },
                "account_id": "",
                "account_name": "[範例帳戶]",
                "anomalies": _security_anomaly_tags(cfg.get("anomaly_filters")) or ["deep_night"],
                "creator": "[範例]",
                "spend": 0,
                "spend_range_label": None,
            }
        ]

    if _http_client is None:
        raise HTTPException(status_code=503, detail="伺服器尚未初始化,請稍後再試")

    # Build flex card carousel (one bubble per campaign) — same shape
    # the scheduler ships, so the test preview matches a real push.
    flex = line_client.build_security_alert_flex(
        matches,
        tz_name=str(_scheduler_tz()),
        view_url=_security_view_url(),
    )

    # Mark test pushes in the altText so recipients can tell sample
    # from production. (Body text already says 「Meta後台系統警示」.)
    if synthetic_used:
        flex["altText"] = f"[測試 · 範例資料] {flex.get('altText', '')}"
    elif test_source == "scan_record":
        flex["altText"] = f"[測試 · 最近掃描紀錄] {flex.get('altText', '')}"
    elif payload and payload.cards:
        flex["altText"] = f"[測試] {flex.get('altText', '')}"
    else:
        flex["altText"] = f"[測試] {flex.get('altText', '')}"

    errors: List[str] = []
    sent = 0
    group_ids = [str(g) for g in _jsonb_list(row["group_ids"]) if g]
    if not group_ids:
        raise HTTPException(status_code=400, detail="此設定沒有 LINE 群組")
    for gid in group_ids:
        try:
            await line_client.line_push(
                _http_client,
                gid,
                [flex],
                access_token=ch_row["access_token"],
            )
            sent += 1
        except line_client.LinePushError as e:
            errors.append(f"group {gid}: {e.friendly_message or e}")
        except httpx.HTTPError as e:
            errors.append(f"group {gid}: 連線錯誤 ({type(e).__name__})")
        except Exception as e:  # final safety net
            errors.append(f"group {gid}: {type(e).__name__}: {e}")

    if errors and sent == 0:
        raise HTTPException(status_code=502, detail="; ".join(errors))
    return {
        "ok": True,
        "sent": sent,
        "errors": errors,
        "fallback": False,
        "synthetic": synthetic_used,
        "source": test_source,
    }


# ── Scheduler loop ────────────────────────────────────────────

async def _scheduler_tick() -> None:
    """Run one pass: find due configs, push each, update bookkeeping.

    Uses `FOR UPDATE SKIP LOCKED` so two concurrent workers (or two
    overlapping ticks) never grab the same row — each row is owned
    by exactly one worker for the duration of the transaction.
    """
    _fb_call_source.set("line-push")
    if _db_pool is None:
        return
    now = datetime.now(timezone.utc)
    async with _db_pool.acquire() as conn:
        async with conn.transaction():
            # The `last_run_at < next_run_at` guard excludes rows another
            # worker grabbed this tick (their last_run_at was just bumped).
            # The 30-minute grace clause is the SELF-HEAL path: a row whose
            # push failed (or whose worker crashed mid-push) is left with
            # last_run_at >= next_run_at and would otherwise be stranded
            # FOREVER — the exact bug where a scheduled push silently never
            # fired again after one FB-throttled failure, while manual 測試
            # kept working. A real in-flight push finishes in seconds, so
            # anything still "grabbed" after 30 minutes is dead and safe to
            # re-run.
            due = await conn.fetch(
                """
                SELECT * FROM campaign_line_push_configs
                WHERE enabled
                  AND next_run_at <= $1
                  AND (
                    last_run_at IS NULL
                    OR last_run_at < next_run_at
                    OR last_run_at <= $1 - INTERVAL '30 minutes'
                  )
                ORDER BY next_run_at ASC
                LIMIT 50
                FOR UPDATE SKIP LOCKED
                """,
                now,
            )
            # Bump last_run_at inside the same txn so other workers'
            # `last_run_at < next_run_at` filter immediately excludes
            # these rows even before we push. The real next_run_at
            # update happens after push success below.
            if due:
                await conn.execute(
                    """
                    UPDATE campaign_line_push_configs
                    SET last_run_at = $1
                    WHERE id = ANY($2::uuid[])
                    """,
                    now,
                    [r["id"] for r in due],
                )

    # Per-tick cache so we only resolve allowed-config sets / limits
    # once per owner even if many of their configs are due in the
    # same tick.
    _grace_cache: dict[str, Optional[set]] = {}

    # Track the previous config's account so we can spread out
    # consecutive same-account pushes. FB's 80004 throttle is
    # per-ad-account; 50 due configs at 09:00 Friday with several
    # belonging to the same big-client account would otherwise hammer
    # that account back-to-back. 250ms between same-account pushes
    # turns "10 calls in 200ms" into "10 calls in 2.5s" — well below
    # the per-account ceiling without adding meaningful latency to
    # the user-facing schedule.
    _last_account_id: Optional[str] = None

    for row in due:
        cfg = _config_row_to_dict(row)
        # Spread out consecutive pushes targeting the same ad account.
        if _last_account_id and cfg.get("account_id") == _last_account_id:
            await asyncio.sleep(0.25)
        _last_account_id = cfg.get("account_id")
        # Tier limit gate: skip the push when the owning user has
        # already used up this calendar month's quota. We log the
        # skip + bump next_run_at so the row doesn't get re-grabbed
        # on the next tick (which would just hit the same cap).
        owner_uid = await _get_group_owner(cfg["group_id"])
        if owner_uid:
            # Grace-period gate (line_groups cap): once the user has
            # been over their tier's line_groups cap for >30 days, only
            # the OLDEST N configs (N = cap) are still allowed to fire.
            # The rest are skipped here so they don't burn the user's
            # monthly_push budget on configs they no longer pay for.
            blocked = await _grace_blocked(
                owner_uid, str(cfg["id"]), _grace_cache
            )
            if blocked:
                next_run_skip = _compute_next_run(
                    cfg["frequency"],
                    cfg["weekdays"],
                    cfg["month_day"],
                    cfg["hour"],
                    cfg["minute"],
                )
                err_msg = "已超過方案 LINE 群組推播上限,寬限期已結束,本次跳過"
                async with _db_pool.acquire() as conn:
                    await conn.execute(
                        """
                        UPDATE campaign_line_push_configs
                        SET last_run_at = $1, next_run_at = $2,
                            last_error = $3, updated_at = NOW()
                        WHERE id = $4::uuid
                        """,
                        now,
                        next_run_skip,
                        err_msg,
                        cfg["id"],
                    )
                    await conn.execute(
                        """
                        INSERT INTO line_push_logs (config_id, success, error)
                        VALUES ($1::uuid, FALSE, $2)
                        """,
                        cfg["id"],
                        err_msg,
                    )
                print(f"[scheduler] grace-expired skip: {cfg['id']}", flush=True)
                continue
            owner_limits = await _get_user_limits(owner_uid)
            push_cap = owner_limits["monthly_push"]
            if not _is_unlimited(push_cap):
                used = await _count_monthly_pushes(owner_uid)
                if used >= push_cap:
                    next_run_skip = _compute_next_run(
                        cfg["frequency"],
                        cfg["weekdays"],
                        cfg["month_day"],
                        cfg["hour"],
                        cfg["minute"],
                    )
                    err_msg = (
                        f"已達 {owner_limits['tier']} 方案每月 {push_cap} 次推播上限,本次跳過"
                    )
                    async with _db_pool.acquire() as conn:
                        await conn.execute(
                            """
                            UPDATE campaign_line_push_configs
                            SET last_run_at = $1, next_run_at = $2,
                                last_error = $3, updated_at = NOW()
                            WHERE id = $4::uuid
                            """,
                            now,
                            next_run_skip,
                            err_msg,
                            cfg["id"],
                        )
                        await conn.execute(
                            """
                            INSERT INTO line_push_logs (config_id, success, error)
                            VALUES ($1::uuid, FALSE, $2)
                            """,
                            cfg["id"],
                            err_msg,
                        )
                    print(f"[scheduler] tier-limit skip: {cfg['id']} ({err_msg})", flush=True)
                    continue
        # Set the per-user FB context so _build_flex_for_config's FB
        # API calls go through the channel owner's token (Phase A
        # multi-tenant isolation). Without this the scheduler would
        # fall back to the legacy global _runtime_token and could end
        # up calling FB as the wrong user — which on a multi-tenant
        # server would mean fetching ad insights from a DIFFERENT
        # agency's account. Reset the contextvar in finally so the
        # next iteration starts clean.
        ctx_token = None
        if owner_uid and _token_for_user(owner_uid):
            ctx_token = _current_fb_user_id.set(owner_uid)
        try:
            flex = await _build_flex_for_config(cfg)
            assert _http_client is not None
            creds = await _channel_creds_for_group(cfg["group_id"])
            if creds is None:
                raise RuntimeError("No enabled LINE channel for this group")
            await line_client.line_push(
                _http_client, cfg["group_id"], [flex], access_token=creds[2]
            )
            next_run = _compute_next_run(
                cfg["frequency"],
                cfg["weekdays"],
                cfg["month_day"],
                cfg["hour"],
                cfg["minute"],
            )
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE campaign_line_push_configs
                    SET last_run_at = $1, next_run_at = $2,
                        fail_count = 0, last_error = NULL, updated_at = NOW()
                    WHERE id = $3::uuid
                    """,
                    now,
                    next_run,
                    cfg["id"],
                )
                await conn.execute(
                    """
                    INSERT INTO line_push_logs (config_id, success, message_preview)
                    VALUES ($1::uuid, TRUE, $2)
                    """,
                    cfg["id"],
                    (flex.get("altText") or "")[:200],
                )
            print(
                f"[scheduler] pushed cfg={cfg['id']} group={cfg['group_id']}",
                flush=True,
            )
        except Exception as e:
            # Translate to actionable Chinese for the「last_error」column /
            # LINE push config row. Token-expired errors name WHO must
            # re-log in (the 官方帳號 owner, whose FB token the push uses).
            owner_name = await _fb_user_display_name(owner_uid)
            err_text = _friendly_push_error(e, owner_name=owner_name)
            fail_count = int(cfg.get("fail_count") or 0) + 1
            auto_disable = fail_count >= SCHEDULER_FAIL_THRESHOLD
            # Schedule a RETRY: next_run_at must move into the future,
            # or the due-filter's `last_run_at < next_run_at` guard
            # strands this row forever (the silent-no-push bug). Backoff
            # 10min × fail_count, but never past the next natural slot.
            # Transient FB throttle → push goes out ~10-30min late;
            # permanent errors (bot kicked, dead token) hit the fail
            # threshold within ~3 retries and auto-disable.
            next_natural = _compute_next_run(
                cfg["frequency"],
                cfg["weekdays"],
                cfg["month_day"],
                cfg["hour"],
                cfg["minute"],
            )
            retry_at = now + timedelta(minutes=10 * fail_count)
            next_retry = min(retry_at, next_natural)
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE campaign_line_push_configs
                    SET fail_count = $1, last_error = $2,
                        enabled = CASE WHEN $3 THEN FALSE ELSE enabled END,
                        next_run_at = $4,
                        updated_at = NOW()
                    WHERE id = $5::uuid
                    """,
                    fail_count,
                    err_text,
                    auto_disable,
                    next_natural if auto_disable else next_retry,
                    cfg["id"],
                )
                await conn.execute(
                    """
                    INSERT INTO line_push_logs (config_id, success, error)
                    VALUES ($1::uuid, FALSE, $2)
                    """,
                    cfg["id"],
                    err_text,
                )
            print(
                f"[scheduler] push FAILED cfg={cfg['id']} err={e}"
                f"{' (auto-disabled)' if auto_disable else ''}",
                flush=True,
            )
        finally:
            if ctx_token is not None:
                _current_fb_user_id.reset(ctx_token)


async def _scheduler_loop() -> None:
    """Long-running task — one tick every SCHEDULER_TICK_SECONDS.

    Any exception inside the tick is caught and logged so the loop
    itself never dies. CancelledError from shutdown propagates out.

    Layout: line push runs at the top of the tick. Security push is
    offset 30s into the tick so the two big background fan-outs don't
    land in the same second (they used to stack and double the
    background burst on FB right when user traffic was also at peak).
    """
    # Security push: default ENABLED. The UI checkbox in the push-
    # settings modal writes `security_push_master_enabled` to
    # shared_settings; the loop reads it each tick so operators can
    # pause/resume without a redeploy. The env `SECURITY_PUSH_ENABLED`
    # remains as an emergency kill switch — set it to "0" / "false"
    # to force-disable regardless of UI state (used during the FB
    # rate-limit incident where we needed an instant hard stop).
    env_off = (os.getenv("SECURITY_PUSH_ENABLED") or "").strip().lower() in (
        "0",
        "false",
        "no",
        "off",
    )
    print(
        f"[startup] security-push tick: env_kill_switch={'ON (force-off)' if env_off else 'OFF (UI controls)'}",
        flush=True,
    )
    try:
        while True:
            try:
                gate_reason = _background_gate_reason()
                if gate_reason:
                    print(f"[scheduler] skipping tick — {gate_reason}", flush=True)
                else:
                    await _scheduler_tick()
                    # 每月自動重熱上個月快照 — 絕大多數 tick 直接 no-op
                    # (已 done / 還在結算緩衝期),只有每月 3 號後第一次
                    # 會真的 fan-out。account_month_snapshots(全帳號)與
                    # lurefin 匯出快照(cost_center_snapshots)各自獨立。
                    try:
                        await _history_warm_auto_tick()
                    except Exception as e:
                        print(f"[history-warm] auto tick error: {e}", flush=True)
                    try:
                        await _cost_center_warm_auto_tick()
                    except Exception as e:
                        print(f"[cost-center-warm] auto tick error: {e}", flush=True)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[scheduler] tick error: {e}", flush=True)
            # 30s gap before the security push tick — staggers the two
            # background fan-outs so they don't both hammer FB in the
            # same second.
            await asyncio.sleep(SCHEDULER_TICK_SECONDS // 2)
            if not env_off and await _security_push_enabled():
                try:
                    gate_reason = _background_gate_reason()
                    if gate_reason:
                        print(
                            f"[security-push] skipping tick — {gate_reason}",
                            flush=True,
                        )
                    else:
                        await _security_push_tick()
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    print(f"[security-push] tick error: {e}", flush=True)
            # Sleep the remaining half-tick so the overall cadence
            # stays at SCHEDULER_TICK_SECONDS.
            await asyncio.sleep(SCHEDULER_TICK_SECONDS - (SCHEDULER_TICK_SECONDS // 2))
    except asyncio.CancelledError:
        print("[scheduler] stopped", flush=True)
        raise


async def _security_push_interval_hours() -> int:
    """Runtime gate + cadence for the security-push tick. Returns:
        0  → feature disabled (no auto-scan, manual test still works)
        1/2/6/12/24 → scan every N hours, aligned to local-clock slots

    Reads `shared_settings.security_push_interval_hours` first. Falls
    back to the legacy boolean key `security_push_master_enabled` so
    existing deployments that flipped the checkbox don't suddenly go
    silent — True maps to 1-hour cadence (the original behaviour).
    Defaults to **0** (disabled) when neither row is present so a
    fresh deploy never silently burns FB rate-limit budget.
    """
    if _db_pool is None:
        return 0
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM shared_settings WHERE key = 'security_push_interval_hours'"
            )
            if row is not None and row["value"] is not None:
                raw = row["value"]
                if isinstance(raw, str):
                    try:
                        raw = json.loads(raw)
                    except ValueError:
                        return 0
                try:
                    n = int(raw)
                except (TypeError, ValueError):
                    return 0
                return n if n in _VALID_SECURITY_PUSH_INTERVALS else 0
            # Legacy fallback — bool checkbox.
            legacy = await conn.fetchrow(
                "SELECT value FROM shared_settings WHERE key = 'security_push_master_enabled'"
            )
    except Exception:
        return 0  # fail-closed: any DB issue → don't push
    if legacy is None or legacy["value"] is None:
        return 0
    raw = legacy["value"]
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return 0
    return 1 if raw is True else 0


async def _security_push_enabled() -> bool:
    """Backwards-compat boolean gate. New code should use
    `_security_push_interval_hours()` directly."""
    return (await _security_push_interval_hours()) > 0


# ── 安全監控推播 (event-driven push on new-campaign anomalies) ───
#
# Detection mirrors `frontend/src/views/security/securityData.ts` so
# both surfaces flag the same campaigns. Keep the two in sync when
# adding new anomaly rules.

# Daily-budget threshold — RAW FB value (matches dashboard's
# `fM(campaign.daily_budget)`, no /100 transform).
_SECURITY_HIGH_BUDGET = 2000


def _effective_daily_budget(c: dict) -> Optional[int]:
    """Return effective daily budget for a campaign in the RAW FB
    value (same scale dashboard renders directly).

    CBO: campaign.daily_budget is set. Use it.
    ABO: campaign budget is empty; sum ACTIVE adsets' daily_budget.
    Neither: return None.
    """
    raw = c.get("daily_budget")
    if raw:
        try:
            n = int(raw)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    adsets = (c.get("adsets") or {}).get("data") or []
    total = 0
    any_found = False
    for a in adsets:
        if not isinstance(a, dict):
            continue
        if a.get("status") in ("ARCHIVED", "DELETED"):
            continue
        try:
            v = int(a.get("daily_budget") or 0)
            if v > 0:
                total += v
                any_found = True
        except (TypeError, ValueError):
            continue
    return total if any_found else None


def _evaluate_campaign_anomalies(c: dict) -> List[str]:
    """Detect anomalies for one campaign. Returns the list of tags
    (subset of "deep_night" / "weekend" / "high_budget"). `burst` is
    cross-campaign so it's evaluated in the caller, not here."""
    tags: List[str] = []
    created = c.get("created_time")
    if not created:
        return tags
    try:
        # FB format: "2026-05-22T15:30:00+0000". Python 3.9 doesn't
        # accept the "+0000" suffix in fromisoformat; normalise to
        # "+00:00" first.
        iso = created
        if len(iso) >= 5 and iso[-5] in ("+", "-") and iso[-3] != ":":
            iso = iso[:-2] + ":" + iso[-2:]
        dt_utc = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return tags
    local = dt_utc.astimezone(_scheduler_tz())
    if local.hour < 6:
        tags.append("deep_night")
    if local.weekday() in (5, 6):  # Sat=5, Sun=6
        tags.append("weekend")
    budget = _effective_daily_budget(c)
    if budget is not None and budget > _SECURITY_HIGH_BUDGET:
        tags.append("high_budget")
    if _has_abnormal_language(c.get("name") or ""):
        tags.append("abnormal_language")
    return tags


def _has_abnormal_language(name: str) -> bool:
    """Mirror of frontend `hasAbnormalLanguage`: flag campaign names
    containing any character outside ASCII + CJK + common Chinese
    punctuation. Keeps Vietnamese, Cyrillic, Arabic, Thai, kana, etc.
    out of the "normal" set."""
    for ch in name:
        code = ord(ch)
        if code < 0x80:
            continue
        if 0x4E00 <= code <= 0x9FFF:
            continue
        if 0x3400 <= code <= 0x4DBF:
            continue
        if 0x20000 <= code <= 0x2FFFF:
            continue
        if 0x2000 <= code <= 0x206F:
            continue
        if 0x3000 <= code <= 0x303F:
            continue
        if 0xFF00 <= code <= 0xFFEF:
            continue
        return True
    return False


def _jsonb_list(value: Any) -> list:
    """Decode asyncpg JSONB-ish values into a Python list.

    asyncpg may hand jsonb back as a JSON string in this codebase. Never
    iterate raw strings here: `"["act_1"]"` would become one fake
    account id per character and explode the security scan fan-out.
    """
    if value is None:
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


_SECURITY_ANOMALY_TAGS = {
    "deep_night",
    "weekend",
    "high_budget",
    "burst",
    "abnormal_language",
}


def _security_anomaly_tags(value: Any) -> list[str]:
    """Return validated anomaly tags from ARRAY / JSONB / string input."""
    raw = _jsonb_list(value)
    out: list[str] = []
    for item in raw:
        tag = str(item or "").strip()
        if tag in _SECURITY_ANOMALY_TAGS and tag not in out:
            out.append(tag)
    return out


_ANOMALY_LABELS = {
    "deep_night": "深夜創建",
    "weekend": "週末創建",
    "high_budget": "日預算 > $2000",
    "burst": "短時間高頻",
    "abnormal_language": "異常語言",
}


async def _load_safe_campaign_ids() -> set:
    """Team-wide set of campaign ids the user has explicitly marked
    「沒問題」 in the security view. Stored in
    `shared_settings.security_safe_campaigns` as a JSONB string array.
    Scheduler should NOT push these — they're already reviewed."""
    if _db_pool is None:
        return set()
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM shared_settings WHERE key = 'security_safe_campaigns'"
        )
    if not row or not row["value"]:
        return set()
    # asyncpg returns JSONB as a JSON-encoded string. Decode first so
    # iterating yields list elements, not characters of the JSON text.
    value = row["value"]
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return set()
    try:
        return {str(x) for x in value if x}
    except (TypeError, ValueError):
        return set()


def _serialize_match_for_record(m: dict) -> dict:
    """Trim a `_collect_security_matches` row down to a stable, JSON-safe
    payload for persistence in `security_scan_records.matches` JSONB.

    Drops internal sort keys + ensures all values are JSON-compatible
    primitives (numbers / strings / lists / None). Keeps the fields
    the UI / future timeline browser would actually want.
    """
    c = m.get("campaign") or {}
    if not c and (m.get("campaign_id") or m.get("id")):
        return {
            "campaign_id": m.get("campaign_id") or m.get("id"),
            "name": m.get("name") or m.get("campaign_name"),
            "objective": m.get("objective"),
            "status": m.get("status"),
            "created_time": m.get("created_time"),
            "daily_budget": m.get("daily_budget"),
            "lifetime_budget": m.get("lifetime_budget"),
            "account_id": m.get("account_id"),
            "account_name": m.get("account_name"),
            "anomalies": list(m.get("anomalies") or []),
            "creator": m.get("creator"),
            "spend": m.get("spend"),
            "spend_range_label": m.get("spend_range_label"),
        }
    return {
        "campaign_id": c.get("id"),
        "name": c.get("name"),
        "objective": c.get("objective"),
        "status": c.get("status"),
        "created_time": c.get("created_time"),
        "daily_budget": c.get("daily_budget"),
        "lifetime_budget": c.get("lifetime_budget"),
        "account_id": m.get("account_id"),
        "account_name": m.get("account_name"),
        "anomalies": list(m.get("anomalies") or []),
        "creator": m.get("creator"),
    }


async def _persist_scan_record(
    *,
    config_id: Optional[str],
    fb_user_id: Optional[str],
    trigger_type: str,
    scanned_at: datetime,
    account_ids: List[str],
    matches: List[dict],
    duration_ms: int,
) -> None:
    """Insert one row into `security_scan_records`. Best-effort —
    a logging failure must NEVER cause the actual scan to be reported
    as failed."""
    if _db_pool is None:
        return
    payload = [_serialize_match_for_record(m) for m in matches]
    async with _db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO security_scan_records
                (config_id, fb_user_id, trigger_type, scanned_at,
                 account_ids, matches, matches_count, duration_ms)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
            """,
            config_id,
            fb_user_id,
            trigger_type,
            scanned_at,
            list(account_ids or []),
            json.dumps(payload),
            len(payload),
            int(duration_ms),
        )


def _clone_security_match(m: dict) -> dict:
    out = dict(m)
    if isinstance(out.get("campaign"), dict):
        out["campaign"] = dict(out["campaign"])
    out["anomalies"] = list(out.get("anomalies") or [])
    return out


def _parse_fb_created_time(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        iso = str(value)
        if len(iso) >= 5 and iso[-5] in ("+", "-") and iso[-3] != ":":
            iso = iso[:-2] + ":" + iso[-2:]
        dt = datetime.fromisoformat(iso)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


async def _security_config_account_ids(cfg: dict, *, max_accounts: Optional[int] = None) -> list[str]:
    owner_uid = cfg["owner_fb_user_id"]
    account_ids = list(cfg.get("account_ids") or [])
    if not account_ids:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM user_settings WHERE fb_user_id = $1 AND key = 'selected_accounts'",
                owner_uid,
            )
        if row and row["value"]:
            account_ids = [str(x) for x in _jsonb_list(row["value"]) if x]
    # Preserve first-seen order while removing duplicate account ids.
    account_ids = list(dict.fromkeys(account_ids))
    if max_accounts is not None and max_accounts > 0:
        account_ids = account_ids[:max_accounts]
    return account_ids


def _filter_security_matches_for_config(
    matches: list[dict],
    cfg: dict,
    since_dt: datetime,
    *,
    require_anomaly: bool,
    limit: Optional[int],
    safe_ids: set,
) -> list[dict]:
    filters = set(_security_anomaly_tags(cfg.get("anomaly_filters")))
    if not filters:
        filters = {"deep_night", "weekend", "high_budget"}

    out: list[dict] = []
    for raw in matches:
        m = _clone_security_match(raw)
        c = m.get("campaign") or {}
        cid = c.get("id")
        if cid and cid in safe_ids:
            continue
        created_dt = m.get("_created_dt")
        if not isinstance(created_dt, datetime):
            created_dt = _parse_fb_created_time(c.get("created_time"))
            if not created_dt:
                continue
            m["_created_dt"] = created_dt
        if created_dt <= since_dt:
            continue
        hit = [t for t in (m.get("anomalies") or []) if t in filters]
        if require_anomaly and not hit:
            continue
        m["anomalies"] = hit
        out.append(m)

    out.sort(key=lambda x: x["_created_dt"], reverse=True)
    if limit is not None:
        out = out[:limit]
    for m in out:
        m.pop("_created_dt", None)
    return out


async def _collect_security_matches_cached(
    cfg: dict,
    since_dt: datetime,
    *,
    require_anomaly: bool = True,
    limit: Optional[int] = None,
    exclude_safe: bool = True,
) -> list[dict]:
    """Share one FB scan across configs with the same owner/account set.

    Cache entries retain all anomaly candidates, then each config applies
    its own anomaly filter and LINE destinations. Auto-scan uses the same
    month-to-date snapshot window as manual scan, so configs due in the
    same scheduler tick can share the expensive FB fetch.
    """
    if _db_pool is None:
        return []
    owner_uid = cfg["owner_fb_user_id"]
    account_ids = await _security_config_account_ids(cfg)
    if not account_ids:
        return []
    key = (owner_uid, tuple(sorted(account_ids)))
    now = time.monotonic()
    for old_key, old_entry in list(_security_push_scan_cache.items()):
        if now - float(old_entry.get("ts", 0)) > _SECURITY_PUSH_SCAN_CACHE_TTL_SECONDS:
            _security_push_scan_cache.pop(old_key, None)
    safe_ids = await _load_safe_campaign_ids() if exclude_safe else set()

    entry = _security_push_scan_cache.get(key)
    if entry:
        age = now - float(entry.get("ts", 0))
        cached_since = entry.get("since_dt")
        if (
            age <= _SECURITY_PUSH_SCAN_CACHE_TTL_SECONDS
            and isinstance(cached_since, datetime)
            and cached_since <= since_dt
        ):
            print(
                f"[security-push] scan cache hit owner={owner_uid} accounts={len(account_ids)} age={int(age)}s",
                flush=True,
            )
            return _filter_security_matches_for_config(
                list(entry.get("matches") or []),
                cfg,
                since_dt,
                require_anomaly=require_anomaly,
                limit=limit,
                safe_ids=safe_ids,
            )

    scan_cfg = {
        **cfg,
        "account_ids": account_ids,
        "anomaly_filters": list(_SECURITY_ANOMALY_TAGS),
    }
    matches = await _collect_security_matches(
        scan_cfg,
        since_dt,
        require_anomaly=True,
        limit=None,
        exclude_safe=False,
        keep_created_dt=True,
    )
    _security_push_scan_cache[key] = {
        "ts": now,
        "since_dt": since_dt,
        "matches": [_clone_security_match(m) for m in matches],
    }
    return _filter_security_matches_for_config(
        matches,
        cfg,
        since_dt,
        require_anomaly=require_anomaly,
        limit=limit,
        safe_ids=safe_ids,
    )


async def _collect_security_matches(
    cfg: dict,
    since_dt: datetime,
    *,
    require_anomaly: bool = True,
    limit: Optional[int] = None,
    max_accounts: Optional[int] = None,
    exclude_safe: bool = True,
    keep_created_dt: bool = False,
) -> List[dict]:
    """Pull campaigns created since `since_dt` for the config's accounts
    and (optionally) filter to those whose anomalies intersect
    `cfg["anomaly_filters"]`. Each match is enriched with
    `account_name` + `creator` via FB Activity Log.

    Account fetches run IN PARALLEL via asyncio.gather so an 80-account
    scan completes in roughly the time of the slowest single account
    instead of the sum. `max_accounts` caps the scan width — set it
    to a small number (e.g. 10) for the test endpoint so it returns
    within HTTP timeout instead of fanning out to every selected
    account.

    Assumes the caller has already set the `_current_fb_user_id`
    contextvar to the config's owner so FB calls go through the right
    token.
    """
    if _db_pool is None:
        return []
    account_ids = await _security_config_account_ids(cfg, max_accounts=max_accounts)
    if not account_ids:
        return []

    filters = set(_security_anomaly_tags(cfg.get("anomaly_filters")))
    if not filters:
        filters = {"deep_night", "weekend", "high_budget"}
    safe_ids = await _load_safe_campaign_ids() if exclude_safe else set()

    # Cap parallel fan-out so a 30-account config doesn't burst 30
    # simultaneous campaign fetches against FB. Default 2 in-flight
    # because this is background work; operators can raise it via
    # SECURITY_SCAN_CONCURRENCY after watching BUCU.
    scan_sem = asyncio.Semaphore(_SECURITY_SCAN_CONCURRENCY)

    async def _scan_one(aid: str) -> list:
        async with scan_sem:
            return await _scan_one_inner(aid)

    async def _scan_one_inner(aid: str) -> list:
        out: list = []
        try:
            # Keep this aligned with the manual security scan:
            # fetch a wide metadata-only campaign list, then filter by
            # created_time locally. No pre-scan, no last-hour delta.
            camps = await _fetch_campaigns_for_account(
                aid,
                date_preset="last_90d",
                time_range=None,
                include_archived=True,
                lite=True,
                include_adsets=False,
            )
        except HTTPException as e:
            print(f"[security-push] fetch {aid} failed: {e.detail}", flush=True)
            return out
        for c in camps:
            cid = c.get("id")
            if cid and cid in safe_ids:
                continue  # already reviewed by the team
            created = c.get("created_time")
            if not created:
                continue
            try:
                iso = created
                if len(iso) >= 5 and iso[-5] in ("+", "-") and iso[-3] != ":":
                    iso = iso[:-2] + ":" + iso[-2:]
                created_dt = datetime.fromisoformat(iso)
            except (TypeError, ValueError):
                continue
            if created_dt <= since_dt:
                continue
            tags = _evaluate_campaign_anomalies(c)
            hit = [t for t in tags if t in filters]
            if require_anomaly and not hit:
                continue
            out.append(
                {
                    "campaign": c,
                    "account_id": aid,
                    "account_name": "",
                    "anomalies": hit,
                    "creator": None,
                    "_created_dt": created_dt,
                }
            )
        return out

    # Parallel fan-out. return_exceptions=True so one bad account
    # doesn't tank the whole gather; we already swallow HTTPException
    # inside _scan_one but a stray exception type would otherwise
    # propagate and kill the test endpoint.
    per_account = await asyncio.gather(
        *(_scan_one(aid) for aid in account_ids),
        return_exceptions=True,
    )
    matches: List[dict] = []
    for r in per_account:
        if isinstance(r, list):
            matches.extend(r)

    if not matches:
        return []

    # Sort newest-first then trim.
    matches.sort(key=lambda m: m["_created_dt"], reverse=True)
    if limit is not None:
        matches = matches[:limit]

    # Enrich: account names. Best-effort and cached by fb_get_paginated.
    try:
        accts_raw = await fb_get_paginated(
            "me/adaccounts",
            {"fields": "id,name", "limit": "500"},
        )
        name_by_aid = {a.get("id"): a.get("name", "") for a in accts_raw if isinstance(a, dict)}
    except HTTPException:
        name_by_aid = {}
    for m in matches:
        m["account_name"] = name_by_aid.get(m["account_id"], "")

    if not _SECURITY_PUSH_ENRICH_CREATORS:
        for m in matches:
            if not keep_created_dt:
                m.pop("_created_dt", None)
        return matches

    since_epoch = int(since_dt.timestamp())
    until_epoch = int(datetime.now(timezone.utc).timestamp())
    affected_aids = list({m["account_id"] for m in matches})

    # Reuse the same conservative gate for activities fan-out so we don't
    # burst 30 concurrent /activities calls right after the campaigns
    # fan-out settled.
    act_sem = asyncio.Semaphore(_SECURITY_SCAN_CONCURRENCY)

    async def _fetch_activities(aid: str) -> list:
        # We ONLY need create-campaign events to attach a creator name
        # to each card — FB-side `filtering` strips the (often 10x larger)
        # mass of create_ad / update_budget / pause_adset entries before
        # paging. Combined with max_pages=2 this keeps even very active
        # accounts under ~2 page fetches instead of 10+.
        async with act_sem:
            try:
                return await fb_get_paginated(
                    f"{aid}/activities",
                    {
                        "since": str(since_epoch),
                        "until": str(until_epoch),
                        "fields": "actor_name,event_type,object_id,translated_event_type",
                        "limit": "500",
                        "filtering": _json.dumps(
                            [
                                {
                                    "field": "event_type",
                                    "operator": "IN",
                                    "value": ["create_campaign_group"],
                                }
                            ]
                        ),
                    },
                    max_pages=2,
                )
            except HTTPException:
                return []

    activities_per_aid = await asyncio.gather(
        *(_fetch_activities(aid) for aid in affected_aids),
        return_exceptions=True,
    )
    creator_by_cid: dict = {}
    for acts in activities_per_aid:
        if not isinstance(acts, list):
            continue
        for a in acts:
            if not isinstance(a, dict):
                continue
            oid = a.get("object_id")
            if not oid or oid in creator_by_cid:
                continue
            evt = (a.get("event_type") or "").lower()
            tEvt = a.get("translated_event_type") or ""
            if "create" in evt or "建立" in tEvt:
                nm = (a.get("actor_name") or "").strip()
                if nm:
                    creator_by_cid[oid] = nm
    for m in matches:
        m["creator"] = creator_by_cid.get(m["campaign"].get("id"))
        if not keep_created_dt:
            # Drop the internal sort key before returning.
            m.pop("_created_dt", None)

    return matches


async def _security_push_run_one(cfg: dict) -> dict:
    """Process a single security_push_configs row: run a month-to-date
    scan, flag matches, and push the current result to LINE.

    Returns ``{matches_count, pushed_groups, matches}``. The caller
    persists the count + summary into ``security_push_logs`` AND
    the full matches list into ``security_scan_records`` so the team
    can browse「上週這個 config 偵測過什麼」without re-hitting FB.
    """
    owner_uid = cfg["owner_fb_user_id"]
    if not owner_uid:
        raise RuntimeError("config has no owner_fb_user_id")

    # Resolve channel access_token
    if _db_pool is None:
        return {"matches_count": 0, "pushed_groups": 0, "matches": []}
    async with _db_pool.acquire() as conn:
        ch_row = await conn.fetchrow(
            "SELECT access_token FROM line_channels WHERE id = $1 AND enabled",
            cfg["channel_id"],
        )
    if not ch_row or not ch_row["access_token"]:
        raise RuntimeError("channel disabled or missing access_token")
    access_token = ch_row["access_token"]

    since_dt = _security_auto_scan_since_dt()
    account_ids = await _security_config_account_ids(cfg)

    pushed_groups = 0

    # Pull campaigns under the owner's FB token context.
    ctx_token = _current_fb_user_id.set(owner_uid)
    try:
        scan_cfg = {**cfg, "account_ids": account_ids}
        matches = await _collect_security_matches_cached(
            scan_cfg, since_dt, require_anomaly=True, limit=None
        )
        if not matches:
            return {
                "matches_count": 0,
                "pushed_groups": 0,
                "matches": [],
                "account_ids": account_ids,
            }

        # Auto-scan intentionally re-runs the same month-to-date window
        # as manual「立即掃描」. If the result is unchanged, push it again:
        # each scheduled scan result should be delivered directly.
        flex = line_client.build_security_alert_flex(
            matches,
            tz_name=str(_scheduler_tz()),
            view_url=_security_view_url(),
        )
        for gid in [str(gid) for gid in (cfg.get("group_ids") or []) if gid]:
            try:
                await line_client.line_push(
                    _http_client,
                    gid,
                    [flex],
                    access_token=access_token,
                )
                pushed_groups += 1
            except line_client.LinePushError as e:
                print(f"[security-push] push group={gid} failed: {e}", flush=True)
        return {
            "matches_count": len(matches),
            "pushed_groups": pushed_groups,
            "matches": matches,
            "account_ids": account_ids,
        }
    finally:
        _current_fb_user_id.reset(ctx_token)


async def _security_push_tick() -> None:
    """Find due security_push_configs and process each. Mirrors the
    LIMIT 50 + FOR UPDATE SKIP LOCKED pattern from _scheduler_tick."""
    _fb_call_source.set("security-push")
    if _db_pool is None:
        return
    interval_hours = await _security_push_interval_hours()
    if interval_hours == 0:
        # Belt-and-suspenders gate; the scheduler loop already checks
        # this before calling, but if the setting flipped between the
        # gate read and now we want to bail out cleanly.
        return
    now = datetime.now(timezone.utc)
    async with _db_pool.acquire() as conn:
        async with conn.transaction():
            due = await conn.fetch(
                """
                SELECT * FROM security_push_configs
                WHERE enabled AND next_run_at <= $1
                ORDER BY next_run_at ASC
                LIMIT $2
                FOR UPDATE SKIP LOCKED
                """,
                now,
                _SECURITY_PUSH_MAX_CONFIGS_PER_TICK,
            )
    for row in due:
        cfg = dict(row)
        cid = cfg["id"]
        next_run_at = _next_security_push_run_at(now, interval_hours)
        start_mono = time.monotonic()
        run_result: dict = {"matches_count": 0, "pushed_groups": 0}
        run_error: Optional[str] = None
        try:
            run_result = await _security_push_run_one(cfg) or run_result
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE security_push_configs
                    SET last_run_at = $2,
                        next_run_at = $3,
                        last_error = NULL,
                        fail_count = 0,
                        updated_at = $2
                    WHERE id = $1
                    """,
                    cid,
                    now,
                    next_run_at,
                )
        except Exception as e:
            run_error = str(e)[:500]
            print(f"[security-push] config={cid} run failed: {e}", flush=True)
            async with _db_pool.acquire() as conn:
                # Update last_run_at on failure too — operator needs to
                # see「tick 確實有跑,只是失敗」not「上次檢查停在 3 天
                # 前」(which is what happened when we only set this
                # on success). last_success_at stays at the older
                # successful tick time so you can still see「上次成
                # 功」separately in the modal.
                await conn.execute(
                    """
                    UPDATE security_push_configs
                    SET last_run_at = $3,
                        last_error = $2,
                        fail_count = fail_count + 1,
                        next_run_at = $4,
                        updated_at = $3,
                        enabled = CASE WHEN fail_count + 1 >= 5 THEN FALSE ELSE enabled END
                    WHERE id = $1
                    """,
                    cid,
                    run_error,
                    now,
                    next_run_at,
                )
        # Audit row — written for BOTH success and failure paths so the
        # UI timeline shows ticks that fired but found nothing,
        # ticks that pushed, and ticks that errored. Best-effort insert
        # so a logging hiccup never escalates to disabling the config.
        duration_ms = int((time.monotonic() - start_mono) * 1000)
        try:
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO security_push_logs
                        (config_id, run_at, matches_count, pushed_groups, duration_ms, error)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    """,
                    cid,
                    now,
                    int(run_result.get("matches_count", 0)),
                    int(run_result.get("pushed_groups", 0)),
                    duration_ms,
                    run_error,
                )
        except Exception as e:
            print(f"[security-push] config={cid} log insert failed: {e}", flush=True)
        # Snapshot the full match list for browseable history (separate
        # table because security_push_logs is high-frequency counters).
        try:
            matches = run_result.get("matches") or []
            account_ids = list(run_result.get("account_ids") or cfg.get("account_ids") or [])
            await _persist_scan_record(
                config_id=cid,
                fb_user_id=cfg.get("owner_fb_user_id"),
                trigger_type="auto",
                scanned_at=now,
                account_ids=account_ids,
                matches=matches,
                duration_ms=duration_ms,
            )
        except Exception as e:
            print(f"[security-push] config={cid} scan record insert failed: {e}", flush=True)


# ── Cache warm-refresh loop ───────────────────────────────────
#
# Refreshes (account, kind, date) tuples that have been accessed in
# the last 10 minutes AND are within the last 90s of their cache TTL.
# Goal: keep the working set of accounts users actually look at "always
# warm" — first dashboard / share-page open lands on a hit instead of
# paying the FB round-trip latency. The loop is bounded so we never
# add more than 5 background FB calls per minute, and backs off
# entirely for 10 minutes after seeing any 80004 throttle response.

_WARM_TICK_SECONDS = 60
_WARM_RECENT_ACCESS_S = 600  # only refresh entries seen in last 10min
_WARM_REFRESH_WINDOW_S = 90  # refresh when ≤90s of TTL remains
# 3/min (was 5) — warm traffic burns the same app/user-level hourly
# budget that code 4/17 throttles enforce; with stale-cache fallback
# in place a cold cache entry is no longer catastrophic, so spend
# less of the budget on speculative refreshes.
_WARM_MAX_PER_TICK = _env_int("WARM_MAX_PER_TICK", 3)
_WARM_THROTTLE_BACKOFF_S = 600


async def _cache_warm_tick() -> None:
    source_token = _fb_call_source.set("warm")
    try:
        now = time.monotonic()
        if _last_ads_throttle_at and (now - _last_ads_throttle_at) < _WARM_THROTTLE_BACKOFF_S:
            return
        # Self-imposed BUCU gate — pauses background work when any account
        # crosses 80% on any metric, even if FB hasn't explicitly told us
        # to wait yet. Without this, the warm loop keeps pushing already-
        # hot accounts higher (處理時間 climbs faster than CPU / count
        # for heavy accounts like !B 新城區) until FB finally throttles —
        # by which point BUCU is at 95%+ and recovery takes ages.
        reason = _background_gate_reason()
        if reason:
            print(f"[warm-loop] skipping tick — {reason}", flush=True)
            return

        # Pick up to _WARM_MAX_PER_TICK candidates: recently accessed
        # entries whose last warm attempt is old enough that they may be
        # entering the final refresh window. Background refreshes do not
        # update last_seen, so a target naturally ages out after the user
        # stops looking at it.
        candidates: list[tuple[float, WarmTargetKey]] = []
        expired_targets: list[WarmTargetKey] = []
        min_attempt_gap = max(0.0, _CACHE_TTL_SECONDS - _WARM_REFRESH_WINDOW_S)
        for key, last_seen in list(_warm_targets.items()):
            if (now - last_seen) > _WARM_RECENT_ACCESS_S:
                expired_targets.append(key)
                continue
            last_attempt = _warm_attempted_at.get(key, 0.0)
            if (now - last_attempt) < min_attempt_gap:
                continue
            candidates.append((last_seen, key))
        for key in expired_targets:
            _warm_targets.pop(key, None)
            _warm_attempted_at.pop(key, None)

        candidates.sort(reverse=True)  # most recent first
        refreshed = 0
        for _, (account_id, kind, date_preset, time_range, uid) in candidates:
            if refreshed >= _WARM_MAX_PER_TICK:
                break
            # User logged out / token revoked → skip silently. Next time
            # they log in, fresh warm entries get registered under the
            # new login.
            if not _token_for_user(uid):
                continue
            _warm_attempted_at[(account_id, kind, date_preset, time_range, uid)] = now
            ctx_token = _current_fb_user_id.set(uid)
            try:
                if kind == "insights":
                    await _fetch_account_insights(account_id, date_preset, time_range)
                elif kind == "campaigns":
                    # Warm refresh matches the dashboard's primary use
                    # (include_adsets=False). Security view's cache entry
                    # (include_adsets=True) is a different key and doesn't
                    # warm — that's intentional, security push uses
                    # lite=True which doesn't register warm targets anyway.
                    await _fetch_campaigns_for_account(
                        account_id, date_preset, time_range,
                        include_archived=False, lite=False, include_adsets=False,
                    )
                refreshed += 1
            except Exception:
                # Any failure (incl. fresh 80004) — bail and let the next
                # tick retry. _last_ads_throttle_at gets set inside the
                # FB error handler so the next tick's backoff guard fires.
                return
            finally:
                _current_fb_user_id.reset(ctx_token)
            # Spread out the refreshes a little so bursts of warm-loop
            # activity don't themselves contribute to throttle.
            await asyncio.sleep(0.5)
    finally:
        _fb_call_source.reset(source_token)


async def _cache_warm_loop() -> None:
    """Periodic background cache refresh. Kept lean and conservative —
    if it ever causes problems it's safe to disable by leaving the
    task uninstalled."""
    try:
        while True:
            try:
                await _cache_warm_tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[warm] tick error: {e}", flush=True)
            await asyncio.sleep(_WARM_TICK_SECONDS)
    except asyncio.CancelledError:
        print("[warm] stopped", flush=True)
        raise


# ── 成效優化中心 — action-first advisor ───────────────────────────
#
# Internally we still reuse the six specialist persona prompts as
# reference material, but the product surface is a single synthesized
# action plan. Users should not have to reconcile six separate opinions.

AGENT_META = [
    {
        "id": "action_plan",
        "name_zh": "行動建議",
        "name_en": "Action Plan",
        "role_zh": "依帳戶 / 嚴重程度",
        "emoji": "✓",
        "color": "#fb5a28",
    },
]


def _load_agent_prompts() -> dict:
    """Return the persona system-prompts. Imported from the
    `agent_personas` Python module so the bytes are guaranteed to
    ship with the deploy artefact (the previous disk-read approach
    silently failed on Zeabur whenever the agent_personas/ folder
    didn't make it into the runtime image)."""
    from agent_personas import PERSONAS

    return PERSONAS


def _combined_agent_prompt(prompts: dict) -> str:
    bodies = [str(v).strip() for _, v in sorted(prompts.items()) if str(v).strip()]
    if not bodies:
        raise RuntimeError("persona 內容空白(deploy 未包含 agent_personas 檔案?)")
    return "\n\n---\n\n".join(bodies)


@app.get("/api/optimization/agents")
async def list_optimization_agents():
    """Return the single action-plan card metadata."""
    return {"data": list(AGENT_META)}


@app.get("/api/optimization/health")
async def optimization_health():
    """Diagnostic endpoint — verifies agent_personas module loaded
    + GEMINI_API_KEY set + DB column present, without burning any
    Gemini tokens. Useful for triaging "API 500: HTTP 500" without
    SSH'ing into the deploy."""
    out: dict = {
        "gemini_api_key_set": bool(GEMINI_API_KEY),
        "gemini_model": GEMINI_MODEL,
    }
    try:
        prompts = _load_agent_prompts()
        out["personas_loaded"] = len(prompts)
        out["personas_total_chars"] = sum(len(v) for v in prompts.values())
        out["personas_ids"] = sorted(prompts.keys())
    except Exception as exc:
        out["personas_error"] = f"{exc.__class__.__name__}: {exc}"
    if _db_pool is not None:
        try:
            async with _db_pool.acquire() as conn:
                col = await conn.fetchval(
                    """
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'subscriptions'
                      AND column_name = 'agent_advice_limit'
                    """
                )
                out["agent_advice_column_exists"] = bool(col)
                tbl = await conn.fetchval(
                    """
                    SELECT 1 FROM information_schema.tables
                    WHERE table_name = 'agent_advice_runs'
                    """
                )
                out["agent_advice_runs_table_exists"] = bool(tbl)
        except Exception as exc:
            out["db_error"] = f"{exc.__class__.__name__}: {exc}"
    return out


class CampaignDigest(BaseModel):
    """Compact snapshot of one campaign that the frontend ships up
    with each agent-advice request. Keeps the prompt small enough
    that the LLM can read 30+ campaigns in one pass."""

    name: str
    account_name: Optional[str] = None
    objective: Optional[str] = None
    status: Optional[str] = None
    spend: float = 0
    impressions: float = 0
    clicks: float = 0
    ctr: float = 0
    cpc: float = 0
    cpm: float = 0
    frequency: float = 0
    msgs: int = 0
    msg_cost: float = 0
    purchases: int = 0
    cost_per_purchase: float = 0
    roas: float = 0
    leads: int = 0
    cost_per_lead: float = 0
    add_to_cart: int = 0
    cost_per_add_to_cart: float = 0
    engagements: int = 0
    cost_per_engagement: float = 0
    link_clicks: int = 0
    cost_per_link_click: float = 0
    app_installs: int = 0
    cost_per_app_install: float = 0


class RunAgentsRequest(BaseModel):
    """Single click on the 成效優化中心 「產生分析」 button.
    Counts as one quota use against `agent_advice_limit`."""

    fb_user_id: str
    date_label: str
    campaigns: List[CampaignDigest]


def _format_campaign_status_for_prompt(status: Optional[str]) -> str:
    normalized = (status or "").strip().upper()
    return {
        "ACTIVE": "進行中",
        "PAUSED": "已暫停",
        "ARCHIVED": "已封存",
        "DELETED": "已刪除",
    }.get(normalized, normalized or "未回傳")


_OBJECTIVE_ADVICE_FAMILY = {
    "MESSAGES": "訊息",
    "OUTCOME_SALES": "轉換/銷售",
    "CONVERSIONS": "轉換/銷售",
    "CATALOG_SALES": "轉換/銷售",
    "STORE_VISITS": "來店/轉換",
    "OUTCOME_LEADS": "名單",
    "LEAD_GENERATION": "名單",
    "OUTCOME_ENGAGEMENT": "互動",
    "POST_ENGAGEMENT": "互動",
    "PAGE_LIKES": "互動",
    "EVENT_RESPONSES": "互動",
    "VIDEO_VIEWS": "互動/觀看",
    "OUTCOME_TRAFFIC": "流量",
    "LINK_CLICKS": "流量",
    "OUTCOME_AWARENESS": "曝光/觸及",
    "BRAND_AWARENESS": "曝光/觸及",
    "REACH": "曝光/觸及",
    "OUTCOME_APP_PROMOTION": "App",
    "APP_INSTALLS": "App",
}


def _objective_family(raw: Optional[str]) -> str:
    if not raw:
        return "未指定"
    return _OBJECTIVE_ADVICE_FAMILY.get(raw, _translate_objective(raw) or raw)


def _fmt_prompt_money(v: float) -> str:
    return f"${v:.0f}" if v and v > 0 else "-"


def _primary_kpi_for_prompt(c: CampaignDigest) -> tuple[str, str, str]:
    family = _objective_family(c.objective)
    if family == "訊息":
        return "私訊", str(c.msgs or 0), _fmt_prompt_money(c.msg_cost)
    if family in {"轉換/銷售", "來店/轉換"}:
        if c.purchases > 0 or c.cost_per_purchase > 0 or c.roas > 0:
            cost = _fmt_prompt_money(c.cost_per_purchase)
            if c.roas > 0:
                cost = f"{cost} / ROAS {c.roas:.2f}"
            return "購買/ROAS", str(c.purchases or 0), cost
        return "加購", str(c.add_to_cart or 0), _fmt_prompt_money(c.cost_per_add_to_cart)
    if family == "名單":
        return "名單", str(c.leads or 0), _fmt_prompt_money(c.cost_per_lead)
    if family in {"互動", "互動/觀看"}:
        return "互動", str(c.engagements or 0), _fmt_prompt_money(c.cost_per_engagement)
    if family == "流量":
        clicks = c.link_clicks or int(c.clicks or 0)
        cost = c.cost_per_link_click or c.cpc
        return "連結點擊", str(clicks), _fmt_prompt_money(cost)
    if family == "App":
        return "App 安裝", str(c.app_installs or 0), _fmt_prompt_money(c.cost_per_app_install)
    if family == "曝光/觸及":
        return "曝光", f"{int(c.impressions):,}", f"CPM {_fmt_prompt_money(c.cpm)}"
    return "主要KPI", "-", "-"


def _secondary_signals_for_prompt(c: CampaignDigest) -> str:
    bits = [
        f"CTR {c.ctr:.2f}%",
        f"CPC ${c.cpc:.2f}" if c.cpc > 0 else "CPC -",
        f"頻次 {c.frequency:.2f}" if c.frequency > 0 else "頻次 -",
    ]
    family = _objective_family(c.objective)
    if family != "訊息" and c.msgs > 0:
        bits.append(f"私訊 {c.msgs}/成本 ${c.msg_cost:.0f}")
    if family != "名單" and c.leads > 0:
        bits.append(f"名單 {c.leads}/成本 ${c.cost_per_lead:.0f}" if c.cost_per_lead > 0 else f"名單 {c.leads}")
    if family not in {"轉換/銷售", "來店/轉換"} and c.purchases > 0:
        bits.append(f"購買 {c.purchases}/ROAS {c.roas:.2f}" if c.roas > 0 else f"購買 {c.purchases}")
    if c.add_to_cart > 0:
        bits.append(f"加購 {c.add_to_cart}")
    return "、".join(bits)


def _format_campaigns_for_prompt(campaigns: List[CampaignDigest]) -> str:
    """Render the campaigns as a markdown grouped by account so the
    agent can structure per-account analysis. Sort accounts by total
    spend desc, campaigns within each account by spend desc. Cap per
    account instead of globally so low-spend accounts still get a card."""
    by_account: dict = {}
    for c in campaigns:
        key = c.account_name or "(未命名帳號)"
        by_account.setdefault(key, []).append(c)

    account_items = sorted(
        by_account.items(),
        key=lambda item: sum(row.spend for row in item[1]),
        reverse=True,
    )
    max_rows_total = 160
    max_rows_per_account = max(
        4,
        min(12, max_rows_total // max(1, len(account_items))),
    )

    blocks: list = []
    for acct_name, rows in account_items:
        rows_sorted = sorted(rows, key=lambda c: c.spend, reverse=True)
        shown_rows = rows_sorted[:max_rows_per_account]
        acct_spend = sum(r.spend for r in rows)
        acct_imp = sum(r.impressions for r in rows)
        objective_mix: dict[str, int] = {}
        for r in rows:
            fam = _objective_family(r.objective)
            objective_mix[fam] = objective_mix.get(fam, 0) + 1
        objective_mix_text = "、".join(f"{k} {v}" for k, v in sorted(objective_mix.items()))
        header = (
            f"### 帳號:{acct_name}\n"
            f"- 該帳號活動數: {len(rows)}  顯示活動: {len(shown_rows)} / {len(rows)}\n"
            f"- 總花費: ${acct_spend:,.0f}  總曝光: {int(acct_imp):,}  目標組成: {objective_mix_text or '-'}\n"
        )
        table_lines = [
            "| 活動 | 狀態 | 目標 | 判斷主軸 | 花費 | 主KPI | 主成本/ROAS | 輔助訊號 |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for c in shown_rows:
            kpi_name, kpi_value, kpi_cost = _primary_kpi_for_prompt(c)
            table_lines.append(
                f"| {c.name} | {_format_campaign_status_for_prompt(c.status)} | {c.objective or '-'} "
                f"| {_objective_family(c.objective)} / {kpi_name} | ${c.spend:,.0f} "
                f"| {kpi_value} | {kpi_cost} | {_secondary_signals_for_prompt(c)} |"
            )
        blocks.append(header + "\n".join(table_lines))

    return "\n\n".join(blocks)


async def _call_one_agent(
    persona: str,
    table: str,
    date_label: str,
    n_campaigns: int,
) -> str:
    """Issue one Gemini POST for the synthesized action plan."""
    if not persona:
        # Persona file missing on disk — bubble up so the per-card
        # error displays "persona 載入失敗" instead of a misleading
        # generic Gemini failure. Most likely cause: the
        # agent_personas/ folder didn't ship in the deploy bundle.
        raise RuntimeError("persona 內容空白(deploy 未包含 agent_personas 檔案?)")
    system_prompt = (
        f"{persona}\n\n"
        "---\n\n"
        "# 任務\n"
        "你是整合 paid social、creative、audit、growth、analytics、agency leadership 的單一決策大腦。\n"
        "審視多個 FB 廣告帳號,**依 ad account 輸出每個帳戶該做的 to-do list**。\n"
        "不要提到專家、角色、六位、幕僚、觀點分歧或分析過程。\n"
        "全程繁中(術語 / 活動代號 / 數字保留原文)。\n\n"
        "# 嚴格範圍\n"
        "**只針對表現不好、有問題、需要介入的活動寫 to-do**。範例:\n"
        "- 訊息目標: 私訊成本太貴 / 有花費但無私訊 → 暫停 / 換素材 / 檢查私訊流程\n"
        "- 轉換/銷售目標: 購買成本過高 / ROAS 低 / 有加購無購買 → 檢查追蹤 / 優化結帳漏斗 / 暫停\n"
        "- 名單目標: 名單成本過高 / 有花費但無名單 → 換表單 / 檢查表單追蹤 / 暫停\n"
        "- 互動目標: 互動成本過高 / 互動量低 / 頻次過高 → 換素材 / 擴受眾\n"
        "- 流量目標: CPC 或連結點擊成本過高 / CTR 過低 → 換素材 / 換受眾 / 調 bid\n"
        "- 曝光/觸及目標: CPM 過高 / 頻次過高 → 擴受眾 / 控頻 / 換素材\n"
        "- App 目標: 安裝成本過高 / 有花費無安裝 → 檢查 App event / 換素材 / 暫停\n"
        "- 頻次過高(受眾疲勞)→ 換素材 / 擴受眾\n"
        "- CTR 過低 → 換素材 / 換目標\n"
        "- 花錢卻沒成效 → 暫停\n"
        "**表現好的活動完全不要寫**,例如:不要建議「加預算給某活動因為私訊成本低」、"
        "不要建議「複製某活動因為 ROAS 高」、不要鼓勵 scale up。\n"
        "**每個帳戶都要出現一個 ## 帳戶區塊**。沒有待辦的帳戶只寫 `### 無待辦` "
        "和 `- 目前無需介入`,不要列好活動。\n\n"
        "# 目標對應 KPI（必須遵守）\n"
        "- MESSAGES / 訊息: 主看 私訊、私訊成本; CPC/CTR 只能當輔助,不能用私訊成本評估非訊息目標。\n"
        "- OUTCOME_SALES / CONVERSIONS / CATALOG_SALES / STORE_VISITS: 主看 購買、購買成本、ROAS、加購漏斗。\n"
        "- OUTCOME_LEADS / LEAD_GENERATION: 主看 名單數、名單成本。\n"
        "- OUTCOME_ENGAGEMENT / POST_ENGAGEMENT / PAGE_LIKES / EVENT_RESPONSES / VIDEO_VIEWS: 主看 互動數、互動成本、頻次。\n"
        "- OUTCOME_TRAFFIC / LINK_CLICKS: 主看 連結點擊、連結點擊成本、CPC、CTR。\n"
        "- OUTCOME_AWARENESS / BRAND_AWARENESS / REACH: 主看 CPM、曝光量、頻次,不要用私訊或購買判斷。\n"
        "- OUTCOME_APP_PROMOTION / APP_INSTALLS: 主看 App 安裝、安裝成本; 沒有安裝資料時才用 CPC/CTR 輔助。\n"
        "- objective 未知時: 只用花費、CTR、CPC、頻次下保守建議,不要硬套私訊。\n"
        "- 所有建議必須引用該目標的主KPI或表格中的輔助訊號,客觀下判斷; 不要因活動名稱含「私訊」就一律當私訊活動。\n\n"
        "# 客觀判斷原則\n"
        "- 先在同一帳戶、同一判斷主軸內比較成本與成效; 不同目標不要互相比私訊成本、購買成本或名單成本。\n"
        "- 成本高於同帳戶同主軸明顯多數活動,且花費已足夠,才列待辦; 沒有足夠花費或資料缺漏時只列低風險觀察/檢查追蹤。\n"
        "- 有花費但主KPI為 0 是高風險訊號; 若同時 CPC/CTR 也差,可列嚴重; 若 CPC/CTR 正常,優先建議檢查追蹤或漏斗。\n"
        "- 頻次只代表疲勞/觸及飽和,不能單獨推論轉換差; 要搭配 CTR 下降、成本升高或主KPI不足。\n"
        "- 不知道原因時用「檢查追蹤 / 檢查漏斗」,不要武斷寫暫停。\n\n"
        "# 輸出格式\n"
        "**只寫待辦,不寫分析、不寫診斷段落、不寫開場白、不寫總結。**\n"
        "固定使用「帳戶 → 嚴重程度 → 待辦」階層:\n\n"
        "## [帳戶名稱]\n"
        "### 嚴重\n"
        "今天要處理、正在燒錢、或數字明顯異常的 to-do。\n\n"
        "### 中等\n"
        "本週要處理,但風險低於嚴重的 to-do。\n\n"
        "### 低\n"
        "觀察或微調即可的 to-do。\n\n"
        "規則:\n"
        "- 必須為資料中的每個帳戶輸出一個 ## 帳戶名稱,不得省略帳戶。\n"
        "- 有問題才列嚴重 / 中等 / 低;沒有項目的嚴重程度不要出現。\n"
        "- 帳戶沒有任何待辦時,固定輸出 `### 無待辦` 與 `- 目前無需介入`。\n"
        "- 每個帳戶最多 8 條 to-do(不含無待辦那條),優先列嚴重。\n"
        "- 全部帳戶合計最多 60 條 to-do。\n"
        "- 帳戶依資料順序輸出。\n\n"
        "每條格式必須是:\n"
        "```\n"
        "- [動作動詞] [活動名] — [依據數字]\n"
        "```\n"
        "例如:\n"
        "## !A 總部\n"
        "### 嚴重\n"
        "- 暫停 PS40·簡紹倫 — CPC $12 是帳戶均值 3 倍\n"
        "- 換素材 上越Look·張浩榕 — 頻次 7.2 受眾疲勞\n"
        "### 中等\n"
        "- 縮受眾 AT17·KID — CTR 0.4% / 花費 $5k 沒回應\n\n"
        "## !B 新城區\n"
        "### 無待辦\n"
        "- 目前無需介入\n\n"
        "# 嚴格禁止\n"
        "- 不要寫「根據資料」「整體來看」「總結」「值得注意」等開場 / 收尾\n"
        "- 不要對表現好的活動建議 scale up / 加預算 / 複製\n"
        "- 不要省略任何帳戶\n"
        "- 無待辦帳戶不要解釋表現好在哪裡,只寫目前無需介入\n"
        "- 不要解釋長篇 WHY,只寫 WHAT(修什麼問題)+ 數字依據\n"
        "- 每條 ≤ 42 字,動作必須是明確操作動詞(暫停 / 換素材 / 縮受眾 / 調 bid / 換目標 / 擴受眾 / 檢查追蹤)"
    )
    user_prompt = (
        f"資料區間: {date_label}\n"
        f"進行中活動總數: {n_campaigns}\n"
        f"請依下方 ad account 分群逐帳號判斷,每個帳號都要輸出一張卡片。\n"
        f"(下方資料按帳號分群,每個帳號顯示該帳號花費 Top 活動;不要因無待辦省略帳號)\n\n"
        f"{table}"
    )
    # maxOutputTokens raised from 800 -> 8192: 800 was being hit
    # mid-sentence (CJK uses ~2-3 tokens per character; 800 tokens
    # ≈ 250-400 zh chars max). The per-account output can include many
    # account headings + concrete activity names, so keep enough room
    # for the model to finish cleanly instead of cutting off the last
    # account card.
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {"temperature": 0.6, "maxOutputTokens": 8192},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    try:
        r = await _http_client.post(
            url,
            json=payload,
            headers={"x-goog-api-key": GEMINI_API_KEY},
            timeout=_POST_TIMEOUT,
        )
    except httpx.TimeoutException:
        raise RuntimeError("Gemini API 回應逾時(>60s)")
    except httpx.RequestError as e:
        raise RuntimeError(f"無法連線 Gemini API: {e.__class__.__name__}")

    # Gemini sometimes returns a 4xx/5xx with a JSON body, sometimes
    # with text. Try JSON first, fall back to status code + truncated
    # body so the per-card error message tells us exactly what went
    # wrong (e.g. "model not found", "quota exceeded", "API key
    # invalid"). Without this we just see "API 500: HTTP 500" with
    # zero context on the root cause.
    try:
        data = r.json()
    except Exception:
        snippet = (r.text or "")[:200]
        raise RuntimeError(f"Gemini HTTP {r.status_code}: {snippet or '(empty body)'}")

    if "error" in data:
        msg = data["error"].get("message", "Gemini error") if isinstance(data["error"], dict) else str(data["error"])
        raise RuntimeError(f"Gemini {r.status_code}: {msg} (model={GEMINI_MODEL})")
    if r.status_code >= 400:
        raise RuntimeError(f"Gemini HTTP {r.status_code}: {str(data)[:200]}")

    candidates = data.get("candidates") or []
    if not candidates:
        # Sometimes happens on safety blocks — surface promptFeedback
        # if Google included it.
        feedback = data.get("promptFeedback") or {}
        block_reason = feedback.get("blockReason") if isinstance(feedback, dict) else None
        raise RuntimeError(
            f"Gemini 回傳空結果(blockReason={block_reason or 'unknown'})"
        )
    text = (
        candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        if isinstance(candidates[0], dict)
        else ""
    )
    if not text:
        finish = candidates[0].get("finishReason") if isinstance(candidates[0], dict) else None
        raise RuntimeError(f"Gemini 回傳空文字(finishReason={finish or 'unknown'})")
    return text.strip()


@app.post("/api/optimization/run-agents")
async def run_optimization_agents(req: RunAgentsRequest):
    """See module docstring for full behaviour. Outermost try/except
    converts any otherwise-uncaught exception (ImportError on the
    inline persona module, asyncpg connection blip, surprise
    KeyError) into a 502 with the class name + message in the
    detail. Without this we lose all visibility — FastAPI's default
    handler returns a body-less 500 and the frontend just shows
    "API 500: HTTP 500" with zero context.
    """
    try:
        return await _run_optimization_agents_inner(req)
    except HTTPException:
        raise
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail=f"AI 幕僚未預期錯誤:{exc.__class__.__name__}: {exc}",
        )


async def _run_optimization_agents_inner(req: RunAgentsRequest):
    _assert_known_user(req.fb_user_id)
    _check_agent_rate_limit(req.fb_user_id)
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="Gemini API key 未設定")
    if not req.campaigns:
        raise HTTPException(status_code=400, detail="目前沒有可分析的行銷活動")

    try:
        limits = await _get_user_limits(req.fb_user_id)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail=f"讀取方案配額失敗:{exc.__class__.__name__}: {exc}",
        )
    cap = limits["agent_advice"]
    if cap == 0:
        raise _tier_limit_error(
            "agent_advice",
            0,
            limits["tier"],
            "目前方案無法使用「AI 幕僚」,請升級至 Basic 以上",
        )
    used = 0
    is_free = str(limits["tier"]).lower() == "free"
    if not _is_unlimited(cap):
        try:
            used = await _count_advice_runs_for_quota(req.fb_user_id, limits["tier"])
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(
                status_code=502,
                detail=f"讀取使用次數失敗:{exc.__class__.__name__}: {exc}",
            )
        if used >= cap:
            if is_free:
                msg = f"免費試用 {cap} 次已用完,請升級方案以繼續使用 AI 幕僚"
            else:
                msg = f"本月 AI 幕僚配額已用完 ({used}/{cap}),請升級方案或下個月再試"
            raise _tier_limit_error(
                "agent_advice",
                cap,
                limits["tier"],
                msg,
            )

    prompts = _load_agent_prompts()
    table = _format_campaigns_for_prompt(req.campaigns)
    n = len(req.campaigns)
    combined_prompt = _combined_agent_prompt(prompts)

    tasks = [
        _call_one_agent(combined_prompt, table, req.date_label, n)
        for meta in AGENT_META
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    advice = []
    success_count = 0
    for meta, r in zip(AGENT_META, results):
        if isinstance(r, BaseException):
            advice.append(
                {
                    "agent_id": meta["id"],
                    "advice_md": None,
                    "error": str(r) or r.__class__.__name__,
                }
            )
        else:
            advice.append({"agent_id": meta["id"], "advice_md": r, "error": None})
            success_count += 1

    new_used = used
    if success_count > 0 and _db_pool is not None:
        try:
            payload = _build_run_payload(req, advice)
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO agent_advice_runs (fb_user_id, payload) VALUES ($1, $2)",
                    req.fb_user_id,
                    payload,
                )
            new_used = used + 1
        except Exception as exc:
            # Don't fail the whole response over a quota-log write —
            # the user has the advice in hand. Just log it.
            traceback.print_exc()
            print(f"[agents] failed to record run: {exc}", flush=True)

    return {
        "data": {
            "advice": advice,
            "quota": {
                "used_this_month": new_used,
                "limit": cap,
                "tier": limits["tier"],
            },
        }
    }


# ── Streaming variant ────────────────────────────────────────────
#
# /api/optimization/run-agents-stream emits NDJSON: one JSON line
# per event, terminated by `\n`. The client parses incrementally
# and fills each card the moment its agent completes (instead of
# blocking on the slowest of 5). One quota use, same as the
# non-streaming endpoint.
#
# Event types:
#   { "type": "agent_done", "agent_id": "...", "advice_md": "...",
#     "error": null | "..." }       — emitted 5 times, in completion
#                                     order (slowest last)
#   { "type": "done", "quota": { "used_this_month": N, "limit": Y,
#     "tier": "..." } }              — emitted once at the end
#
# Pre-flight 4xx errors (auth, no campaigns, quota exhausted) are
# raised BEFORE the StreamingResponse is constructed so the client
# can catch them on the response object instead of having to parse
# the stream just to find an error.

def _build_run_payload(req: "RunAgentsRequest", advice: list) -> str:
    """Shape the JSONB blob persisted to agent_advice_runs.payload.
    Same structure on both the streaming and non-streaming paths
    so the GET /last-run reader can be agnostic. Returns a JSON
    string — asyncpg's JSONB codec accepts either dict-or-string,
    but a string sidesteps any "default JSON encoder" surprises
    with non-stdlib types."""
    accounts = sorted({c.account_name for c in req.campaigns if c.account_name})
    return json.dumps(
        {
            "version": 2,
            "date_label": req.date_label,
            "account_names": accounts,
            "campaigns_count": len(req.campaigns),
            "advice": advice,
        },
        ensure_ascii=False,
    )


@app.get("/api/optimization/last-run")
async def get_last_run(fb_user_id: str = Query(...)):
    """Return the most recent persisted AI 幕僚 run for this user
    (across devices), or `{ data: null }` if none. Used by the
    frontend to hydrate the cards on mount so a refresh / new
    device sees the same report. Filters out legacy quota-only
    rows where payload IS NULL."""
    _assert_known_user(fb_user_id)
    if _db_pool is None:
        return {"data": None}
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT created_at, payload FROM agent_advice_runs
                WHERE fb_user_id = $1 AND payload IS NOT NULL
                ORDER BY created_at DESC
                LIMIT 1
                """,
                fb_user_id,
            )
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail=f"讀取上次分析失敗:{exc.__class__.__name__}: {exc}",
        )
    if not row:
        return {"data": None}
    payload = row["payload"]
    # asyncpg returns JSONB as already-parsed dict; older drivers
    # may return raw text — handle both defensively.
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            payload = None
    return {
        "data": {
            "created_at": row["created_at"].isoformat(),
            "payload": payload,
        }
    }


async def _call_one_agent_with_id(
    agent_id: str,
    persona: str,
    table: str,
    date_label: str,
    n_campaigns: int,
) -> tuple:
    """Wrapper that returns (agent_id, text|None, error|None) so the
    streaming loop can dispatch events without losing the agent
    identity (asyncio.as_completed only gives the future, not the
    metadata we attached when scheduling)."""
    try:
        text = await _call_one_agent(persona, table, date_label, n_campaigns)
        return (agent_id, text, None)
    except BaseException as exc:
        return (agent_id, None, str(exc) or exc.__class__.__name__)


@app.post("/api/optimization/run-agents-stream")
async def run_optimization_agents_stream(req: RunAgentsRequest):
    """NDJSON streaming variant — see comment above for protocol."""
    # Pre-flight (these MUST raise before we wrap the body in
    # StreamingResponse, otherwise the client won't see the 4xx).
    _assert_known_user(req.fb_user_id)
    _check_agent_rate_limit(req.fb_user_id)
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="Gemini API key 未設定")
    if not req.campaigns:
        raise HTTPException(status_code=400, detail="目前沒有可分析的行銷活動")

    try:
        limits = await _get_user_limits(req.fb_user_id)
    except Exception as exc:
        traceback.print_exc()
        raise HTTPException(
            status_code=502,
            detail=f"讀取方案配額失敗:{exc.__class__.__name__}: {exc}",
        )
    cap = limits["agent_advice"]
    if cap == 0:
        raise _tier_limit_error(
            "agent_advice", 0, limits["tier"],
            "目前方案無法使用「AI 幕僚」,請升級至 Basic 以上",
        )
    used = 0
    is_free = str(limits["tier"]).lower() == "free"
    if not _is_unlimited(cap):
        try:
            used = await _count_advice_runs_for_quota(req.fb_user_id, limits["tier"])
        except Exception as exc:
            traceback.print_exc()
            raise HTTPException(
                status_code=502,
                detail=f"讀取使用次數失敗:{exc.__class__.__name__}: {exc}",
            )
        if used >= cap:
            msg = (
                f"免費試用 {cap} 次已用完,請升級方案以繼續使用 AI 幕僚"
                if is_free
                else f"本月 AI 幕僚配額已用完 ({used}/{cap}),請升級方案或下個月再試"
            )
            raise _tier_limit_error("agent_advice", cap, limits["tier"], msg)

    prompts = _load_agent_prompts()
    table = _format_campaigns_for_prompt(req.campaigns)
    n = len(req.campaigns)
    combined_prompt = _combined_agent_prompt(prompts)

    async def stream():
        success_count = 0
        # Mirror every emitted event into a local list so we can
        # write the persisted run row at the end. We can't read it
        # back from the wire (streaming response is one-way), so
        # the alternative would be re-doing the JSON parse on the
        # backend — much uglier.
        advice_collected: list = []
        tasks = [
            _call_one_agent_with_id(
                meta["id"], combined_prompt,
                table, req.date_label, n,
            )
            for meta in AGENT_META
        ]
        for coro in asyncio.as_completed(tasks):
            try:
                agent_id, text, err = await coro
            except Exception as exc:
                # Defensive — _call_one_agent_with_id is supposed
                # to absorb everything, but a TaskGroup-level
                # cancellation could still bubble.
                agent_id, text, err = "?", None, f"{exc.__class__.__name__}: {exc}"
            if text:
                success_count += 1
            advice_collected.append({"agent_id": agent_id, "advice_md": text, "error": err})
            yield (
                json.dumps(
                    {
                        "type": "agent_done",
                        "agent_id": agent_id,
                        "advice_md": text,
                        "error": err,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            ).encode("utf-8")

        new_used = used
        if success_count > 0 and _db_pool is not None:
            try:
                # Reconstruct the same payload shape the non-stream
                # endpoint persists, so /api/optimization/last-run
                # returns the same structure regardless of which
                # endpoint produced the row.
                stream_advice = [
                    {"agent_id": a["agent_id"], "advice_md": a["advice_md"], "error": a["error"]}
                    for a in advice_collected
                ]
                payload = _build_run_payload(req, stream_advice)
                async with _db_pool.acquire() as conn:
                    await conn.execute(
                        "INSERT INTO agent_advice_runs (fb_user_id, payload) VALUES ($1, $2)",
                        req.fb_user_id,
                        payload,
                    )
                new_used = used + 1
            except Exception:
                traceback.print_exc()

        yield (
            json.dumps(
                {
                    "type": "done",
                    "quota": {
                        "used_this_month": new_used,
                        "limit": cap,
                        "tier": limits["tier"],
                    },
                },
                ensure_ascii=False,
            )
            + "\n"
        ).encode("utf-8")

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        # Disable any reverse-proxy buffering — without this Zeabur
        # / nginx may hold the chunks until the response closes,
        # which defeats the entire point of streaming.
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )
# ── 費用中心唯讀匯出 API（機器對機器，給 lurefin 每月同步用）──────────
#
# GET /api/cost-center?month=YYYY-MM
#
# 外部系統 lurefin 以 server-to-server 方式呼叫，把「費用中心」裡
# L吸引力 / b新城區廣告帳號 兩個帳號的表格資料同步進它自己的 DB。
#
#   - 驗證：Authorization: Bearer <token>，token 由環境變數
#     AD_SPEND_API_TOKEN 提供（不寫死、.env 不 commit）。純機器對機器，
#     不走一般使用者 FB 登入；FB 呼叫沿用 runtime token（與 /r 分享頁同源）。
#   - 唯讀，只回 JSON，不需要 CORS。
#   - month 省略時預設「當月」（SCHEDULER_TZ，預設 Asia/Taipei）。
#
# 欄位對應（費用中心表格 → JSON）與 FinanceTable.tsx / financeData.ts 對齊：
#   暱稱   → nickname            formatNickname（店家 · 設計師）；無暱稱時
#                               回行銷活動名稱，與表格那一格實際顯示一致
#   花費   → spend              FB 原始 spend（真正的 number，不四捨五入）
#   %     → percent            per-row 月% override，否則 finance_default_markup
#   花費+% → spend_with_percent  ceil(spend × (1 + percent/100))，與 spendPlus 一致
#   pin   → pin                置頂回 "置頂"，否則 null（表格 pin 只有「有無置頂」）
#   請款單 → invoice            系統未儲存任何請款單資料，一律 null
#
# 顯示順序 / 篩選比照費用中心預設：置頂列在前 + 其餘照 FB 原始順序，並
# 隱藏零花費列（表格「有花費」預設開）。

# Maps the stable label lurefin wants as the table title (kept regardless
# of FB's messy display names) to the real FB ad-account display name we
# match on. Update `fb_name` here if an account is renamed in FB.
COST_CENTER_ACCOUNTS = [
    {"label": "L吸引力", "fb_name": "!L 吸引力 LURE - 月結"},
    {"label": "b新城區廣告帳號", "fb_name": "!B 新城區 - 月結"},
    {"label": "L2寰宇", "fb_name": "! L2 寰宇 - 月結"},
]
COST_CENTER_FB_NAMES = [a["fb_name"] for a in COST_CENTER_ACCOUNTS]


def _cost_center_month_range(month: Optional[str]) -> tuple:
    """Resolve ``month`` (``YYYY-MM``, default 當月 in SCHEDULER_TZ) to
    ``(label, since_iso, until_iso)``. ``until`` is capped at today
    (local tz) so the current month never asks FB for future days."""
    tz = _scheduler_tz()
    today = datetime.now(timezone.utc).astimezone(tz).date()
    if month:
        try:
            y, m = month.split("-")
            year, mon = int(y), int(m)
            if not (1 <= mon <= 12):
                raise ValueError
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail="month 格式錯誤,請用 YYYY-MM")
    else:
        year, mon = today.year, today.month
    first = date(year, mon, 1)
    nxt = date(year + 1, 1, 1) if mon == 12 else date(year, mon + 1, 1)
    last = nxt - timedelta(days=1)
    if last > today:
        last = today  # 當月：截到今天，不要跟 FB 要未來的日子
    if last < first:
        last = first  # 整個月都在未來時的保險
    return f"{year:04d}-{mon:02d}", first.isoformat(), last.isoformat()


async def _cost_center_finance_settings() -> tuple:
    """Load team-wide finance settings once: (row_markups, default_markup,
    pinned_ids set). Mirrors financeStore + _markup_for_campaign."""
    row_markups: dict = {}
    default_markup: float = 0.0
    pinned: set = set()
    if _db_pool is None:
        return row_markups, default_markup, pinned
    try:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM shared_settings WHERE key = ANY($1)",
                ["finance_row_markups", "finance_default_markup", "finance_pinned_ids"],
            )
    except Exception:
        return row_markups, default_markup, pinned
    for r in rows:
        v = r["value"]
        if isinstance(v, str):
            try:
                v = json.loads(v)
            except Exception:
                continue
        if r["key"] == "finance_row_markups" and isinstance(v, dict):
            row_markups = v
        elif r["key"] == "finance_default_markup":
            try:
                default_markup = float(v)
            except (TypeError, ValueError):
                pass
        elif r["key"] == "finance_pinned_ids" and isinstance(v, list):
            pinned = {str(x) for x in v}
    return row_markups, default_markup, pinned


async def _cost_center_nicknames(campaign_ids: List[str]) -> dict:
    """Batch-load store/designer nicknames → {campaign_id: "店家 · 設計師"}.
    Mirrors the frontend's formatNickname()."""
    if _db_pool is None or not campaign_ids:
        return {}
    try:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT campaign_id, store, designer FROM campaign_nicknames "
                "WHERE campaign_id = ANY($1)",
                campaign_ids,
            )
    except Exception:
        return {}
    out: dict = {}
    for r in rows:
        store = (r["store"] or "").strip()
        designer = (r["designer"] or "").strip()
        label = f"{store} · {designer}" if store and designer else (store or designer)
        if label:
            out[r["campaign_id"]] = label
    return out


def _cost_center_spend(campaign: dict) -> float:
    """Extract the campaign's spend from the stitched insights row."""
    ins = (campaign.get("insights") or {}).get("data") or []
    if not ins:
        return 0.0
    try:
        return float(ins[0].get("spend") or 0)
    except (TypeError, ValueError):
        return 0.0


def _cost_center_num(v: float):
    """Emit a clean JSON number: int when whole (12345, not 12345.0),
    otherwise a 2-decimal float — matches the agreed example shape."""
    f = float(v)
    return int(f) if f == int(f) else round(f, 2)


async def _cost_center_accounts_for_uid(uid: Optional[str]) -> List[dict]:
    """List `me/adaccounts` using a specific user's FB token (uid=None →
    the legacy runtime token). Sets the contextvar so `get_token()` (and
    everything it reaches) resolves to that user's token, then restores
    it. FB errors are swallowed → empty list, so one revoked token never
    breaks the sweep."""
    reset = _current_fb_user_id.set(uid) if uid else None
    try:
        return await fb_get_paginated(
            "me/adaccounts",
            {"fields": "id,name", "limit": "500"},
            ttl=_ACCOUNTS_CACHE_TTL_SECONDS,
        )
    except Exception:
        return []
    finally:
        if reset is not None:
            _current_fb_user_id.reset(reset)


async def _cost_center_resolve(target_names: List[str]) -> dict:
    """Locate each target ad-account by display name across every FB
    token we hold — the runtime token first, then each cached per-user
    token (multi-tenant). The M2M endpoint has no logged-in session, so
    a single token often can't see all accounts; this sweep finds, per
    account, the token context that CAN.

    Returns ``{"matched": {name: {"id", "uid"}}, "sources": [...],
    "all_names": [...]}``. ``uid`` is the token owner to use when
    fetching that account's campaigns (None = runtime token)."""
    matched: dict = {}
    sources: list = []
    all_names: set = set()
    # Runtime token (None) first, then every cached per-user token.
    candidates: List[Optional[str]] = [None, *list(_user_token_cache.keys())]
    for uid in candidates:
        if all(n in matched for n in target_names):
            break
        accounts = await _cost_center_accounts_for_uid(uid)
        matched_here: list = []
        for a in accounts:
            nm = (a.get("name") or "").strip()
            if not nm:
                continue
            all_names.add(nm)
            if nm in target_names and nm not in matched:
                matched[nm] = {"id": a.get("id"), "uid": uid}
                matched_here.append(nm)
        sources.append(
            {
                "token": "runtime" if uid is None else f"user:{uid}",
                "account_count": len(accounts),
                "matched_here": matched_here,
            }
        )
    return {"matched": matched, "sources": sources, "all_names": sorted(all_names)}


def _cost_center_check_auth(request: Request) -> None:
    """Static bearer-token gate shared by the read + refresh endpoints.
    Machine-to-machine only — no FB user login."""
    expected = os.getenv("AD_SPEND_API_TOKEN", "")
    if not expected:
        raise HTTPException(status_code=503, detail="AD_SPEND_API_TOKEN 未設定")
    auth = request.headers.get("authorization") or ""
    provided = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
    if not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


async def _cost_center_compute(month: Optional[str]) -> tuple:
    """Live-fetch the 費用中心 rows for the two accounts for ``month``
    (Meta → luredash). Returns ``(accounts, debug)``. Used by the
    scheduled capture and the ?live=1 debug path — NOT by lurefin's
    normal read (that serves the stored snapshot)."""
    label, since, until = _cost_center_month_range(month)
    time_range = json.dumps({"since": since, "until": until}, separators=(",", ":"))
    _fb_call_source.set("cost-center")

    # 兩個顯示名稱 → (act_id, 該帳號看得到的 token uid)。M2M 沒有使用者
    # session，單一 runtime token 常常看不到全部帳號，所以掃過 runtime +
    # 每個 per-user token 找到「看得到這個帳號」的那把 token。
    resolution = await _cost_center_resolve(COST_CENTER_FB_NAMES)
    matched = resolution["matched"]
    row_markups, default_markup, pinned = await _cost_center_finance_settings()

    out_accounts: list = []
    acct_diags: list = []
    for acct in COST_CENTER_ACCOUNTS:
        acct_label = acct["label"]
        fb_name = acct["fb_name"]
        info = matched.get(fb_name)
        rows_out: list = []
        diag: dict = {"account": acct_label, "fb_name": fb_name, "found": bool(info)}
        if info:
            acct_id = info["id"]
            uid = info["uid"]
            diag["account_id"] = acct_id
            diag["token"] = "runtime" if uid is None else f"user:{uid}"
            # 用「看得到這個帳號」的 token context 抓 campaigns
            reset = _current_fb_user_id.set(uid) if uid else None
            try:
                campaigns = await _fetch_campaigns_for_account(
                    acct_id, "last_30d", time_range,
                    include_archived=True, include_adsets=False,
                )
            except HTTPException as e:
                campaigns = []
                diag["fetch_error"] = str(e.detail)
            finally:
                if reset is not None:
                    _current_fb_user_id.reset(reset)
            nick_map = await _cost_center_nicknames(
                [c.get("id") for c in campaigns if c.get("id")]
            )
            # 隱藏零花費 + 置頂列在前，其餘照 FB 原始順序（= 費用中心預設視圖）
            pinned_rows: list = []
            unpinned_rows: list = []
            for c in campaigns:
                spend = _cost_center_spend(c)
                if spend <= 0:
                    continue
                cid = c.get("id") or ""
                pct_raw = row_markups.get(cid)
                if pct_raw is None:
                    pct = default_markup
                else:
                    try:
                        pct = float(pct_raw)
                    except (TypeError, ValueError):
                        pct = default_markup
                is_pinned = cid in pinned
                row = {
                    "nickname": nick_map.get(cid) or (c.get("name") or ""),
                    "spend": _cost_center_num(spend),
                    "percent": _cost_center_num(pct),
                    "spend_with_percent": math.ceil(spend * (1 + pct / 100)),
                    "pin": "置頂" if is_pinned else None,
                    "invoice": None,
                }
                (pinned_rows if is_pinned else unpinned_rows).append(row)
            rows_out = [*pinned_rows, *unpinned_rows]
            diag["campaigns_total"] = len(campaigns)
            diag["rows_after_filter"] = len(rows_out)
        out_accounts.append({"account": acct_label, "rows": rows_out})
        acct_diags.append(diag)

    print(
        "[cost-center] compute month=%s range=%s..%s sources=%s accounts=%s"
        % (
            label, since, until, resolution["sources"],
            [{k: d.get(k) for k in ("account", "found", "token",
                                    "campaigns_total", "rows_after_filter",
                                    "fetch_error") if k in d}
             for d in acct_diags],
        ),
        flush=True,
    )

    debug = {
        "month": label,
        "date_range": {"since": since, "until": until},
        "time_range": time_range,
        "token_sources": resolution["sources"],
        "accounts": acct_diags,
        "all_visible_account_names": resolution["all_names"],
        "finance_default_markup": default_markup,
    }
    return out_accounts, debug


def _cost_center_current_month() -> str:
    """Current month 'YYYY-MM' in SCHEDULER_TZ (Asia/Taipei)."""
    tz = _scheduler_tz()
    today = datetime.now(timezone.utc).astimezone(tz).date()
    return f"{today.year:04d}-{today.month:02d}"


def _cost_center_month_list(start: str, end: str) -> list:
    """Inclusive list of 'YYYY-MM' from start to end (bounded)."""
    try:
        sy, sm = (int(x) for x in start.split("-"))
        ey, em = (int(x) for x in end.split("-"))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="from/to 格式錯誤,請用 YYYY-MM")
    out: list = []
    y, m = sy, sm
    for _ in range(120):  # backstop against a runaway range
        out.append(f"{y:04d}-{m:02d}")
        if (y, m) >= (ey, em):
            break
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


def _cost_center_capture_good(debug: dict) -> bool:
    """Only cache a past month when the capture is trustworthy: no
    account hit a fetch error AND at least one account returned rows.
    Guards the DB from caching a throttled/empty result that would then
    be served forever."""
    accts = debug.get("accounts", [])
    if any(d.get("fetch_error") for d in accts):
        return False
    return sum(d.get("rows_after_filter", 0) for d in accts) > 0


async def _cost_center_store_snapshot(month: str, accounts: list) -> None:
    if _db_pool is None:
        return
    async with _db_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO cost_center_snapshots (month, payload, captured_at, updated_at)
            VALUES ($1, $2::jsonb, NOW(), NOW())
            ON CONFLICT (month) DO UPDATE
              SET payload = EXCLUDED.payload, captured_at = NOW(), updated_at = NOW()
            """,
            month,
            json.dumps({"accounts": accounts}, ensure_ascii=False),
        )


async def _cost_center_read_snapshot(month: str) -> Optional[list]:
    """Return the stored accounts list for a month, or None if absent."""
    if _db_pool is None:
        return None
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT payload FROM cost_center_snapshots WHERE month = $1", month
        )
    if not row:
        return None
    payload = row["payload"]
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except Exception:
            return None
    if not isinstance(payload, dict):
        return None
    accounts = payload.get("accounts")
    return accounts if isinstance(accounts, list) else None


@app.get("/api/cost-center")
async def get_cost_center(
    request: Request, month: Optional[str] = None, debug: int = 0
):
    """唯讀費用中心匯出（機器對機器，給 lurefin）。

    - 當月 → 一律即時跟 FB 抓（數字還在變）。
    - 過往月份 → 讀資料庫；DB 還沒有的話,第一次自動即時抓一次並存起來,
      之後就不再碰 FB（過往月份是固定的）。
    lurefin 本身不直接碰 FB。唯讀、只回 JSON。``?debug=1`` 附診斷。
    """
    _cost_center_check_auth(request)
    label = _cost_center_month_range(month)[0]  # 驗證 + 正規化月份
    current = _cost_center_current_month()

    # 當月、未來月,或還在結算緩衝期的上個月(本月 3 號前)→ 一律即時,
    # 不讀也不寫 DB。上個月月底翻頁後 FB insights 仍會回補 1~2 天,提早
    # 存進 cost_center_snapshots 會凍住未結算的數字且之後永遠讀那份髒的。
    if label > _latest_snapshotable_month():
        accounts, dbg = await _cost_center_compute(label)
        result: dict = {"month": label, "accounts": accounts}
        if debug:
            settling = label < current
            result["_debug"] = {
                **dbg,
                "source": "live (settling month)" if settling else "live (current month)",
            }
        return result

    # 過往月份 → 先讀 DB
    cached = await _cost_center_read_snapshot(label)
    if cached is not None:
        result = {"month": label, "accounts": cached}
        if debug:
            result["_debug"] = {"source": "db"}
        return result

    # DB 沒有 → 即時抓一次,抓到有效資料就存起來(之後免再抓)
    accounts, dbg = await _cost_center_compute(label)
    good = _cost_center_capture_good(dbg)
    if good:
        await _cost_center_store_snapshot(label, accounts)
    result = {"month": label, "accounts": accounts}
    if debug:
        result["_debug"] = {
            **dbg,
            "source": "live-then-cached" if good else "live (not cached: empty/error)",
        }
    return result


@app.post("/api/cost-center/backfill")
async def post_cost_center_backfill(
    request: Request,
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
):
    """一次把過往月份抓下來存進 DB（機器對機器，bearer）。

    預設範圍:今年 1 月 ~ 上個完成月份。當月、未來月,以及還在結算緩衝期的
    上個月(本月 3 號前)會跳過（一律即時,不存）。可重複執行,只會補沒存到
    / 抓失敗的月份。
    """
    _cost_center_check_auth(request)
    current = _cost_center_current_month()
    latest_ok = _latest_snapshotable_month()
    start = _cost_center_month_range(from_ or f"{current[:4]}-01")[0]
    end = _cost_center_month_range(to)[0] if to else current
    out: list = []
    for m in _cost_center_month_list(start, end):
        if m > latest_ok:
            note = "當月/未來月一律即時,不存" if m >= current else "上月結算中,3 號後才可存"
            out.append({"month": m, "stored": False, "note": note})
            continue
        accounts, dbg = await _cost_center_compute(m)
        good = _cost_center_capture_good(dbg)
        if good:
            await _cost_center_store_snapshot(m, accounts)
        out.append(
            {
                "month": m,
                "stored": bool(good),
                "rows": sum(len(a["rows"]) for a in accounts),
                "accounts": [
                    {
                        "account": d["account"],
                        "found": d.get("found"),
                        "rows": d.get("rows_after_filter", 0),
                        "fetch_error": d.get("fetch_error"),
                    }
                    for d in dbg["accounts"]
                ],
            }
        )
    return {"backfilled": out}


# ── 工程模式:歷史資料預熱 UI（前端 session 驗證）──────────────
#
# 把「所有帳號」每個過往完整月份的 /api/overview 資料先抓進
# account_month_snapshots,讓 費用中心 / 店家花費 / 歷史花費 等月報表型
# 頁面第一次打開就秒出(不必等 lazy-fill)。逐月、可重抓覆蓋(force)。


async def _engineering_warm_accounts(uid: Optional[str]) -> list:
    """要預熱的帳號:登入者的 selected_accounts;沒設定就退回他看得到的
    全部帳號(me/adaccounts)。"""
    ids: list = []
    if uid and _db_pool is not None:
        try:
            async with _db_pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT value FROM user_settings "
                    "WHERE fb_user_id=$1 AND key='selected_accounts'",
                    uid,
                )
            if row and row["value"]:
                ids = [str(x) for x in _jsonb_list(row["value"]) if x]
        except Exception:
            ids = []
    if not ids:
        try:
            accts = await fb_get_paginated(
                "me/adaccounts", {"fields": "id", "limit": "500"},
                ttl=_ACCOUNTS_CACHE_TTL_SECONDS,
            )
            ids = [a.get("id") for a in accts if a.get("id")]
        except Exception:
            ids = []
    return list(dict.fromkeys(ids))


@app.get("/api/engineering/history-warm/months")
async def get_engineering_history_warm_months():
    """列出 2024-01 ~ 當月,以及每個月已預熱(存進 account_month_snapshots)
    的帳號數 / 總帳號數。給工程模式「歷史資料預熱」表格用。"""
    uid = _current_fb_user_id.get()
    current = _cost_center_current_month()
    latest_ok = _latest_snapshotable_month()
    months = _cost_center_month_list("2024-01", current)
    accounts = await _engineering_warm_accounts(uid)
    total = len(accounts)
    warmed: dict = {}
    if _db_pool is not None and accounts:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT month, COUNT(*) AS n FROM account_month_snapshots "
                "WHERE include_archived=TRUE AND include_adsets=FALSE "
                "AND account_id = ANY($1) GROUP BY month",
                accounts,
            )
        for r in rows:
            warmed[r["month"]] = int(r["n"])
    out: list = []
    for m in months:
        out.append(
            {
                "month": m,
                "warmed": warmed.get(m, 0),
                "total": total,
                "is_current": m == current,
                # 上個月在 1~2 號的結算緩衝期內:數字 FB 還在回補,
                # 先不開放預熱(前端顯示「結算中」並鎖按鈕)。
                "is_settling": m < current and m > latest_ok,
            }
        )
    return {
        "current": current,
        "settle_day": _SNAPSHOT_SETTLE_DAY,
        "total_accounts": total,
        "months": out,
    }


class _HistoryWarmBody(BaseModel):
    month: str


async def _history_warm_run_month(label: str, accounts: list) -> dict:
    """把 ``accounts`` 在 ``label`` 月的 overview 資料 force 抓進
    account_month_snapshots。呼叫端負責確認月份已過結算緩衝期。"""
    _, since, until = _cost_center_month_range(label)
    time_range = json.dumps({"since": since, "until": until}, separators=(",", ":"))
    res = await get_overview(
        ids=",".join(accounts),
        time_range=time_range,
        include_archived=True,
        include_adsets=False,
        force=True,
    )
    data = res.get("data", {}) if isinstance(res, dict) else {}
    warmed = 0
    failed = 0
    errors: list = []
    for aid, b in data.items():
        if b.get("error"):
            failed += 1
            if len(errors) < 10:
                errors.append({"account_id": aid, "error": b["error"]})
        else:
            warmed += 1
    return {
        "month": label,
        "total": len(accounts),
        "warmed": warmed,
        "failed": failed,
        "errors": errors,
    }


@app.post("/api/engineering/history-warm/run")
async def post_engineering_history_warm_run(body: _HistoryWarmBody):
    """把『所有帳號』在某個月的資料抓進 account_month_snapshots(可重抓
    覆蓋,force)。當月不預熱(維持即時);上個月要過了結算緩衝期
    (本月 3 號)才開放。回每帳號成功 / 失敗數。"""
    uid = _current_fb_user_id.get()
    current = _cost_center_current_month()
    label = _cost_center_month_range(body.month)[0]
    if label >= current:
        return {"month": label, "skipped": "當月即時,不預熱", "total": 0, "warmed": 0, "failed": 0, "errors": []}
    if label > _latest_snapshotable_month():
        return {
            "month": label,
            "skipped": f"上月結算中(FB 數字回補),{_SNAPSHOT_SETTLE_DAY} 號後才可預熱",
            "total": 0,
            "warmed": 0,
            "failed": 0,
            "errors": [],
        }
    accounts = await _engineering_warm_accounts(uid)
    if not accounts:
        return {"month": label, "total": 0, "warmed": 0, "failed": 0, "errors": []}
    return await _history_warm_run_month(label, accounts)


# ── 每月自動重熱(上個月 overview 快照)─────────────────────────
#
# 修「7/1 抓 6 月不準」的第二半:結算緩衝期(_SNAPSHOT_SETTLE_DAY)擋掉
# 提早凍結之後,這裡在每月 3 號(含)之後由 _scheduler_loop 自動把上個月
# 所有帳號 force 重熱一次,老快照(或緩衝期前殘留的髒快照)一併覆蓋,
# 不需要有人記得去工程模式按按鈕。狀態存 shared_settings
# `_history_warm_auto_state`(underscore 前綴 = server-internal,不會被
# GET /api/settings/shared 吐給前端):
#   {"done": "YYYY-MM", "done_at": iso,          ← 該月已成功重熱
#    "attempt_month": "YYYY-MM", "attempt_at": iso}  ← 重試 backoff 用

_HISTORY_WARM_AUTO_STATE_KEY = "_history_warm_auto_state"
# lurefin 匯出快照(cost_center_snapshots)的每月自動重熱狀態(同結構)。
_COST_CENTER_WARM_AUTO_STATE_KEY = "_cost_center_warm_auto_state"
_HISTORY_WARM_AUTO_RETRY_GAP_S = 6 * 3600  # 全滅(warmed=0)後最快 6h 重試


async def _history_warm_auto_state_load(key: str = _HISTORY_WARM_AUTO_STATE_KEY) -> dict:
    if _db_pool is None:
        return {}
    try:
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM shared_settings WHERE key=$1",
                key,
            )
    except Exception:
        return {}
    if not row or row["value"] is None:
        return {}
    raw = row["value"]
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    return raw if isinstance(raw, dict) else {}


async def _history_warm_auto_state_save(
    state: dict, key: str = _HISTORY_WARM_AUTO_STATE_KEY
) -> None:
    if _db_pool is None:
        return
    try:
        async with _db_pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO shared_settings (key, value, updated_at)
                VALUES ($1, $2::jsonb, NOW())
                ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = NOW()
                """,
                key,
                json.dumps(state),
            )
    except Exception as e:
        print(f"[history-warm] state save failed ({key}): {e}", flush=True)


async def _history_warm_auto_tick() -> None:
    """Called every scheduler tick; no-ops until 上個月 exits the settle
    window, then force-warms it exactly once per month. Partial per-account
    failures still count as done (manual re-warm remains available); a
    total failure (warmed=0, e.g. FB token expired) leaves the month
    un-done and retries after _HISTORY_WARM_AUTO_RETRY_GAP_S."""
    if _db_pool is None:
        return
    tz = _scheduler_tz()
    today = datetime.now(timezone.utc).astimezone(tz).date()
    prev = date(today.year, today.month, 1) - timedelta(days=1)
    target = f"{prev.year:04d}-{prev.month:02d}"
    if target > _latest_snapshotable_month():
        return  # 上個月還在結算緩衝期
    state = await _history_warm_auto_state_load()
    if state.get("done") == target:
        return
    attempt_at = state.get("attempt_at")
    if state.get("attempt_month") == target and attempt_at:
        try:
            last = datetime.fromisoformat(str(attempt_at))
            if (datetime.now(timezone.utc) - last).total_seconds() < _HISTORY_WARM_AUTO_RETRY_GAP_S:
                return
        except ValueError:
            pass
    # Stamp the attempt BEFORE the fan-out so a crash / restart mid-warm
    # still respects the backoff instead of hammering FB every 60s tick.
    state["attempt_month"] = target
    state["attempt_at"] = datetime.now(timezone.utc).isoformat()
    await _history_warm_auto_state_save(state)
    _fb_call_source.set("history-warm")
    accounts = await _engineering_warm_accounts(None)
    if not accounts:
        print(f"[history-warm] auto {target}: no accounts (runtime token missing?)", flush=True)
        return
    res = await _history_warm_run_month(target, accounts)
    if res["warmed"] > 0:
        state["done"] = target
        state["done_at"] = datetime.now(timezone.utc).isoformat()
        await _history_warm_auto_state_save(state)
    print(
        f"[history-warm] auto {target}: warmed={res['warmed']} failed={res['failed']} "
        f"total={res['total']}",
        flush=True,
    )


async def _cost_center_warm_auto_tick() -> None:
    """lurefin 匯出快照(cost_center_snapshots)的每月自動重熱 — 跟
    _history_warm_auto_tick 同型,只是換成那三個帳號的 cost-center 資料。
    結算緩衝期擋掉提早凍結後,3 號後由此 force 覆蓋一次(緩衝期前殘留的
    髒快照一併蓋掉,因為 /api/cost-center 讀取端有快照就不再重抓)。"""
    if _db_pool is None:
        return
    tz = _scheduler_tz()
    today = datetime.now(timezone.utc).astimezone(tz).date()
    prev = date(today.year, today.month, 1) - timedelta(days=1)
    target = f"{prev.year:04d}-{prev.month:02d}"
    if target > _latest_snapshotable_month():
        return  # 上個月還在結算緩衝期
    state = await _history_warm_auto_state_load(_COST_CENTER_WARM_AUTO_STATE_KEY)
    if state.get("done") == target:
        return
    attempt_at = state.get("attempt_at")
    if state.get("attempt_month") == target and attempt_at:
        try:
            last = datetime.fromisoformat(str(attempt_at))
            if (datetime.now(timezone.utc) - last).total_seconds() < _HISTORY_WARM_AUTO_RETRY_GAP_S:
                return
        except ValueError:
            pass
    state["attempt_month"] = target
    state["attempt_at"] = datetime.now(timezone.utc).isoformat()
    await _history_warm_auto_state_save(state, _COST_CENTER_WARM_AUTO_STATE_KEY)
    accounts, dbg = await _cost_center_compute(target)
    good = _cost_center_capture_good(dbg)
    if good:
        await _cost_center_store_snapshot(target, accounts)
        state["done"] = target
        state["done_at"] = datetime.now(timezone.utc).isoformat()
        await _history_warm_auto_state_save(state, _COST_CENTER_WARM_AUTO_STATE_KEY)
    print(
        f"[cost-center-warm] auto {target}: stored={bool(good)} "
        f"rows={sum(len(a['rows']) for a in accounts)}",
        flush=True,
    )


# ── 工程模式:lurefin 匯出預熱（cost_center_snapshots,那三個帳號）──
#
# 跟上面的「歷史資料預熱(全帳號)」分開:這一組是 lurefin 透過
# /api/cost-center 讀的那條線,先把過往月份抓進 cost_center_snapshots,
# lurefin 拉過往月份就秒回。走一般登入 session。


@app.get("/api/engineering/cost-center/months")
async def get_engineering_cost_center_months():
    """列出 2024-01 ~ 當月,以及 lurefin 匯出快照(cost_center_snapshots)的
    狀態(已存 / 筆數)。給工程模式「lurefin 匯出預熱」表格用。"""
    current = _cost_center_current_month()
    latest_ok = _latest_snapshotable_month()
    months = _cost_center_month_list("2024-01", current)
    stored: dict = {}
    if _db_pool is not None:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT month, payload, captured_at FROM cost_center_snapshots"
            )
        for r in rows:
            payload = r["payload"]
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except Exception:
                    payload = {}
            accts = payload.get("accounts") if isinstance(payload, dict) else []
            nrows = sum(
                len(a.get("rows") or [])
                for a in (accts or [])
                if isinstance(a, dict)
            )
            ca = r["captured_at"]
            stored[r["month"]] = {
                "rows": nrows,
                "captured_at": ca.isoformat() if ca else None,
            }
    out: list = []
    for m in months:
        s = stored.get(m)
        out.append(
            {
                "month": m,
                "stored": bool(s),
                "rows": s["rows"] if s else None,
                "captured_at": s["captured_at"] if s else None,
                "is_current": m == current,
                # 上個月在 1~2 號的結算緩衝期內:FB 數字還在回補,不開放存。
                "is_settling": m < current and m > latest_ok,
            }
        )
    return {
        "current": current,
        "settle_day": _SNAPSHOT_SETTLE_DAY,
        "accounts": [a["label"] for a in COST_CENTER_ACCOUNTS],
        "months": out,
    }


class _CcCaptureBody(BaseModel):
    month: str


@app.post("/api/engineering/cost-center/capture")
async def post_engineering_cost_center_capture(body: _CcCaptureBody):
    """抓某個月的 lurefin 匯出資料並存進 cost_center_snapshots(可重抓
    覆蓋)。當月即時、不存;上個月要過了結算緩衝期(本月 3 號)才開放。"""
    current = _cost_center_current_month()
    label = _cost_center_month_range(body.month)[0]
    if label >= current:
        return {"month": label, "skipped": "當月即時,不存", "stored": False, "rows": 0, "accounts": []}
    if label > _latest_snapshotable_month():
        return {
            "month": label,
            "skipped": f"上月結算中(FB 數字回補),{_SNAPSHOT_SETTLE_DAY} 號後才可存",
            "stored": False,
            "rows": 0,
            "accounts": [],
        }
    accounts, dbg = await _cost_center_compute(label)
    good = _cost_center_capture_good(dbg)
    if good:
        await _cost_center_store_snapshot(label, accounts)
    return {
        "month": label,
        "stored": bool(good),
        "rows": sum(len(a["rows"]) for a in accounts),
        "accounts": [
            {
                "account": d["account"],
                "found": d.get("found"),
                "rows": d.get("rows_after_filter", 0),
                "fetch_error": d.get("fetch_error"),
            }
            for d in dbg["accounts"]
        ],
    }


# ── SPA catch-all (MUST be registered last) ─────────────────────────
# React Router uses client-side paths like /dashboard, /analytics, /finance.
# A browser hard-refresh on those paths hits FastAPI, which otherwise 404s.
# This catch-all returns the React index.html for any unmatched GET that
# does not look like an API or asset request.
@app.get("/{full_path:path}", response_class=HTMLResponse)
async def spa_fallback(full_path: str):
    if full_path.startswith(("api/", "static/", "assets/")):
        raise HTTPException(status_code=404, detail="Not found")
    # Served from module-level cached bytes — no disk read per request.
    return Response(
        content=_index_bytes(),
        media_type="text/html; charset=utf-8",
        headers=_HTML_NO_CACHE,
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
