from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, List
from zoneinfo import ZoneInfo
import asyncio
import traceback
import base64
import hashlib
import hmac
import math
import httpx
import os
from dotenv import load_dotenv
from pathlib import Path
from pydantic import BaseModel

import asyncpg

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

# Limit concurrent outbound FB API calls to avoid hitting Facebook's
# per-app rate limit (~200 concurrent). 40 slots ≈ 20 accounts in
# parallel (2 calls each: campaigns + insights), safely under the cap.
# Without this, a cold /api/overview for 80 accounts fans out 160+
# simultaneous requests and routinely triggers 429 rate-limiting.
_fb_semaphore: asyncio.Semaphore = asyncio.Semaphore(40)

# Per-ad-account in-flight limiter. FB's 80004 throttle is computed
# per-ad-account, so even when the global _fb_semaphore is well below
# its 40-cap, 30 calls hitting the SAME account simultaneously can
# trip the throttle. 4 in-flight per account keeps us under the
# per-account ceiling on a Limited Access tier and effectively
# unlimited on Full Access. Only paths that start with `act_<id>`
# pass through this gate; single-entity by-id calls (campaigns /
# adsets / ads) bypass since the path doesn't reveal which account
# owns them and they're rarely the burst culprit.
_PER_ACCOUNT_CONCURRENCY = 4
_per_account_semaphores: dict[str, asyncio.Semaphore] = {}


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
_warm_targets: dict[tuple[str, str, str, Optional[str], str], float] = {}

# Set whenever we observe an 80004 throttle response. The warm loop
# checks this and backs off for 10 minutes — the absolute last thing
# we want is the warm loop poking the throttled account again and
# extending the lockout.
_last_ads_throttle_at: float = 0.0

# ── LINE push scheduler ─────────────────────────────────────────────
# `_scheduler_task` holds the background asyncio task started in
# lifespan so we can cancel it cleanly on shutdown. The loop ticks
# every SCHEDULER_TICK_SECONDS and fires any push configs whose
# next_run_at has passed. 3 failures in a row flips `enabled=false`
# so a broken token doesn't spam the log forever.
_scheduler_task: Optional[asyncio.Task] = None
_warm_task: Optional[asyncio.Task] = None
# Background fire-and-forget tasks (e.g. one-shot LINE group name
# backfill on startup). We hold strong refs so asyncio doesn't gc
# them mid-run. Tasks self-discard via `add_done_callback`.
_bg_tasks: "set[asyncio.Task]" = set()
SCHEDULER_TICK_SECONDS = 60
SCHEDULER_FAIL_THRESHOLD = 3
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
            # fans out per-account fetches. 20 leaves comfortable
            # headroom; tune via env on busy deployments.
            db_pool_max = int(os.getenv("DB_POOL_MAX", "20"))
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
                # 成效優化中心 page. Each row = ONE quota use (one
                # click fans out to all 5 agents in parallel).
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

    # Cache warm-refresh loop runs regardless of DB — it operates on
    # the in-memory _warm_targets set, no PG state required.
    _warm_task = asyncio.create_task(_cache_warm_loop())
    print(
        f"[startup] cache-warm: running, tick={_WARM_TICK_SECONDS}s,"
        f" max={_WARM_MAX_PER_TICK}/tick",
        flush=True,
    )

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
    allow_headers=["Content-Type", "Authorization", "x-fb-user-id"],
)
print(f"[startup] CORS origins: {_CORS_ORIGINS}", flush=True)


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
            "connect-src 'self' https://graph.facebook.com https://*.facebook.com "
            "https://generativelanguage.googleapis.com; "
            "frame-src 'none'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'",
        )
    return resp


# Per-request user-context middleware. Pulls fb_user_id from the
# query string (or `x-fb-user-id` header for non-GET callers) and sets
# the `_current_fb_user_id` contextvar so every fb_get / fb_post inside
# the request handler routes through THAT user's FB token. Without
# this every call would still hit the legacy `_runtime_token` global
# (the last user to log in). Reset in `finally` so adjacent requests
# in the same task pool don't leak context.
#
# Spoofing note: anyone who knows another user's fb_user_id can pass
# it here and use that user's token. This is the SAME trust model as
# the rest of the app today (most endpoints already trust query-param
# fb_user_id without a real session). Tightening this requires a
# proper signed-session layer — out of scope for the multi-tenant
# data-isolation work.
@app.middleware("http")
async def _user_context_middleware(request: Request, call_next):
    uid = (
        request.query_params.get("fb_user_id")
        or request.headers.get("x-fb-user-id")
        or ""
    ).strip()
    if not uid:
        return await call_next(request)
    reset_token = _current_fb_user_id.set(uid)
    try:
        return await call_next(request)
    finally:
        _current_fb_user_id.reset(reset_token)


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
    if not _fb_usage:
        return 0
    return max(
        int(u.get("estimated_time_to_regain_access", 0) or 0) for u in _fb_usage.values()
    )


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
        _fb_cache.pop(key, None)
        _fb_cache_locks.pop(key, None)
        return None
    return data


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
      - 429  rate-limited
      - 500  upstream internal error
      - 502  bad gateway (our own "can't reach FB" wrapper code)
      - 503  service unavailable
      - 504  gateway timeout (includes the httpx TimeoutException wrap)

    We do NOT retry on 400 — that's usually a real FB API rejection
    (bad field, permission denied, unknown objective) that won't
    get better on a retry and would just double the wait for the
    user. Same for 401 (token expired) and 404 (entity gone).
    """
    return exc.status_code in (429, 500, 502, 503, 504)


async def _fb_request(
    method: str,
    path: str,
    params: Optional[dict] = None,
    data_payload: Optional[dict] = None,
    *,
    slow_ok: bool = False,
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
            return cached

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
                return cached
            return await _fb_fetch_with_retry(
                method, path, params, data_payload, token, cache_key, get_timeout
            )

    return await _fb_fetch_with_retry(
        method, path, params, data_payload, token, cache_key, get_timeout
    )


async def _fb_fetch_with_retry(
    method: str,
    path: str,
    params: dict,
    data_payload: dict,
    token: str,
    cache_key: Optional[str],
    get_timeout: float,
) -> dict:
    """Wrap :func:`_fb_fetch_and_cache` with a single retry on
    transient upstream errors (429 / 5xx / network timeout / connect
    reset). Dashboard fan-out endpoints routinely see 1-2% of calls
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
                method, path, params, data_payload, token, cache_key, get_timeout
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
            await asyncio.sleep(_FB_RETRY_DELAY_S)
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
) -> dict:
    """Inner FB call — issues the actual httpx request, handles the
    usual error pathways, and writes the result to the cache when
    ``cache_key`` is provided.
    """
    url = f"{BASE_URL}/{path}"
    # Two-layer throttle: per-account first (cap 4 same-account
    # in-flight, FB's 80004 ceiling), then global (cap 40 total). Order
    # matters — we want to BLOCK on the account gate before consuming
    # a global slot, otherwise a hot account would starve the global
    # pool. Bypass per-account when path doesn't carry act_*.
    account_id = _extract_account_id_from_path(path)
    acct_sem = _account_semaphore(account_id) if account_id else None
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
                raise HTTPException(status_code=504, detail=f"Facebook API timeout: {e}")
            except httpx.RequestError as e:
                # Includes ConnectError, ProxyError, NetworkError, etc.
                raise HTTPException(status_code=502, detail=f"Cannot reach Facebook API: {type(e).__name__}: {e}")
    # Record rate-limit usage regardless of success/error — the header
    # is present on error responses too and is how we know when it's
    # safe to retry.
    _parse_bucu_header(r.headers.get("x-business-use-case-usage"))
    # Try to parse JSON response
    try:
        body = r.json()
    except Exception:
        # FB returned non-JSON (rare, usually HTML error page)
        snippet = (r.text or "")[:300]
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
        # Ads-account throttle (80000-80014) — flag globally so the
        # cache-warm loop backs off and the next 10 minutes of
        # background activity doesn't extend the lockout.
        if isinstance(code, int) and 80000 <= code <= 80014:
            global _last_ads_throttle_at
            _last_ads_throttle_at = time.monotonic()
        raise HTTPException(status_code=400, detail=detail)
    # Cache successful GET responses
    if cache_key is not None:
        _cache_put(cache_key, body)
    return body


