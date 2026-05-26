"""LINE Messaging API helper.

Thin wrapper around the `push` endpoint plus a webhook-signature
verifier. Kept deliberately small — all heavy lifting (scheduling,
persistence, report building) lives in main.py. This module only
knows how to shove a pre-built payload into LINE's HTTP API.

Multi-channel support (2026-04-30): callers pass `access_token`
explicitly so we can route different push configs to different LINE
Official Accounts. Webhook signature verification likewise takes
`secret` explicitly. Env-based defaults are gone — main.py is the
single source of truth for "which channel goes where".

Mock mode (``LINE_MOCK=1``) prints payloads to stdout instead of
calling the real API, so the full scheduler → push pipeline can be
exercised locally without a channel token.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from datetime import datetime
from typing import Any, List, Optional
from zoneinfo import ZoneInfo

import httpx

LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push"
LINE_GROUP_SUMMARY_URL = "https://api.line.me/v2/bot/group/{group_id}/summary"
LINE_QUOTA_URL = "https://api.line.me/v2/bot/message/quota"
LINE_QUOTA_CONSUMPTION_URL = "https://api.line.me/v2/bot/message/quota/consumption"
LINE_BOT_INFO_URL = "https://api.line.me/v2/bot/info"


def _mock_enabled() -> bool:
    return os.getenv("LINE_MOCK", "0") == "1"


class LinePushError(RuntimeError):
    """Raised when LINE returns a non-2xx response."""

    def __init__(self, status: int, detail: str):
        super().__init__(f"LINE push failed: {status} {detail}")
        self.status = status
        self.detail = detail
        self.friendly_message = _translate_line_error(status, detail)


def _translate_line_error(status: int, detail: str) -> str:
    """Map LINE's API error responses to actionable zh-TW operator
    messages. The raw text from LINE is in English and operators have
    been confused by 「monthly limit」 (which is LINE's quota, not
    LURE's tier limit). Falls back to the raw detail when we don't
    recognise the shape."""
    text = (detail or "").lower()
    if status == 429 and "monthly limit" in text:
        return (
            "LINE 官方帳號本月推播額度已用完。"
            "提醒:LINE 計費規則是「推到 N 人群組計 N 則」,"
            "並非 1 次推播 = 1 則。"
            "請至 LINE Official Account Manager (manager.line.biz) "
            "升級「中用量」(NT$800/月,5,000 則)以上方案,或等下月 1 日重置。"
            "此額度由 LINE 計算,與 LURE 方案無關。"
        )
    if status == 429:
        return f"LINE 已限流(請稍後再試):{detail}"
    if status == 401:
        return f"LINE channel access token 失效或不正確:{detail}"
    if status == 403:
        return (
            "LINE channel 對該群組沒有推播權限,可能是 bot 已被踢出群組:"
            f"{detail}"
        )
    if status == 400 and ("invalid" in text or "missing" in text):
        return f"LINE 訊息格式錯誤(請聯絡技術人員):{detail}"
    return f"LINE 推播失敗({status}):{detail}"


async def line_push(
    client: httpx.AsyncClient,
    group_id: str,
    messages: List[dict],
    *,
    access_token: str,
) -> None:
    """Push `messages` (1-5 Message objects) to a LINE group.

    `client` is the shared `_http_client` owned by main.py's lifespan
    so we reuse connection pooling and timeouts. `access_token` is the
    channel-specific bot token; main.py looks it up from `line_channels`
    via the group's `channel_id` before calling.
    """
    if _mock_enabled():
        preview = json.dumps(messages, ensure_ascii=False)[:400]
        print(f"[line_push] mock group={group_id} msgs={preview}", flush=True)
        return

    if not access_token:
        raise LinePushError(0, "LINE channel access_token is empty")

    resp = await client.post(
        LINE_PUSH_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        json={"to": group_id, "messages": messages},
        timeout=15,
    )
    if resp.status_code >= 300:
        try:
            body = resp.json()
            top = body.get("message") or ""
            details = body.get("details") or []
            detail_strs = [
                f"{(d.get('property') or '?')}: {(d.get('message') or '')}"
                for d in details
                if isinstance(d, dict)
            ]
            if detail_strs:
                detail = f"{top} | {' ; '.join(detail_strs)}"
            else:
                detail = top or json.dumps(body, ensure_ascii=False)
        except Exception:
            detail = resp.text[:600]
        print(f"[line_push] {resp.status_code} {detail}", flush=True)
        raise LinePushError(resp.status_code, detail)


async def get_bot_info(
    client: httpx.AsyncClient,
    *,
    access_token: str,
) -> Optional[dict]:
    """Fetch LINE bot account info — primarily used to sync the OA's
    `displayName` back to our `line_channels.name` column when the
    operator renames the OA in LINE Official Account Manager.

    Returns the LINE response dict (`{userId, basicId, displayName,
    pictureUrl, ...}`) on success, or None when the call fails / the
    token is missing. Failures are intentionally swallowed — callers
    are typically batching across many channels and one bad token
    shouldn't blow up the whole refresh."""
    if _mock_enabled():
        return {"userId": "U_MOCK", "displayName": "MOCK BOT"}
    if not access_token:
        return None
    try:
        resp = await client.get(
            LINE_BOT_INFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    try:
        return resp.json()
    except Exception:
        return None


async def get_quota(
    client: httpx.AsyncClient,
    *,
    access_token: str,
) -> dict:
    """Fetch the LINE Official Account's monthly push quota plus the
    real-time consumption count. Surfaces what the LINE Manager
    overview-page numbers refresh to "the next morning"  immediately,
    so operators can see actual usage instead of a 24-hour-stale
    snapshot.

    LINE message counting gotcha: a push to a group with N members
    counts as N separate messages, not 1. The「used」 figure here
    reflects that, which is usually MUCH higher than what operators
    intuitively expect from「我推了幾則」.

    Returns:
        {
          "type": "limited" | "none",  # "none" means unlimited (paid plan with no cap)
          "limit": int | None,           # null when type == "none"
          "used": int,                    # this month so far
          "remaining": int | None,        # null when type == "none"
        }

    Raises LinePushError on non-2xx so caller can route through the
    same friendly_message machinery as line_push().
    """
    if _mock_enabled():
        return {"type": "limited", "limit": 200, "used": 0, "remaining": 200}
    if not access_token:
        raise LinePushError(0, "LINE channel access_token is empty")

    headers = {"Authorization": f"Bearer {access_token}"}
    quota_resp = await client.get(LINE_QUOTA_URL, headers=headers, timeout=10)
    if quota_resp.status_code >= 300:
        raise LinePushError(quota_resp.status_code, quota_resp.text[:300])
    consumption_resp = await client.get(
        LINE_QUOTA_CONSUMPTION_URL, headers=headers, timeout=10
    )
    if consumption_resp.status_code >= 300:
        raise LinePushError(consumption_resp.status_code, consumption_resp.text[:300])

    quota = quota_resp.json() or {}
    consumption = consumption_resp.json() or {}
    plan_type = str(quota.get("type") or "limited")
    raw_limit = quota.get("value")
    try:
        limit = int(raw_limit) if raw_limit is not None and plan_type != "none" else None
    except (TypeError, ValueError):
        limit = None
    try:
        used = int(consumption.get("totalUsage") or 0)
    except (TypeError, ValueError):
        used = 0
    remaining = (limit - used) if limit is not None else None
    return {"type": plan_type, "limit": limit, "used": used, "remaining": remaining}


async def get_group_summary(
    client: httpx.AsyncClient,
    group_id: str,
    *,
    access_token: str,
) -> Optional[dict]:
    """Fetch a group's display name + picture URL from LINE.

    Returns ``{"groupId", "groupName", "pictureUrl"}`` on success,
    or ``None`` if the bot has no permission / group is gone / token
    is empty. Errors are logged but never raised — the caller treats
    a missing summary as "name unknown" and keeps going.
    """
    if _mock_enabled():
        return {"groupId": group_id, "groupName": f"Mock Group {group_id[:6]}", "pictureUrl": ""}

    if not access_token:
        return None

    try:
        resp = await client.get(
            LINE_GROUP_SUMMARY_URL.format(group_id=group_id),
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
        if resp.status_code >= 300:
            return None
        body = resp.json()
        if not isinstance(body, dict):
            return None
        return body
    except Exception:
        return None


def verify_webhook_signature(body: bytes, signature: Optional[str], *, secret: str) -> bool:
    """Verify `X-Line-Signature` header against the raw request body.

    LINE docs: sign = base64(hmac-sha256(channelSecret, body)). A
    missing secret OR header is treated as invalid.
    """
    if not secret or not signature:
        return False
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    expected = base64.b64encode(digest).decode("ascii")
    return hmac.compare_digest(expected, signature)


def build_flex_report(
    *,
    title: str,
    subtitle: str,
    kpis: list[tuple[str, str]],
    objective_label: str = "",
    status_label: str = "",
    status_color: str = "#888888",
    recommendations: Optional[List[str]] = None,
    report_url: Optional[str] = None,
    alt_text: Optional[str] = None,
) -> dict:
    """Build a LINE Flex Message bubble for a campaign report.

    Layout (everything left-aligned for visual consistency):
        Header (orange — slim, two lines only)
            {title}                       (campaign nickname or name)
            {subtitle}                    (e.g. "報告區間: 4/1 - 4/25")

        Body (white)
            [{status_label}]              (solid colored pill, top-left)
            目標 · {objective}             (small grey label, when set)
            ─── separator ───
            {kpi_rows}                    (花費 / 曝光 / ... ;both columns left-aligned)
            ─── separator ───             (only if recommendations is non-empty)
            優化建議                       (orange section title, only if any)
            • {bullet}                    (one row per recommendation)

        Footer (white)              (only if report_url is provided)
            [ 查看完整報告 ]         (primary button → uri action)
    """
    alt = alt_text or f"{title}（{subtitle}）"

    kpi_rows: list[dict[str, Any]] = []
    for label, value in kpis:
        kpi_rows.append(
            {
                "type": "box",
                "layout": "horizontal",
                "contents": [
                    {
                        "type": "text",
                        "text": label,
                        "size": "sm",
                        "color": "#888888",
                        "flex": 3,
                    },
                    {
                        "type": "text",
                        "text": value,
                        "size": "sm",
                        "color": "#1A1A1A",
                        "weight": "bold",
                        "flex": 4,
                        "wrap": True,
                    },
                ],
                "margin": "sm",
            }
        )

    suggestion_rows: list[dict[str, Any]] = []
    if recommendations:
        suggestion_rows.append(
            {"type": "separator", "margin": "lg", "color": "#F0F0F0"},
        )
        suggestion_rows.append(
            {
                "type": "text",
                "text": "優化建議",
                "size": "sm",
                "color": "#FF6B2C",
                "weight": "bold",
                "margin": "lg",
            }
        )
        for rec in recommendations:
            suggestion_rows.append(
                {
                    "type": "box",
                    "layout": "horizontal",
                    "margin": "sm",
                    "contents": [
                        {
                            "type": "text",
                            "text": "•",
                            "size": "sm",
                            "color": "#FF6B2C",
                            "flex": 0,
                        },
                        {
                            "type": "text",
                            "text": rec,
                            "size": "sm",
                            "color": "#1A1A1A",
                            "wrap": True,
                            "margin": "sm",
                            "flex": 1,
                        },
                    ],
                }
            )

    # Header — slimmed to two lines (title + subtitle) at user request,
    # so the orange band doesn't dominate. Chip + objective moved down
    # into the white body where they read as data-context, not branding.
    header_contents: list[dict[str, Any]] = [
        {
            "type": "text",
            "text": title,
            "size": "lg",
            "color": "#FFFFFF",
            "weight": "bold",
            "wrap": True,
        },
        {
            "type": "text",
            "text": subtitle,
            "size": "lg",
            "color": "#FFE8D9",
            "weight": "bold",
            "margin": "xs",
            "wrap": True,
        },
    ]

    # Body meta row — status chip (solid colored bg + white text so it
    # still reads as a badge against the white body) followed by an
    # optional small grey "目標 · X" label.
    body_meta: list[dict[str, Any]] = []
    if status_label:
        body_meta.append(
            {
                "type": "box",
                "layout": "horizontal",
                "contents": [
                    {
                        "type": "box",
                        "layout": "vertical",
                        "flex": 0,
                        "cornerRadius": "md",
                        "backgroundColor": status_color,
                        "paddingAll": "xs",
                        "contents": [
                            {
                                "type": "text",
                                "text": status_label,
                                "size": "xs",
                                "weight": "bold",
                                "color": "#FFFFFF",
                            }
                        ],
                    },
                    {"type": "filler"},
                ],
            }
        )
    if objective_label:
        body_meta.append(
            {
                "type": "text",
                "text": f"目標 · {objective_label}",
                "size": "xs",
                "color": "#888888",
                "margin": "sm" if status_label else "none",
            }
        )
    if body_meta:
        body_meta.append({"type": "separator", "margin": "lg", "color": "#F0F0F0"})

    bubble: dict[str, Any] = {
        "type": "bubble",
        "size": "mega",
        "header": {
            "type": "box",
            "layout": "vertical",
            "backgroundColor": "#FF6B2C",
            "paddingAll": "16px",
            "contents": header_contents,
        },
        "body": {
            "type": "box",
            "layout": "vertical",
            "spacing": "sm",
            "paddingAll": "16px",
            "contents": [
                *body_meta,
                *kpi_rows,
                *suggestion_rows,
            ],
        },
    }

    if report_url:
        bubble["footer"] = {
            "type": "box",
            "layout": "vertical",
            "spacing": "sm",
            "paddingAll": "12px",
            "contents": [
                {
                    "type": "button",
                    "style": "primary",
                    "color": "#FF6B2C",
                    "height": "sm",
                    "action": {
                        "type": "uri",
                        "label": "查看完整報告",
                        "uri": report_url,
                    },
                },
            ],
        }

    return {"type": "flex", "altText": alt[:400], "contents": bubble}


# ── 安全監控 alert flex ─────────────────────────────────────────


_SEC_ANOMALY_LABELS = {
    "deep_night": "深夜創建",
    "weekend": "週末創建",
    "high_budget": "日預算 > $2000",
    "burst": "短時間高頻",
    "abnormal_language": "異常語言",
}
# Time-based signals (orange) vs financial/security signals (red).
_SEC_ANOMALY_COLORS = {
    "deep_night": "#FF6B2C",
    "weekend": "#FF6B2C",
    "high_budget": "#DC2626",
    "burst": "#DC2626",
    "abnormal_language": "#DC2626",
}

# Plain status → (label, chip color).
_SEC_STATUS_DISPLAY = {
    "ACTIVE": ("進行中", "#16A34A"),
    "PAUSED": ("已暫停", "#DC2626"),
    "ARCHIVED": ("已封存", "#888888"),
    "DELETED": ("已刪除", "#888888"),
}


def _sec_pill(text: str, color: str) -> dict:
    return {
        "type": "box",
        "layout": "vertical",
        "flex": 0,
        "cornerRadius": "md",
        "backgroundColor": color,
        "paddingStart": "sm",
        "paddingEnd": "sm",
        "paddingTop": "xs",
        "paddingBottom": "xs",
        "contents": [
            {
                "type": "text",
                "text": text,
                "size": "xxs",
                "weight": "bold",
                "color": "#FFFFFF",
            }
        ],
    }


def _sec_kpi_row(label: str, value: str) -> dict:
    return {
        "type": "box",
        "layout": "horizontal",
        "spacing": "sm",
        "contents": [
            {
                "type": "text",
                "text": label,
                "size": "sm",
                "color": "#888888",
                "flex": 2,
            },
            {
                "type": "text",
                "text": value or "—",
                "size": "sm",
                "color": "#1A1A1A",
                "weight": "bold",
                "flex": 5,
                "wrap": True,
            },
        ],
    }


def _sec_fmt_money(raw) -> str:
    """Render raw FB-stored daily_budget (TWD-style, NOT cents) as
    `$1,503,500`. Returns "—" when missing / zero."""
    if raw is None:
        return "—"
    try:
        n = int(raw)
    except (TypeError, ValueError):
        try:
            n = int(float(raw))
        except (TypeError, ValueError):
            return "—"
    if n <= 0:
        return "—"
    return f"${n:,}"


def _sec_fmt_local_time(iso: str, tz_name: str = "Asia/Taipei") -> str:
    """Parse FB ISO timestamp and render as `05/23 12:34` in the
    operator's timezone."""
    if not iso:
        return "—"
    try:
        s = iso
        # Python 3.9 doesn't accept "+0000" suffix in fromisoformat —
        # normalise to "+00:00".
        if len(s) >= 5 and s[-5] in ("+", "-") and s[-3] != ":":
            s = s[:-2] + ":" + s[-2:]
        dt = datetime.fromisoformat(s)
        try:
            local = dt.astimezone(ZoneInfo(tz_name))
        except Exception:
            local = dt
        return local.strftime("%m/%d %H:%M")
    except (TypeError, ValueError):
        return "—"


def build_security_alert_flex(
    matches: List[dict],
    *,
    tz_name: str = "Asia/Taipei",
    view_url: str | None = None,
) -> dict:
    """Build a LINE Flex carousel for 安全監控 anomaly alerts.

    Each bubble = one flagged campaign:
        Header (orange — 🚨 Meta後台系統警示!! / 新建立廣告異常回報)
        Body:
            campaign name (bold, large)
            row of status pill + anomaly pills
            KPI rows: 帳戶 / 建立時間 / 已花費 / 編號

    Matches list shape (mirrors what `_format_security_push_text`
    consumed): each dict has `campaign` (FB-shape dict with id, name,
    status, daily_budget, created_time), `account_name`, `anomalies`,
    `creator`.

    Carousel cap is 10 (LINE allows 12, leave headroom). Caller is
    responsible for sorting matches in priority order before passing in.
    """
    if not matches:
        # Empty alert shouldn't happen but return a stub so caller
        # doesn't crash trying to push.
        return {
            "type": "flex",
            "altText": "Meta後台系統警示(無內容)",
            "contents": {
                "type": "bubble",
                "size": "kilo",
                "body": {
                    "type": "box",
                    "layout": "vertical",
                    "contents": [
                        {"type": "text", "text": "無內容", "size": "sm"}
                    ],
                },
            },
        }

    bubbles: list[dict] = []
    total = len(matches)
    for idx, m in enumerate(matches[:10], 1):
        c = m.get("campaign") or {}
        status = (c.get("status") or "").upper()
        status_label, status_color = _SEC_STATUS_DISPLAY.get(status, (status or "—", "#888888"))

        # Header — same title across the carousel so swiping keeps the
        # brand consistent. `idx / total` lets the recipient know how
        # many alerts in this batch.
        position_chip = f"{idx} / {min(total, 10)}" if total > 1 else ""
        header_contents: list[dict] = [
            {
                "type": "text",
                "text": "🚨 Meta後台系統警示!!",
                "size": "lg",
                "color": "#FFFFFF",
                "weight": "bold",
                "wrap": True,
            },
            {
                "type": "text",
                "text": "新建立廣告異常回報",
                "size": "md",
                "color": "#FFE8D9",
                "weight": "bold",
                "margin": "xs",
            },
        ]
        if position_chip:
            header_contents.append(
                {
                    "type": "text",
                    "text": position_chip,
                    "size": "xs",
                    "color": "#FFE8D9",
                    "margin": "sm",
                }
            )

        # Status + anomaly pills row.
        pills: list[dict] = [_sec_pill(status_label, status_color)]
        for tag in m.get("anomalies") or []:
            label = _SEC_ANOMALY_LABELS.get(tag, tag)
            color = _SEC_ANOMALY_COLORS.get(tag, "#FF6B2C")
            pills.append(_sec_pill(label, color))
        # filler pushes pills to the left and lets them wrap naturally
        pills_row = {
            "type": "box",
            "layout": "horizontal",
            "spacing": "xs",
            "contents": [*pills, {"type": "filler"}],
        }

        name = c.get("name") or "(未命名)"
        cid = c.get("id") or "—"
        created_local = _sec_fmt_local_time(c.get("created_time") or "", tz_name=tz_name)
        account_name = (m.get("account_name") or "").strip() or "—"

        body_contents: list[dict] = [
            {
                "type": "text",
                "text": name,
                "size": "md",
                "weight": "bold",
                "color": "#1A1A1A",
                "wrap": True,
            },
            pills_row,
            {"type": "separator", "margin": "md", "color": "#F0F0F0"},
            _sec_kpi_row("帳戶", account_name),
            _sec_kpi_row("建立時間", created_local),
        ]
        spend = m.get("spend")
        if spend is not None:
            spend_val = _sec_fmt_money(spend)
            range_label = (m.get("spend_range_label") or "").strip()
            # Append the date-range hint inline so recipients know which
            # window the spend covers (matches the DatePicker on /security).
            if range_label and spend_val != "—":
                spend_val = f"{spend_val}({range_label})"
            body_contents.append(_sec_kpi_row("已花費", spend_val))
        body_contents.append(_sec_kpi_row("編號", cid))

        bubble = {
            "type": "bubble",
            "size": "mega",
            "header": {
                "type": "box",
                "layout": "vertical",
                "backgroundColor": "#FF6B2C",
                "paddingAll": "16px",
                "contents": header_contents,
            },
            "body": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "paddingAll": "16px",
                "contents": body_contents,
            },
        }
        bubbles.append(bubble)

    if len(bubbles) == 1:
        contents: dict = bubbles[0]
    else:
        contents = {"type": "carousel", "contents": bubbles}

    extra = ""
    if total > 10:
        extra = f"(+ 另有 {total - 10} 則)"
    alt = f"Meta後台系統警示 — 新建立廣告異常回報,共 {total} 則{extra}"[:400]
    return {"type": "flex", "altText": alt, "contents": contents}