async def fb_get(path: str, params: Optional[dict] = None, *, slow_ok: bool = False) -> dict:
    return await _fb_request("GET", path, params=params, slow_ok=slow_ok)


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
    """
    if params is None:
        params = {}
    token = get_token()
    if not token:
        raise HTTPException(status_code=401, detail="Facebook access token not set. Please log in.")

    cache_key = _cache_key(token, path, params, kind="paged")
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached  # already a List[dict]

    lock = _cache_lock(cache_key)
    async with lock:
        # Re-check after acquiring — a concurrent waiter may have
        # populated the cache while we were blocked.
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
        return await _fb_get_paginated_fetch(path, params, token, cache_key, ttl)


async def _fb_get_paginated_fetch(
    path: str, params: dict, token: str, cache_key: str, ttl: float = _CACHE_TTL_SECONDS
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
    while next_url:
        data: Optional[dict] = None
        last_exc: Optional[HTTPException] = None
        # Per FB best practices, ads-specific account throttles
        # (80000-80014) must NOT be retried — continuing calls
        # extends the lockout. Flag is set inline when we see one.
        no_retry = False
        for attempt in range(_FB_MAX_RETRIES + 1):
            try:
                async with _fb_semaphore:
                    r = await _http_client.get(
                        next_url, params=page_params, timeout=_GET_TIMEOUT_BULK
                    )
            except httpx.TimeoutException as e:
                last_exc = HTTPException(status_code=504, detail=f"Facebook API timeout: {e}")
            except httpx.RequestError as e:
                last_exc = HTTPException(
                    status_code=502,
                    detail=f"Cannot reach Facebook API: {type(e).__name__}: {e}",
                )
            else:
                _parse_bucu_header(r.headers.get("x-business-use-case-usage"))
                try:
                    data = r.json()
                except Exception:
                    snippet = (r.text or "")[:300]
                    last_exc = HTTPException(
                        status_code=502,
                        detail=f"Facebook API returned non-JSON (HTTP {r.status_code}): {snippet}",
                    )
                    data = None
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
                        global _last_ads_throttle_at
                        _last_ads_throttle_at = time.monotonic()
                        wait_min = _peak_regain_minutes()
                        if wait_min:
                            detail = f"{detail} [retry_after_minutes={wait_min}]"
                    last_exc = HTTPException(status_code=http_status, detail=detail)
                    data = None
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
            await asyncio.sleep(_FB_RETRY_DELAY_S)
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
    return b"<!doctype html><title>LURE Meta Platform</title><body>build missing</body>"


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


def _assert_known_user(uid: str) -> None:
    """Raise 401 if `uid` is not in the set of FB user ids that have
    successfully logged in via `POST /api/auth/token`. This is the
    single-tenant agency tool's substitute for a real session — it
    blocks random callers from probing read endpoints with arbitrary
    fb_user_id query params."""
    if not uid or uid not in _KNOWN_FB_USERS:
        raise HTTPException(status_code=401, detail="未登入或登入已過期")


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


@app.post("/api/auth/token")
async def set_token(payload: TokenPayload):
    global _runtime_token
    # Temporarily set the legacy global so the /me call below has a
    # token to use — we don't know fb_user_id yet (that's exactly
    # what /me returns), so we can't yet route through
    # _user_token_cache. Once /me succeeds, we promote the token to
    # the per-user cache and the legacy global stays as the share-
    # page fallback.
    _runtime_token = payload.token
    try:
        me = await fb_get("me", {"fields": "id,name,picture"})
        uid = str(me.get("id") or "")
        pic = me.get("picture", {}).get("data", {}).get("url")
        # Only persist after the token verifies — avoids storing
        # garbage that would 401 every share-page viewer.
        await _persist_runtime_token(payload.token)
        if uid:
            _user_token_cache[uid] = payload.token
            await _persist_user_token(uid, payload.token)
            _KNOWN_FB_USERS.add(uid)
            await _persist_known_user(uid)
        return {"ok": True, "name": me.get("name"), "id": me.get("id"), "pictureUrl": pic}
    except Exception as e:
        _runtime_token = None
        # Don't leak FB error internals (URLs, app secret hints) to the
        # client — log internally, surface a generic message.
        print(f"[auth] token verify failed: {e!r}", flush=True)
        raise HTTPException(status_code=400, detail="Token verification failed")


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
    uid = (fb_user_id or "").strip()
    if uid:
        _user_token_cache.pop(uid, None)
        await _persist_user_token(uid, None)
    return {"ok": True}

@app.get("/api/auth/me")
async def get_me():
    try:
        me = await fb_get("me", {"fields": "id,name,picture.width(80)"})
        return {"logged_in": True, **me}
    except Exception:
        return {"logged_in": False}


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
    """AI 幕僚 generation clicks this user has fired so far this
    calendar month (UTC). One row in `agent_advice_runs` = one click
    = one quota use (fans out to all 5 agents in parallel on the
    backend). Used by paid tiers (basic / plus / max)."""
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
        # is preferred (PUBLIC_SITE_URL=https://metadash.zeabur.app).
        site = "https://metadash.zeabur.app"

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


# ── Quick Launch ──────────────────────────────────────────────────────

class CampaignCreate(BaseModel):
    account_id: str
    name: str
    objective: str = "OUTCOME_TRAFFIC"
    daily_budget: int = 500  # TWD
    status: str = "PAUSED"

@app.post("/api/quick-launch/campaign")
async def quick_launch_campaign(payload: CampaignCreate):
    return await fb_post(
        f"{payload.account_id}/campaigns",
        {
            "name": payload.name,
            "objective": payload.objective,
            "status": payload.status,
            "special_ad_categories": "[]",
            "daily_budget": str(payload.daily_budget),
        },
        invalidate_account=payload.account_id,
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
            "fields": "id,name,account_status,currency,timezone_name,business",
            "limit": "500",
        },
        ttl=_ACCOUNTS_CACHE_TTL_SECONDS,
    )
    return {"data": accounts}


@app.get("/api/fb-usage")
async def get_fb_usage():
    """Latest parsed `X-Business-Use-Case-Usage` snapshot.

    Populated as a side-effect of every FB call. Entries expire on
    their own (FB re-sends the header on subsequent calls with fresh
    numbers); we don't age them out on our side because "last known
    value" is what the UI wants anyway.
    """
    return {"data": _fb_usage, "peak_regain_minutes": _peak_regain_minutes()}


# ── 行銷活動 ─────────────────────────────────────────────────────────

async def _fetch_campaigns_for_account(
    account_id: str,
    date_preset: str,
    time_range: Optional[str],
    include_archived: bool,
    lite: bool = False,
) -> List[dict]:
    """Core campaign-fetch logic with FB-side progressive fallback.

    Extracted from the ``get_campaigns`` route so the same behavior
    (including the 4-tier retry chain) can be shared by the batch
    ``/api/overview`` endpoint without duplication. Returns the raw
    campaign list; the caller wraps it into whatever envelope shape
    it needs.

    When ``lite=True``, skips the insights field expansion entirely
    and only fetches campaign metadata (name, status, budget). This
    is much faster (~1-2s vs ~5-15s) and is used for the two-phase
    loading pattern: show campaign rows immediately, then backfill
    insights from the full request.

    Raises ``HTTPException`` if every tier fails so callers can
    decide whether to surface the error or swallow it for a
    partial-success response.
    """
    # Register as a warm target so the cache-warm loop refreshes this
    # entry just before TTL expires. Lite-mode reads (skeleton) are
    # NOT registered — they're cheap and already happen pre-paint, no
    # need to keep them warm in the background. Includes fb_user_id
    # from contextvar so the warm loop can re-fire under the same
    # per-user FB token.
    if not lite:
        warm_uid = _current_fb_user_id.get() or ""
        if warm_uid:
            _warm_targets[(account_id, "campaigns", date_preset, time_range, warm_uid)] = (
                time.monotonic()
            )
    ins = _insights_clause(
        "spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,"
        "inline_link_clicks,cost_per_inline_link_click,"
        "cost_per_action_type,purchase_roas,website_purchase_roas",
        date_preset,
        time_range,
    )
    # `adsets{daily_budget,lifetime_budget,status}` nests the per-adset
    # budgets so the security view can compute an "effective" daily
    # budget when the campaign itself uses ABO (budget set on adsets
    # instead of the campaign). limit(50) caps payload — campaigns
    # with more adsets than that are rare and will just under-report.
    adset_nest = "adsets.limit(50){daily_budget,lifetime_budget,status}"
    full_fields = (
        f"id,name,status,objective,daily_budget,lifetime_budget,"
        f"created_time,updated_time,{adset_nest},{ins}"
    )
    no_ins_fields = (
        f"id,name,status,objective,daily_budget,lifetime_budget,"
        f"created_time,updated_time,{adset_nest}"
    )
    archived_filter = {"effective_status": '["ACTIVE","PAUSED","ARCHIVED","DELETED"]'}

    # Lite mode: skip insights entirely for fast first-paint.
    if lite:
        params: dict = {"fields": no_ins_fields, "limit": "500"}
        if include_archived:
            params.update(archived_filter)
        return await fb_get_paginated(f"{account_id}/campaigns", params)

    attempts: list[tuple[str, dict]] = []
    if include_archived:
        attempts.append(("insights+archived", {"fields": full_fields, "limit": "500", **archived_filter}))
    attempts.append(("insights", {"fields": full_fields, "limit": "500"}))
    if include_archived:
        attempts.append(("no-insights+archived", {"fields": no_ins_fields, "limit": "500", **archived_filter}))
    attempts.append(("no-insights", {"fields": no_ins_fields, "limit": "500"}))
    attempts.append(("minimal", {"fields": "id,name,status", "limit": "500"}))

    last_error: Optional[HTTPException] = None
    for tier, params in attempts:
        try:
            camps = await fb_get_paginated(f"{account_id}/campaigns", params)
            if last_error is not None:
                print(
                    f"[campaigns] {account_id} recovered at tier={tier} "
                    f"after earlier failure: {last_error.detail}",
                    flush=True,
                )
            return camps
        except HTTPException as e:
            print(
                f"[campaigns] {account_id} tier={tier} failed: "
                f"{e.status_code} {e.detail}",
                flush=True,
            )
            last_error = e
            continue

    if last_error is not None:
        raise last_error
    raise HTTPException(status_code=502, detail="Failed to load campaigns from Facebook API")


@app.get("/api/accounts/{account_id}/campaigns")
async def get_campaigns(account_id: str, date_preset: str = "last_30d", time_range: Optional[str] = None, include_archived: bool = False):
    """List campaigns for an account, with progressive fallback so a
    single FB-side restriction (e.g. effective_status not allowed on
    a particular ad account) doesn't make the whole call return 400.

    Delegates to :func:`_fetch_campaigns_for_account` so the batch
    ``/api/overview`` endpoint can share the same retry logic.
    """
    camps = await _fetch_campaigns_for_account(
        account_id, date_preset, time_range, include_archived
    )
    return {"data": camps}


@app.get("/api/accounts/{account_id}/activities")
async def get_account_activities(
    account_id: str,
    since: int = Query(..., description="Unix timestamp (inclusive) lower bound"),
    until: int = Query(..., description="Unix timestamp (exclusive) upper bound"),
):
    """Proxy the FB Activity Log for an ad account.

    Powers the 安全監控 view's per-campaign edit-history expand. Returns
    raw activity rows so the frontend can group by ``object_id``.

    Activity fields requested: who (actor_name), what (event_type +
    translated_event_type), when (event_time), which object
    (object_id, object_name, object_type), and a JSON-string
    ``extra_data`` blob with before/after for status / budget / name
    changes (FB's shape is unstable so we surface it verbatim).
    """
    data = await fb_get_paginated(
        f"{account_id}/activities",
        {
            "since": str(since),
            "until": str(until),
            "fields": (
                "actor_id,actor_name,event_time,event_type,extra_data,"
                "object_id,object_name,object_type,translated_event_type"
            ),
            "limit": "500",
        },
    )
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
async def get_adsets(campaign_id: str, date_preset: str = "last_30d", time_range: Optional[str] = None):
    ins = _insights_clause(
        "spend,impressions,clicks,ctr,cpc,cpm,frequency,actions,"
        "inline_link_clicks,cost_per_inline_link_click,"
        "cost_per_action_type,purchase_roas,website_purchase_roas",
        date_preset,
        time_range,
    )
    try:
        data = await fb_get(f"{campaign_id}/adsets", {
            "fields": f"id,name,status,daily_budget,lifetime_budget,{ins}",
            "limit": "500"
        })
    except HTTPException:
        # Fallback without insights if date query fails
        data = await fb_get(f"{campaign_id}/adsets", {
            "fields": "id,name,status,daily_budget,lifetime_budget",
            "limit": "500"
        })
    return data


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
    ins = _insights_clause(
        "spend,impressions,clicks,ctr,cpc,cpm,actions,"
        "inline_link_clicks,cost_per_inline_link_click,"
        "cost_per_action_type,purchase_roas,website_purchase_roas",
        date_preset,
        time_range,
    )
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
    oss_expanded = (
        "object_story_spec{video_data,link_data,photo_data,template_data}"
    )
    # Note: ``creative{id,...}`` — we explicitly request the creative
    # id so the frontend can hit /api/creatives/{id}/hires-thumbnail
    # as a 600px fallback when /api/posts/{post_id}/media fails
    # (typically when the token lacks pages_read_engagement).
    attempts = [
        # Tier 1: everything — image_url for sharp still preview,
        # expanded object_story_spec so we can classify inline vs
        # front-stage, plus the two permalink fields.
        f"id,name,status,creative{{id,thumbnail_url,image_url,{oss_expanded},effective_object_story_id,instagram_permalink_url,title,body}},{ins}",
        # Tier 2: drop object_story_spec (some accounts reject it).
        f"id,name,status,creative{{id,thumbnail_url,image_url,effective_object_story_id,instagram_permalink_url,title,body}},{ins}",
        # Tier 3: drop image_url.
        f"id,name,status,creative{{id,thumbnail_url,effective_object_story_id,instagram_permalink_url,title,body}},{ins}",
        f"id,name,status,{ins}",
        "id,name,status",
    ]
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
            return await fb_get(f"{adset_id}/ads", params)
        except HTTPException as e:
            last_error = e
            continue
    # All attempts failed — surface the most recent error so the frontend can
    # display the actual reason instead of a silent 500.
    if last_error is not None:
        raise last_error
    raise HTTPException(status_code=502, detail="Failed to load ads from Facebook API")


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
    try:
        data = await fb_get(page_id, {"fields": "name,picture.width(80).height(80)"})
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
    warm_uid = _current_fb_user_id.get() or ""
    if warm_uid:
        _warm_targets[(account_id, "insights", date_preset, time_range, warm_uid)] = (
            time.monotonic()
        )
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

@app.get("/api/overview")
async def get_overview(
    ids: str = Query(..., description="Comma-separated account ids (e.g. 'act_1,act_2')"),
    date_preset: str = "last_30d",
    time_range: Optional[str] = None,
    include_archived: bool = False,
    lite: bool = False,
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

    async def _fetch_one(aid: str):
        """Campaigns + insights for one account in parallel. Sub-fetch
        failures are captured as an ``error`` string so the outer
        gather always resolves cleanly.

        In ``lite`` mode, only campaign metadata is fetched (no insights)
        so the frontend can show campaign rows within ~1-2s. The full
        data follows from a parallel non-lite request.
        """
        camps_task = asyncio.create_task(
            _fetch_campaigns_for_account(aid, date_preset, time_range, include_archived, lite=lite)
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

        return aid, {
            "campaigns": camps,
            "insights": ins_flat,
            "error": "; ".join(error_parts) if error_parts else None,
        }

    # Outer gather — N accounts concurrent. Each _fetch_one is wrapped
    # in a 30-second timeout so one slow account (e.g. stuck in the
    # 5-tier campaign fallback chain) can't hold up the entire batch.
    # Timed-out accounts get an error entry; faster accounts still
    # return data normally.
    async def _fetch_one_bounded(aid: str):
        try:
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


# Field-family classifications used to gate recommendation blocks.
# Mirrors the codes in `frontend/src/lib/reportFields.ts`. When the
# user has explicitly selected a set of report_fields for a LINE push,
# we ONLY run rule blocks whose family intersects that selection — so
# an e-commerce-focused report doesn't get bombarded with messaging
# advice that's irrelevant to the recipient.
_MSG_FIELDS = {"msgs", "msg_cost"}
_PURCHASE_FIELDS = {"purchases", "cost_per_purchase", "roas"}
_ATC_FIELDS = {"add_to_cart", "cost_per_add_to_cart"}
_TRAFFIC_FIELDS = {"link_clicks", "cost_per_link_click"}


def _evaluate_alert_recommendations(
    *,
    spend: float,
    msgs: int,
    msg_cost: float,
    cpc: float,
    frequency: float,
    objective: Optional[str] = None,
    purchases: int = 0,
    cost_per_purchase: float = 0.0,
    roas: float = 0.0,
    add_to_cart: int = 0,
    cost_per_add_to_cart: float = 0.0,
    link_clicks: int = 0,
    cost_per_link_click: float = 0.0,
    selected_fields: Optional[List[str]] = None,
) -> List[str]:
    """產生 LINE flex 報告的優化建議。建議內容依使用者勾選的 report_fields
    動態調整 — 訊息類報告就給訊息建議,電商類就給購買/ATC 建議,流量類
    就給連結點擊建議。沒選 → 視同 legacy 私訊主軸的全套規則。

    私訊成本分段(只在 msgs / msg_cost 被選 OR 沒指定時觸發):
        < $100  非常好(以私訊為主軸,忽略 CPC)
        100~200 平均值,維持現狀
        200~300 偏高,待觀察
        > $300  太高(連同 CPC 對比評論,忽略頻次)

    購買 / ROAS 分段(purchases / cost_per_purchase / roas 被選):
        ROAS > 4 + 購買 > 0     表現亮眼,擴大預算測試承載
        ROAS 2~4               平均水準,維持現狀
        ROAS 1~2               偏低,檢視出價或加價策略
        ROAS < 1 + 購買 > 0     虧損中,立即優化
        購買 == 0 + 加購 > 5    結帳/運費勸退,需檢查
        購買 == 0 + spend>$1k  Pixel 未觸發或受眾不對

    加購分段(add_to_cart / cost_per_add_to_cart 被選):
        加購 == 0 + spend > $500  目前無加購訊號,檢查 Pixel/落地頁
        加購成本 > $200            加購成本偏高,優化前端漏斗

    連結點擊分段(link_clicks / cost_per_link_click 被選):
        cost_per_link_click > $6    太高,需調整素材
        cost_per_link_click 4~6     可以優化
        cost_per_link_click 3~4     偏高,待觀察

    CPC + 頻次:msg/purchase 區塊都未觸發時才評論,避免重複建議。
    流量類目標 (objective in _TRAFFIC_OBJECTIVES) 跳過私訊邏輯,因為
    這些 campaign 不是私訊優化的,msgCost 是雜訊。
    """
    out: List[str] = []
    traffic_mode = _is_traffic_objective(objective)
    selected = set(selected_fields or [])

    # Decide which rule families to run. When user hasn't picked any
    # fields (legacy default config) OR explicitly picked msg fields,
    # the msg block is on. When user picked NO msg fields but DID
    # pick e-commerce/traffic fields, suppress msg to keep the report
    # tightly focused on what they asked for.
    msg_picked = bool(selected & _MSG_FIELDS)
    purchase_picked = bool(selected & _PURCHASE_FIELDS)
    atc_picked = bool(selected & _ATC_FIELDS)
    traffic_picked = bool(selected & _TRAFFIC_FIELDS)
    has_explicit_non_msg = purchase_picked or atc_picked or traffic_picked
    show_msg = (not selected) or msg_picked or (not has_explicit_non_msg)

    has_msg = show_msg and (not traffic_mode) and msgs > 0
    skip_frequency = False

    if has_msg:
        if msg_cost < 100:
            out.append(f"私訊成本 ${msg_cost:.0f} 非常好,持續以私訊轉換為主軸")
        elif msg_cost <= 200:
            out.append(f"私訊成本 ${msg_cost:.0f} 為平均值,維持現狀即可")
        elif msg_cost <= 300:
            out.append(f"私訊成本 ${msg_cost:.0f} 偏高,待觀察")
        else:
            skip_frequency = True
            if cpc <= 4:
                out.append(
                    f"私訊成本 ${msg_cost:.0f} 太高、但 CPC ${cpc:.2f} 表現不錯,"
                    "建議檢視私訊回覆流程或落地頁轉換"
                )
            else:
                out.append(
                    f"私訊成本 ${msg_cost:.0f} 太高、CPC ${cpc:.2f} 也偏高,"
                    "建議從受眾與素材整體優化"
                )

    # Purchase / ROAS block.
    if purchase_picked:
        if purchases > 0:
            if roas > 4:
                out.append(f"ROAS {roas:.2f} 表現亮眼,可考慮擴大預算測試承載量")
            elif roas >= 2:
                out.append(f"ROAS {roas:.2f} 為平均水準,維持現狀觀察")
            elif roas >= 1:
                out.append(f"ROAS {roas:.2f} 偏低,檢視出價策略或產品加價空間")
            elif roas > 0:
                out.append(f"ROAS {roas:.2f} 低於 1 處於虧損,需立即優化或暫停")
            elif cost_per_purchase > 0:
                out.append(
                    f"購買成本 ${cost_per_purchase:.0f},無 ROAS 資料,"
                    "建議確認購買價值是否有上傳"
                )
        else:
            # 沒有購買 → 視 ATC / spend 給線索
            if add_to_cart >= 5:
                out.append(
                    f"有 {add_to_cart} 次加購但 0 購買,結帳流程或運費可能勸退顧客"
                )
            elif spend > 1000:
                out.append("尚未產生購買,先檢查 Pixel 觸發或受眾是否吻合")

    # ATC block — independent of purchase block, so e.g. user who
    # only picked ATC fields still gets ATC-specific advice.
    if atc_picked and not purchase_picked:
        if add_to_cart == 0 and spend > 500:
            out.append("目前無加購訊號,建議檢查 Pixel 設定與落地頁吸引力")
        elif cost_per_add_to_cart > 200 and add_to_cart > 0:
            out.append(
                f"加購成本 ${cost_per_add_to_cart:.0f} 偏高,優化前端轉換漏斗"
            )

    # Traffic block — only run when no msg/purchase block fired
    # (otherwise the link-click advice is noise alongside actual
    # conversion advice).
    if traffic_picked and not has_msg and not purchase_picked:
        if cost_per_link_click > 6:
            out.append(f"連結點擊成本 ${cost_per_link_click:.0f} 太高,需調整素材或受眾")
        elif cost_per_link_click > 4:
            out.append(f"連結點擊成本 ${cost_per_link_click:.0f} 可以優化")
        elif cost_per_link_click > 3:
            out.append(f"連結點擊成本 ${cost_per_link_click:.0f} 偏高,待觀察")

    # CPC fallback — only when no msg block fired AND no e-commerce
    # block hit (avoid stacking generic CPC advice on top of more
    # specific recommendations).
    if not has_msg and not purchase_picked and not traffic_picked:
        if cpc > 6:
            out.append(f"CPC ${cpc:.2f} 太高,需要調整")
        elif cpc > 5:
            out.append(f"CPC ${cpc:.2f} 可以優化")
        elif cpc > 4:
            out.append(f"CPC ${cpc:.2f} 偏高,待觀察")

    if not skip_frequency:
        if frequency > 5 and spend > 1000:
            out.append(f"頻次 {frequency:.1f} 過高,建議擴大受眾避免廣告疲勞")
        elif frequency > 4 and spend > 500:
            out.append(f"頻次 {frequency:.1f} 偏高,需留意素材疲勞")

    if not out and spend > 0:
        out.append("整體表現穩定,持續觀察素材成效")
    return out


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

PUBLIC_SITE_URL = os.getenv("PUBLIC_SITE_URL", "").rstrip("/")


def _share_url_for_config(
    account_id: str,
    campaign_id: str,
    date_range: str,
    date_from: Any = None,
    date_to: Any = None,
    include_recommendations: bool = True,
    use_spend_plus: bool = False,
    markup_pct: float = 0.0,
    selected_fields: Optional[List[str]] = None,
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
    # Mirror the push config's include_recommendations toggle to the
    # share page so the「優化建議」block hides on the public report
    # whenever the operator opted out of advice in the LINE flex.
    # Only emit `advice=0` (explicit hide) — default true on the share
    # page means legacy links keep showing recommendations.
    if not include_recommendations:
        params["advice"] = "0"
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
    qs = urlencode(params)
    return f"{PUBLIC_SITE_URL}/r/{quote(campaign_id, safe='')}?{qs}"


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


async def _build_flex_for_config(cfg: dict) -> dict:
    """Produce the LINE Flex Message for one push config row.

    Hits FB's per-campaign Graph endpoint directly (`GET /{campaign_id}`)
    instead of `_fetch_campaigns_for_account` which would page through
    every campaign on the account just to pick one — that fan-out is
    the dominant latency in the manual「測試」button (5–15 s for big
    accounts). Single-campaign lookup is one HTTP round-trip and
    completes in well under a second.
    """
    account_id = cfg["account_id"]
    campaign_id = cfg["campaign_id"]
    date_range = cfg["date_range"]
    date_from = cfg.get("date_from")
    date_to = cfg.get("date_to")
    date_preset, time_range = _date_range_to_preset(date_range, date_from, date_to)

    ins_clause = _insights_clause(
        "spend,impressions,clicks,ctr,cpc,cpm,frequency,reach,actions,"
        "inline_link_clicks,cost_per_inline_link_click,"
        "cost_per_action_type,purchase_roas,website_purchase_roas",
        date_preset,
        time_range,
    )
    fields = f"id,name,status,objective,daily_budget,lifetime_budget,updated_time,{ins_clause}"
    try:
        camp = await fb_get(campaign_id, {"fields": fields})
    except HTTPException:
        # Fall back to the account-wide path if FB rejects the
        # single-campaign request (e.g. campaign was archived in a
        # way that needs the account-level filter to surface).
        campaigns = await _fetch_campaigns_for_account(
            account_id, date_preset, time_range, include_archived=True, lite=False
        )
        camp = next((c for c in campaigns if c.get("id") == campaign_id), None)
        if camp is None:
            raise RuntimeError(f"Campaign {campaign_id} not found under {account_id}")

    ins_list = (camp.get("insights") or {}).get("data") or []
    ins = ins_list[0] if ins_list else {}
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

    # E-commerce KPIs. Action-type lookups walk a priority list:
    # omni_* (cross-platform aggregate) is preferred when present,
    # falling back to pixel-only or generic. ROAS lives in its own
    # array shape, with website_purchase_roas as the secondary source
    # for accounts that only run web pixel conversions.
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

    objective = camp.get("objective")
    traffic_mode = _is_traffic_objective(objective)
    objective_label = _translate_objective(objective)

    # 計算 +% 後的金額(若使用者在 multi-select 選了 spend_plus
    # 取代 spend,報告的花費就會顯示這個含成本加成的數字)。
    # 標籤刻意用「花費*」星號代替具體百分比 — LINE 報告的對象通常
    # 是業主而非內部,不要洩漏具體加成比例。
    markup_pct = await _markup_for_campaign(campaign_id)
    spend_plus_f = math.ceil(spend_f * (1 + markup_pct / 100)) if spend_f > 0 else 0.0
    spend_plus_label = "花費*"

    # 全部可選的 KPI 欄位 — code → (label, value getter)。新增欄位
    # 在這個 dict 一處改即可,前端 multi-select 也讀取相同的 code。
    # spend / spend_plus 在 UI 是 mutex,同一份報告只會出現一個。
    msg_cost_str = _fmt_money(msg_cost_f) if msgs > 0 else "—"
    msgs_str = _fmt_int(msgs) if msgs > 0 else "—"
    field_catalog: dict[str, tuple[str, str]] = {
        "spend": ("花費", _fmt_money(spend_f)),
        "spend_plus": (spend_plus_label, _fmt_money(spend_plus_f)),
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

    selected = list(cfg.get("report_fields") or [])
    if selected:
        # 使用者自訂欄位:照他們選的順序輸出,跳過 catalog 沒有的 code
        kpis = [field_catalog[c] for c in selected if c in field_catalog]
    else:
        # 預設(沿用先前行為):流量目標略過私訊指標
        default_codes = ["spend", "impressions", "clicks", "ctr", "cpc"]
        if not traffic_mode:
            default_codes += ["msgs", "msg_cost"]
        kpis = [field_catalog[c] for c in default_codes]

    recommendations = (
        _evaluate_alert_recommendations(
            spend=spend_f,
            msgs=msgs,
            msg_cost=msg_cost_f,
            cpc=cpc_f,
            frequency=freq_f,
            objective=objective,
            purchases=purchases_n,
            cost_per_purchase=cost_per_purchase_f,
            roas=roas_f,
            add_to_cart=atc_n,
            cost_per_add_to_cart=cost_per_atc_f,
            link_clicks=link_clicks_n,
            cost_per_link_click=cost_per_link_click_f,
            selected_fields=list(cfg.get("report_fields") or []),
        )
        if cfg.get("include_recommendations")
        else None
    )

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
    # whether the campaign behind these numbers is still ACTIVE or has
    # been paused / archived. For PAUSED we also prepend M/D parsed
    # from `updated_time` (FB doesn't expose a dedicated paused-at
    # timestamp without the Activity Log endpoint, but updated_time
    # is the last modification — close enough for "paused since").
    status_raw = (camp.get("status") or "").upper()
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
        updated_raw = camp.get("updated_time") or ""
        try:
            # FB returns "2026-04-12T08:30:00+0000" — parse to local M/D
            dt = datetime.fromisoformat(updated_raw.replace("+0000", "+00:00"))
            status_label = f"{dt.month}/{dt.day} {status_label}"
        except (TypeError, ValueError):
            pass

    # Footer button is opt-in per config (column added 2026-04-29).
    # Pass date_from / date_to so the share page lands on the same
    # reporting window as the push (custom / month_to_yesterday /
    # last_14d would otherwise be downgraded by _SHARE_DATE_PRESET).
    # `include_recommendations` is mirrored so the share page hides
    # the「優化建議」block whenever the LINE flex did. spend_plus
    # mirrors the spend / spend_plus mutex pair from report_fields so
    # the share page's「花費」cell shows the same marked-up amount
    # that appeared on the LINE flex (`花費*`).
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
    report_url = (
        _share_url_for_config(
            account_id,
            campaign_id,
            date_range,
            date_from,
            date_to,
            include_recommendations=bool(cfg.get("include_recommendations")),
            use_spend_plus=use_spend_plus,
            markup_pct=markup_pct,
            selected_fields=share_fields,
        )
        if cfg.get("include_report_button")
        else None
    )

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
                   g.channel_id,
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
        "include_recommendations": bool(r["include_recommendations"]),
        "campaign_name": r["campaign_name"] or "",
        "date_from": r["date_from"].isoformat() if r["date_from"] else None,
        "date_to": r["date_to"].isoformat() if r["date_to"] else None,
        "last_run_at": r["last_run_at"].isoformat() if r["last_run_at"] else None,
        "next_run_at": r["next_run_at"].isoformat() if r["next_run_at"] else None,
        "last_error": r["last_error"],
        "fail_count": r["fail_count"],
    }


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
        if payload.id:
            row = await conn.fetchrow(
                """
                UPDATE campaign_line_push_configs
                SET campaign_id = $1, account_id = $2, group_id = $3,
                    frequency = $4, weekdays = $5, month_day = $6,
                    hour = $7, minute = $8, date_range = $9, enabled = $10,
                    report_fields = $11, include_report_button = $12,
                    include_recommendations = $13, campaign_name = $14,
                    date_from = $15, date_to = $16,
                    next_run_at = $17, fail_count = 0, last_error = NULL,
                    updated_at = NOW()
                WHERE id = $18::uuid
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
                next_run,
                payload.id,
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
                    date_from, date_to, next_run_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
                    next_run_at = EXCLUDED.next_run_at,
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
                next_run,
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
        flex = await _build_flex_for_config(cfg)
        assert _http_client is not None
        creds = await _channel_creds_for_group(cfg["group_id"])
        if creds is None:
            raise RuntimeError("No enabled LINE channel for this group")
        await line_client.line_push(
            _http_client, cfg["group_id"], [flex], access_token=creds[2]
        )
        async with pool.acquire() as conn:
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
    except Exception as e:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO line_push_logs (config_id, success, error)
                VALUES ($1::uuid, FALSE, $2)
                """,
                config_id,
                str(e)[:500],
            )
        raise HTTPException(status_code=502, detail=f"LINE push failed: {e}")


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
    poll_interval_minutes: int = 10
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
    if not (1 <= p.poll_interval_minutes <= 1440):
        raise HTTPException(status_code=400, detail="poll_interval_minutes 必須在 1-1440 之間")


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
                payload.poll_interval_minutes,
                payload.enabled,
            )
            return {"ok": True, "data": _sec_push_row_to_dict(updated)}
        created = await conn.fetchrow(
            """
            INSERT INTO security_push_configs (
                name, owner_fb_user_id, channel_id, group_ids,
                account_ids, anomaly_filters, poll_interval_minutes,
                enabled, next_run_at
            )
            VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, NOW())
            RETURNING *
            """,
            payload.name.strip(),
            fb_user_id,
            payload.channel_id,
            payload.group_ids,
            payload.account_ids,
            filters,
            payload.poll_interval_minutes,
            payload.enabled,
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


@app.post("/api/security-push/configs/{config_id}/test")
async def test_security_push_config(config_id: str, fb_user_id: str = Query(...)):
    """Fire a placeholder push to every group in this config so the
    user can verify channel access + group membership without waiting
    for the next anomaly to trigger. Does NOT advance `last_run_at`,
    so the next scheduler tick still processes real events normally."""
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

    filter_labels = "、".join(
        _ANOMALY_LABELS.get(t, t) for t in (row["anomaly_filters"] or [])
    ) or "(尚未選擇)"
    text = (
        "🧪 [測試推播] 安全監控設定可正常運作\n"
        f"設定名稱:{row['name']}\n"
        f"目標群組:{len(row['group_ids'] or [])} 個\n"
        f"異常條件:{filter_labels}\n"
        f"檢查頻率:每 {row['poll_interval_minutes']} 分鐘\n\n"
        "實際推播會在偵測到新建立活動命中以上條件時自動發出。"
    )

    errors: List[str] = []
    sent = 0
    for gid in (row["group_ids"] or []):
        try:
            await line_client.line_push(
                _http_client,
                gid,
                [{"type": "text", "text": text}],
                access_token=ch_row["access_token"],
            )
            sent += 1
        except line_client.LinePushError as e:
            errors.append(f"group {gid}: {e}")

    if errors and sent == 0:
        raise HTTPException(status_code=502, detail="; ".join(errors))
    return {"ok": True, "sent": sent, "errors": errors}


# ── Scheduler loop ────────────────────────────────────────────

async def _scheduler_tick() -> None:
    """Run one pass: find due configs, push each, update bookkeeping.

    Uses `FOR UPDATE SKIP LOCKED` so two concurrent workers (or two
    overlapping ticks) never grab the same row — each row is owned
    by exactly one worker for the duration of the transaction.
    """
    if _db_pool is None:
        return
    now = datetime.now(timezone.utc)
    async with _db_pool.acquire() as conn:
        async with conn.transaction():
            due = await conn.fetch(
                """
                SELECT * FROM campaign_line_push_configs
                WHERE enabled
                  AND next_run_at <= $1
                  AND (last_run_at IS NULL OR last_run_at < next_run_at)
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
            # Use the LinePushError friendly message when available so
            # the「last_error」 column shows actionable Chinese (e.g.
            # 「LINE 官方帳號本月推播額度已用完 ...」 instead of the
            # raw English 「You have reached your monthly limit」.
            err_text = (
                e.friendly_message
                if isinstance(e, line_client.LinePushError)
                else str(e)
            )[:500]
            fail_count = int(cfg.get("fail_count") or 0) + 1
            auto_disable = fail_count >= SCHEDULER_FAIL_THRESHOLD
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE campaign_line_push_configs
                    SET fail_count = $1, last_error = $2,
                        enabled = CASE WHEN $3 THEN FALSE ELSE enabled END,
                        updated_at = NOW()
                    WHERE id = $4::uuid
                    """,
                    fail_count,
                    err_text,
                    auto_disable,
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
    """
    try:
        while True:
            try:
                await _scheduler_tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[scheduler] tick error: {e}", flush=True)
            try:
                await _security_push_tick()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[security-push] tick error: {e}", flush=True)
            await asyncio.sleep(SCHEDULER_TICK_SECONDS)
    except asyncio.CancelledError:
        print("[scheduler] stopped", flush=True)
        raise


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


_ANOMALY_LABELS = {
    "deep_night": "深夜創建",
    "weekend": "週末創建",
    "high_budget": "日預算 > $2000",
    "burst": "短時間高頻",
    "abnormal_language": "異常語言",
}


def _format_security_push_text(matches: List[dict]) -> str:
    """Render plain-text LINE message for a batch of flagged campaigns.

    Each match dict has keys: campaign (raw FB campaign dict),
    account_name (str), anomalies (list[str]), creator (str | None).
    Up to 5 campaigns per message; trims with "...還有 N 則" when more.
    """
    lines: List[str] = ["🚨 新建立活動異常通知", ""]
    shown = matches[:5]
    for idx, m in enumerate(shown, 1):
        c = m["campaign"]
        budget_v = _effective_daily_budget(c)
        budget_txt = f"${budget_v:,}" if budget_v else "—"
        anomaly_txt = "、".join(_ANOMALY_LABELS.get(t, t) for t in m["anomalies"])
        creator = m.get("creator") or "—"
        created_local = ""
        try:
            iso = c.get("created_time") or ""
            if len(iso) >= 5 and iso[-5] in ("+", "-") and iso[-3] != ":":
                iso = iso[:-2] + ":" + iso[-2:]
            local = datetime.fromisoformat(iso).astimezone(_scheduler_tz())
            created_local = local.strftime("%m/%d %H:%M")
        except (TypeError, ValueError):
            pass
        name = c.get("name") or "(未命名)"
        cid = c.get("id") or ""
        acct_name = m.get("account_name") or ""
        lines.append(f"{idx}. {name}")
        lines.append(f"   帳戶：{acct_name}")
        if created_local:
            lines.append(f"   建立時間：{created_local}")
        lines.append(f"   建立者：{creator}")
        lines.append(f"   日預算：{budget_txt}")
        lines.append(f"   標記：{anomaly_txt}")
        lines.append(f"   編號：{cid}")
        lines.append("")
    extra = len(matches) - len(shown)
    if extra > 0:
        lines.append(f"...另有 {extra} 則新建立活動觸發告警")
    return "\n".join(lines).rstrip()


async def _security_push_run_one(cfg: dict) -> None:
    """Process a single security_push_configs row: fetch campaigns
    created since last_run_at, flag matches, push LINE message."""
    owner_uid = cfg["owner_fb_user_id"]
    if not owner_uid:
        raise RuntimeError("config has no owner_fb_user_id")

    # Resolve channel access_token
    if _db_pool is None:
        return
    async with _db_pool.acquire() as conn:
        ch_row = await conn.fetchrow(
            "SELECT access_token FROM line_channels WHERE id = $1 AND enabled",
            cfg["channel_id"],
        )
    if not ch_row or not ch_row["access_token"]:
        raise RuntimeError("channel disabled or missing access_token")
    access_token = ch_row["access_token"]

    # Determine account scope. Empty array → all of the owner's
    # currently-enabled accounts (intersected with their actual FB
    # account list to drop stale ids).
    account_ids = list(cfg.get("account_ids") or [])
    if not account_ids:
        # Pull the owner's selected_accounts from user_settings
        async with _db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value FROM user_settings WHERE fb_user_id = $1 AND key = 'selected_accounts'",
                owner_uid,
            )
        if row and row["value"]:
            try:
                account_ids = [str(x) for x in row["value"] if x]
            except (TypeError, ValueError):
                account_ids = []
    if not account_ids:
        # Nothing to scan; still bump next_run_at so we don't busy-loop.
        return

    since_dt = cfg.get("last_run_at") or (datetime.now(timezone.utc) - timedelta(hours=24))
    if since_dt.tzinfo is None:
        since_dt = since_dt.replace(tzinfo=timezone.utc)

    filters = set(cfg.get("anomaly_filters") or [])

    # Pull campaigns under the owner's FB token context. Use lite
    # mode (no insights) for speed — we only need name / created_time
    # / daily_budget / adsets.
    ctx_token = _current_fb_user_id.set(owner_uid)
    try:
        matches: List[dict] = []
        for aid in account_ids:
            try:
                camps = await _fetch_campaigns_for_account(
                    aid,
                    date_preset="last_7d",
                    time_range=None,
                    include_archived=True,
                    lite=True,
                )
            except HTTPException as e:
                print(f"[security-push] fetch {aid} failed: {e.detail}", flush=True)
                continue
            for c in camps:
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
                if not hit:
                    continue
                matches.append(
                    {
                        "campaign": c,
                        "account_id": aid,
                        "account_name": "",
                        "anomalies": hit,
                        "creator": None,
                    }
                )

        if not matches:
            return

        # Fetch account names + recent create-event actors. Best-effort.
        async with _db_pool.acquire() as conn:
            pass  # placeholder, names enriched below from FB
        # Account names: cheap re-fetch via FB
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

        # Activity-log lookup for creator names. One call per affected
        # account; bounded by the date-range since last_run_at.
        since_epoch = int(since_dt.timestamp())
        until_epoch = int(datetime.now(timezone.utc).timestamp())
        affected_aids = {m["account_id"] for m in matches}
        creator_by_cid: dict = {}
        for aid in affected_aids:
            try:
                acts = await fb_get_paginated(
                    f"{aid}/activities",
                    {
                        "since": str(since_epoch),
                        "until": str(until_epoch),
                        "fields": "actor_name,event_type,object_id,translated_event_type",
                        "limit": "500",
                    },
                )
            except HTTPException:
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

        text = _format_security_push_text(matches)
        for gid in cfg.get("group_ids") or []:
            try:
                await line_client.line_push(
                    _http_client,
                    gid,
                    [{"type": "text", "text": text}],
                    access_token=access_token,
                )
            except line_client.LinePushError as e:
                print(f"[security-push] push group={gid} failed: {e}", flush=True)
    finally:
        _current_fb_user_id.reset(ctx_token)


async def _security_push_tick() -> None:
    """Find due security_push_configs and process each. Mirrors the
    LIMIT 50 + FOR UPDATE SKIP LOCKED pattern from _scheduler_tick."""
    if _db_pool is None:
        return
    now = datetime.now(timezone.utc)
    async with _db_pool.acquire() as conn:
        async with conn.transaction():
            due = await conn.fetch(
                """
                SELECT * FROM security_push_configs
                WHERE enabled AND next_run_at <= $1
                ORDER BY next_run_at ASC
                LIMIT 50
                FOR UPDATE SKIP LOCKED
                """,
                now,
            )
    for row in due:
        cfg = dict(row)
        cid = cfg["id"]
        try:
            await _security_push_run_one(cfg)
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE security_push_configs
                    SET last_run_at = $2,
                        next_run_at = $2 + (poll_interval_minutes || ' minutes')::INTERVAL,
                        last_error = NULL,
                        fail_count = 0,
                        updated_at = $2
                    WHERE id = $1
                    """,
                    cid,
                    now,
                )
        except Exception as e:
            print(f"[security-push] config={cid} run failed: {e}", flush=True)
            async with _db_pool.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE security_push_configs
                    SET last_error = $2,
                        fail_count = fail_count + 1,
                        next_run_at = $3 + (poll_interval_minutes || ' minutes')::INTERVAL,
                        updated_at = $3,
                        enabled = CASE WHEN fail_count + 1 >= 5 THEN FALSE ELSE enabled END
                    WHERE id = $1
                    """,
                    cid,
                    str(e)[:500],
                    now,
                )


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
_WARM_MAX_PER_TICK = 5
_WARM_THROTTLE_BACKOFF_S = 600


async def _cache_warm_tick() -> None:
    now = time.monotonic()
    if _last_ads_throttle_at and (now - _last_ads_throttle_at) < _WARM_THROTTLE_BACKOFF_S:
        return

    # Pick up to _WARM_MAX_PER_TICK candidates: most-recently-accessed
    # entries that are entering the last _WARM_REFRESH_WINDOW_S of
    # their TTL. Older-than-_WARM_RECENT_ACCESS_S entries are dropped
    # from the warm set to prevent unbounded growth on accounts
    # nobody's looking at any more.
    WarmKey = tuple[str, str, str, Optional[str], str]
    candidates: list[tuple[float, WarmKey]] = []
    expired_targets: list[WarmKey] = []
    for key, last_seen in list(_warm_targets.items()):
        if (now - last_seen) > _WARM_RECENT_ACCESS_S:
            expired_targets.append(key)
            continue
        candidates.append((last_seen, key))
    for key in expired_targets:
        _warm_targets.pop(key, None)

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
        ctx_token = _current_fb_user_id.set(uid)
        try:
            if kind == "insights":
                await _fetch_account_insights(account_id, date_preset, time_range)
            elif kind == "campaigns":
                await _fetch_campaigns_for_account(
                    account_id, date_preset, time_range, include_archived=False, lite=False
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


# ── AI Chat (Gemini) ──────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str   # "user" | "model"
    text: str

class ChatRequest(BaseModel):
    messages: List[ChatMessage]
    context: Optional[str] = None  # ad data summary from frontend

# ── 成效優化中心 — 5-agent advisor board ─────────────────────────
#
# Each agent is a persona (system-prompt) borrowed from
# msitarzewski/agency-agents under the paid-media + marketing +
# support divisions. The persona body lives on disk under
# agent_personas/ so it can be edited without redeploying code.
# Loaded once at first /api/optimization/agents call into a module-
# level cache.

AGENT_META = [
    {
        "id": "social_strategist",
        "name_zh": "社群策略專家",
        "name_en": "Paid Social Strategist",
        "role_zh": "Meta 跨平台策略 / 漏斗結構 / Audience 工程",
        "emoji": "📱",
        "color": "#3b82f6",
    },
    {
        "id": "creative_strategist",
        "name_zh": "素材策略專家",
        "name_en": "Ad Creative Strategist",
        "role_zh": "Hook-Body-CTA / A/B 測試 / 素材疲勞偵測",
        "emoji": "✍️",
        "color": "#f59e0b",
    },
    {
        "id": "auditor",
        "name_zh": "稽核專家",
        "name_en": "Paid Media Auditor",
        "role_zh": "200+ checkpoint / Severity / 美金影響估算",
        "emoji": "📋",
        "color": "#a855f7",
    },
    {
        "id": "growth_hacker",
        "name_zh": "成長駭客",
        "name_en": "Growth Hacker",
        "role_zh": "漏斗 / LTV:CAC / A/B 實驗 / 病毒迴圈",
        "emoji": "🚀",
        "color": "#10b981",
    },
    {
        "id": "analytics_reporter",
        "name_zh": "數據分析師",
        "name_en": "Analytics Reporter",
        "role_zh": "KPI / 統計顯著性 / 預測模型 / 數據說故事",
        "emoji": "📊",
        "color": "#0891b2",
    },
    {
        "id": "agency_ceo",
        "name_zh": "代理商 CEO",
        "name_en": "Agency CEO",
        # role_zh kept for backwards-compat / Pricing page; the
        # 6-card grid intentionally hides the third row to make
        # the layout feel less crowded (per design feedback).
        "role_zh": "P&L / 客戶組合配置 / 風險與成長",
        "emoji": "👔",
        "color": "#475569",
    },
]


def _load_agent_prompts() -> dict:
    """Return the 5 persona system-prompts. Imported from the
    `agent_personas` Python module so the bytes are guaranteed to
    ship with the deploy artefact (the previous disk-read approach
    silently failed on Zeabur whenever the agent_personas/ folder
    didn't make it into the runtime image)."""
    from agent_personas import PERSONAS

    return PERSONAS


@app.get("/api/optimization/agents")
async def list_optimization_agents():
    """Return the 5 expert agents' display metadata (no system
    prompts — those are server-side only)."""
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
    frequency: float = 0
    msgs: int = 0
    msg_cost: float = 0


class RunAgentsRequest(BaseModel):
    """Single click on the 成效優化中心 「產生分析」 button.
    Counts as one quota use against `agent_advice_limit`."""

    fb_user_id: str
    date_label: str
    campaigns: List[CampaignDigest]


def _format_campaigns_for_prompt(campaigns: List[CampaignDigest]) -> str:
    """Render the campaigns as a markdown grouped by account so the
    agent can structure per-account analysis. Sort accounts by total
    spend desc, campaigns within each account by spend desc. Cap at
    60 rows total so the prompt stays under ~6KB while still
    covering the long-tail."""
    sorted_campaigns = sorted(campaigns, key=lambda c: c.spend, reverse=True)[:60]

    # Group by account_name. dict preserves insertion order, so the
    # account block order matches the spend ranking of the first
    # campaign we saw under that account.
    by_account: dict = {}
    for c in sorted_campaigns:
        key = c.account_name or "(未命名帳號)"
        by_account.setdefault(key, []).append(c)

    blocks: list = []
    for acct_name, rows in by_account.items():
        acct_spend = sum(r.spend for r in rows)
        acct_msgs = sum(r.msgs for r in rows)
        acct_imp = sum(r.impressions for r in rows)
        acct_avg_msg_cost = (acct_spend / acct_msgs) if acct_msgs > 0 else 0
        header = (
            f"### 帳號:{acct_name}\n"
            f"- 該帳號活動數: {len(rows)}\n"
            f"- 總花費: ${acct_spend:,.0f}  總曝光: {int(acct_imp):,}  "
            f"總私訊: {acct_msgs}  平均私訊成本: "
            f"{f'${acct_avg_msg_cost:.0f}' if acct_msgs > 0 else '-'}\n"
        )
        table_lines = [
            "| 活動 | 狀態 | 目標 | 花費 | CTR | CPC | 頻次 | 私訊 | 私訊成本 |",
            "|---|---|---|---|---|---|---|---|---|",
        ]
        for c in rows:
            table_lines.append(
                f"| {c.name} | {c.status or '-'} | {c.objective or '-'} "
                f"| ${c.spend:,.0f} | {c.ctr:.2f}% | ${c.cpc:.2f} "
                f"| {c.frequency:.2f} | {c.msgs} "
                f"| {f'${c.msg_cost:.0f}' if c.msgs > 0 else '-'} |"
            )
        blocks.append(header + "\n".join(table_lines))

    return "\n\n".join(blocks)


async def _call_one_agent(
    persona: str,
    table: str,
    date_label: str,
    n_campaigns: int,
) -> str:
    """Issue one Gemini POST with the persona as the system prompt.
    Caller wraps with asyncio.gather so all 5 agents run in
    parallel — each Gemini call is ~5-10s, total wall time stays
    near the slowest single agent."""
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
        "你正在審視一位廣告操盤手底下的多個 Facebook 廣告帳號。"
        "資料以「## 帳號 → ### 各帳號活動表」格式提供,你的任務是以你的專業角度,"
        "**逐個帳號**做出完整、具體、可執行的優化分析。"
        "全程使用繁體中文(專業術語 / 數字 / 活動代號可保留英文 / 數字)。\n\n"
        "# 回答結構(必須遵守)\n"
        "1. **整體診斷**:開頭 2-3 句的跨帳號重點觀察(例:哪個帳號花費過度集中、"
        "私訊成本兩極化、頻次失控等);用粗體 `**...**` 標重點。\n"
        "2. **分帳號建議**:接下來針對每個帳號開一個 `### 帳號:[帳號名]` 標題,"
        "底下寫 2-4 條條列式建議,每條格式 `- **建議標題**: 內容(點名具體活動)`,"
        "務必引用該帳號內**具體的活動名稱**(可截短)+ 關鍵指標數字(花費 / CPC / "
        "私訊成本 / CTR / 頻次)作佐證。\n"
        "3. **優先處理事項**:結尾用 `## 優先處理` 標題 + 1-3 條按重要性排序的待辦,"
        "格式 `1. [帳號] 動作`,告訴使用者今天就該做什麼。\n\n"
        "# 風格要求\n"
        "- 不要重複資料、不要寫 `根據資料表` 這種廢話開場\n"
        "- 直接點名帳號 + 活動 + 數字,具體到可執行\n"
        "- 每個建議要有 WHY(為什麼這樣建議)+ HOW(怎麼做)\n"
        "- 同一個帳號內如果有 5+ 個活動,可以分群分析(例:「私訊類活動 vs 流量類活動」)\n"
        "- 字數不限,但要有資訊密度;不要冗長重複"
    )
    user_prompt = (
        f"資料區間: {date_label}\n"
        f"進行中活動總數: {n_campaigns}\n"
        f"(下方資料按帳號分群,只顯示花費 Top {min(60, n_campaigns)} 個活動)\n\n"
        f"{table}"
    )
    # maxOutputTokens raised from 800 → 4096: 800 was being hit
    # mid-sentence (CJK uses ~2-3 tokens per character; 800 tokens
    # ≈ 250-400 zh chars max). 4096 gives ~1500 zh chars per agent
    # × 5 agents = ~7500 zh chars total — enough for proper
    # per-account analysis with concrete activity names + numbers,
    # without bloating into novel-length advice nobody reads.
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "generationConfig": {"temperature": 0.6, "maxOutputTokens": 4096},
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

    tasks = [
        _call_one_agent(prompts.get(meta["id"], ""), table, req.date_label, n)
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
            "version": 1,
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
                meta["id"], prompts.get(meta["id"], ""),
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




@app.post("/api/ai/chat")
async def ai_chat(req: ChatRequest):
    if not GEMINI_API_KEY:
        raise HTTPException(status_code=503, detail="Gemini API key not configured")

    system_prompt = """你是 LURE 廣告代理商的 AI 廣告顧問，專門分析 Facebook / Meta 廣告成效。
使用繁體中文回答。回答要簡潔、有洞察力、直接提供可執行的建議。
專業術語：CTR（點擊率）、CPC（每次點擊成本）、CPM（每千次曝光成本）、ROAS（廣告投資報酬率）、私訊轉換。"""

    if req.context:
        system_prompt += f"\n\n目前廣告數據摘要：\n{req.context}"

    contents = []
    for m in req.messages:
        contents.append({
            "role": m.role,
            "parts": [{"text": m.text}]
        })

    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 1024,
        }
    }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    try:
        r = await _http_client.post(
            url, json=payload,
            headers={"x-goog-api-key": GEMINI_API_KEY},
            timeout=_POST_TIMEOUT,
        )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="Gemini API timeout")
    except httpx.RequestError as e:
        raise HTTPException(status_code=502, detail=f"Cannot reach Gemini API: {e}")

    try:
        data = r.json()
    except Exception:
        raise HTTPException(status_code=502, detail=f"Gemini returned non-JSON (HTTP {r.status_code})")

    if "error" in data:
        raise HTTPException(status_code=400, detail=data["error"].get("message", "Gemini error"))

    candidates = data.get("candidates") or []
    if not candidates:
        raise HTTPException(status_code=502, detail="Gemini returned no candidates")
    text = (
        candidates[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        if isinstance(candidates[0], dict) else ""
    )
    if not text:
        raise HTTPException(status_code=502, detail="Gemini returned empty response")
    return {"reply": text}


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
