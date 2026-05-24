# Project Memory — LURE Meta Platform

## Branding

- Product name: **LURE META PLATFORM**
- GitHub repo: https://github.com/jason121380/meta-board
- Design: Orange (#FF6B2C) system, matches Google-My-Business repo style
- Font: Noto Sans TC

## FB App

- App ID: `2780372365654462` (hardcoded in `frontend/src/auth/FbAuthProvider.tsx`)
- API Version: `v21.0`
- Token type: Long-lived user token (60 days), stored in `.env` as fallback
- Runtime token: stored in `_runtime_token` (set via FB Login, overrides .env)
- Requested scopes (from `FB_SCOPES` in FbAuthProvider.tsx):
  - `ads_read`, `ads_management` — read campaigns / insights / creatives, toggle status, edit budget
  - `business_management` — read the `business` field on `/me/adaccounts` (needed for Ads Manager deep-link URLs)
  - `pages_read_engagement` — **added 2026-04-15**. Optional; grants read access to page post content (`full_picture`, `attachments.media.source`). See the "Page post scope behavior matrix" below for what it does to `/api/posts/{id}/media` and `/api/pages/{id}/info`.

### Page post scope behavior matrix

| Who is logging in | FB grants the scope? | `/api/posts/{id}/media` works? | Result in CreativePreviewModal |
|---|---|---|---|
| App admin / dev / tester (app role assigned in FB dev portal) | **Yes** — dev mode grants unreviewed scopes to app roles | Yes — returns real post `full_picture` / video source | Sharp post image / playable video in the preview modal |
| Regular production user (no app role), before FB App Review | No — FB silently drops unreviewed scopes | No — returns `{image_url: null, error: "..."}` | Falls back to the 600px hires creative thumbnail, then to text-only fallback with "view original post" CTA |
| Regular production user, after FB App Review | Yes | Yes | Sharp post media |

This means the scope is **safe to request even without review** — FB's behavior is to drop unknown/unreviewed scopes silently during login, not to fail. The app's existing fallback chain keeps working.

## Ad Accounts

- Jason has 80+ ad accounts across multiple Business Managers
- All loaded via paginated `/me/adaccounts` endpoint
- Settings page: check accounts to show in dashboard left panel
- Dashboard left panel: click account to toggle into active view
- Two separate localStorage keys:
  - `fb_selected_accounts` = accounts enabled in settings
  - `fb_active_accounts` = accounts currently selected in dashboard

## Architecture

- **Backend**: FastAPI (Python 3.9+), port 8001
- **Frontend**: React 18 + Vite + TypeScript (`frontend/`), built to `dist/`
- **Auth**: FB JS SDK (browser) → `POST /api/auth/token` → `_runtime_token` in memory
- **Charts**: Chart.js 4.4.0 + chartjs-plugin-datalabels 2.2.0 (tree-shaken imports, not CDN)
- **AI**: Google Gemini API via `/api/ai/chat` endpoint
- **Storage (2026-04-17 PG cutover)**: PostgreSQL via `asyncpg` + `DATABASE_URL`. Three tables auto-created on startup:
  - `campaign_nicknames` — per-campaign store/designer nicknames, shared team-wide
  - `user_settings(fb_user_id, key, value JSONB)` — per-user: `selected_accounts`, `account_order`
  - `shared_settings(key, value JSONB)` — team-wide: `finance_row_markups`, `finance_pinned_ids`, `finance_default_markup`, `finance_show_nicknames`
  localStorage now only holds **ephemeral UI state**: `fb_active_accounts`, date-picker prefs, sidebar collapse, FB token cache. `SettingsProvider` is the hydration gate — fires two GETs in parallel at login, gates the router on success.

## LINE Push Scheduler (latest: 2026-04-29)

- **Entry point** is the `/line-push` settings page (sidebar 工具區). The
  per-campaign push button on the dashboard tree was **removed
  2026-04-29** — all configuration now happens here. Topbar has a
  refresh icon that re-fetches groups + configs and toasts on success.
- Group discovery is **auto-webhook**: LINE bot `join` →
  `/api/line/webhook` upserts `line_groups`; `leave` → sets `left_at`.
  Users just invite the LINE Official Account into a group and it
  shows up in the table. Lifespan startup also runs a one-shot
  backfill for legacy rows whose `group_name` is empty.
- **GroupPushConfigModal** (one group, one campaign per row, one row
  per frequency) — searchable comboboxes for both account and campaign;
  the campaign combobox shows a status badge (進行中 / 已暫停 / 已封存)
  on each item so you can avoid binding to a paused campaign.
- **Per-config toggles** (both default OFF — opt-in):
  - `include_report_button` → footer「查看完整報告」button linking to `/r/:campaignId`
  - `include_recommendations` → render the 優化建議 bullet list in the body
- **Default values for new configs**: `weekly` enabled, weekdays = 週五,
  hour = 09:00, date_range = `month_to_yesterday` (本月1日-昨日),
  reportFields = [spend_plus, msgs, msg_cost], button + recommendations off.
- Message format is **LINE Flex Message** (orange header + KPI grid).
  Builder lives in `line_client.build_flex_report`; backend assembles
  the per-campaign KPI rows in `_build_flex_for_config` (main.py) by
  reusing `_fetch_campaigns_for_account`.
  - Header right side has a **status chip** (`build_flex_report`
    `status_label` + `status_color`): green `#16A34A`「進行中」for
    ACTIVE; red `#DC2626`「M/D 已暫停」for PAUSED (M/D parsed from
    `updated_time`); grey `#888888` for ARCHIVED / DELETED.
    Implemented as a horizontal title row with `flex:1` title +
    `flex:0, gravity:top, height:22px` chip so it doesn't stretch
    when the title wraps to two lines.
- Recurrence: `daily` / `weekly (weekdays[], 0=Sun..6=Sat)` /
  `biweekly` / `monthly (month_day 1..28)` + HH:MM. All times
  interpreted as `SCHEDULER_TZ` (default Asia/Taipei) and converted
  to UTC for `next_run_at` storage. Helper: `main._compute_next_run()`.
- Scheduler: single asyncio background task started in `lifespan`
  ticking every 60s. `_scheduler_tick()` selects
  `enabled AND next_run_at <= NOW()` rows, pushes Flex, advances `next_run_at`.
- Failure policy: fail_count ≥ 3 → `enabled=false` (auto-disable).
  Every attempt is logged in `line_push_logs`.
- Assumptions: **single uvicorn worker** (no advisory lock yet).
  If worker count ever goes > 1, switch the SELECT to `FOR UPDATE SKIP LOCKED`.
- Env vars: `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`,
  `LINE_MOCK=1` (local dev), `SCHEDULER_TZ`.
- Webhook public URL (Zeabur): `https://{your-zeabur-domain}/api/line/webhook` — register this on the LINE Developers Console.

## 安全監控 (Security Monitor, latest: 2026-05-24)

新功能,左側選單第 4 項。以「日」分組列出新建立的廣告活動,讓營運可以
掃描有沒有可疑活動,並訂閱 LINE 推播在新異常活動出現時主動通知。

### View 結構
- 預設過去 7 天(獨立 local date,不污染 `filtersStore.date`)
- 上方 tabs:`待查看` / `已標記安全`(team-wide,寫
  `shared_settings.security_safe_campaigns`)
- 卡片:狀態 / 名稱 / 新建立 baseline badge + 異常 badges(深夜創建、
  週末創建、burst、日預算 > $2000)/ 編號 / 帳戶 / 目標 / 建立時間 /
  建立者 / 日預算 / 已花費 / 右側「標記為沒問題」+「編輯紀錄」展開
- 「編輯紀錄」展開:`/api/accounts/{id}/activities` 的 FB Activity Log,
  `summariseExtraData()` 翻譯 extra_data 成人話。`待查看` tab 預設展開
- 建立者:view 層 `useQueries` 對每帳戶 eager prefetch activities,過濾
  `event_type.includes("create")` OR `translated_event_type.includes("建立")`,
  按 object_id 對應 campaign.id

### 異常偵測(`securityData.ts` 純函式 + Python `_evaluate_campaign_anomalies`)
- deep_night: 建立時間 hour < 6
- weekend: 建立日為週六/週日
- burst: 同帳戶 2 小時內 ≥ 5 個活動(僅前端計算,Python 端不算)
- high_budget: `effectiveDailyBudget(c) > 2000`(raw FB value,**不除 100**,
  跟儀表板 fM() 同 scale)。CBO 模式取 campaign.daily_budget,ABO 模式
  加總 ACTIVE 廣告組合的 daily_budget

### LINE 推播 (`security_push_configs`)
- PG 表 + B 路線(獨立設定頁,從安全監控 topbar「推播設定」按鈕開
  Modal)+ C 路線(只在異常觸發 push)
- `_security_push_tick` 接進現有 `_scheduler_loop`(每 60s 跑一次)
- 每筆 config 自帶 `poll_interval_minutes`(預設 10),到期就抓擁有者
  的 selected_accounts 裡所有 campaigns,過濾 `created_time > last_run_at`
  + 命中 `anomaly_filters` 任一項,組裝 text 訊息推給每個 group_id
- 5 連續失敗自動 `enabled=false`

### 已知限制
- 「非 BM 成員」自動偵測曾經做過(`/api/accounts/{id}/assigned-users` +
  `business_users` + `assigned_users` + 舊 `users`),但 FB API 對非完全
  BM-managed 帳戶回空集合,實務上抓不到名單。已移除。
- LINE push 目前只發 text(plain),沒做 flex 卡片。前端 modal 也沒有
  「測試發送」按鈕(可以後續加)。

## Layout

- Left sidebar: 220px fixed, flex-column, user avatar at bottom (no border/hover/arrow, dropdown opens upward)
- Dashboard view: account list 240px | stats + 3-level tree table
- 關注名單 view: account list 240px (dash-acct-item style) | 3 side-by-side alert cards
- Finance view: account list 160px | toolbar + campaign table
- Settings view: split into 廣告帳號設定 (`/settings`) + LINE 推播設定 (`/line-push`)
- Topbar: 60px, contains date picker + view-specific controls

## Views Renamed

- "AI警示建議" → **關注名單** (as of 2026-04-12)

## Private Message Counting (Critical)

- Use `onsite_conversion.messaging_conversation_started_7d` OR `messaging_conversation_started_7d`
- Use first-found logic (stop at first match) to avoid double counting
- **Never** use `onsite_conversion.total_messaging_connection` — it counts total connections, not conversations started, and inflates numbers
- `getMsgCount(c)` is a **global function** defined at module level in dashboard.html — never redefine it locally inside a function

## Private Message Cost (Critical)

- `avgCostPerMsg = msgSpend / totalMsg`
- `msgSpend` = sum of spend from campaigns that HAVE message data (getMsgCount > 0)
- Do NOT use total account spend as denominator — it inflates cost

## Alert Cards (關注名單)

Three side-by-side cards, each with its own column set and sort state:
- **私訊成本過高**: 行銷活動, 花費, 私訊數, 私訊成本 + checkbox「隱藏標題含流量」
- **CPC過高**: 行銷活動, CPC + checkbox「隱藏標題含私訊」
- **頻次過高**: 行銷活動, 頻次

Module-level state: `_alertRows`, `_alertSort`, `_alertCols`, `_alertFilter`
DOM IDs: `alert-thead-{msg|cpc|freq}`, `alert-tbody-{msg|cpc|freq}`
Sorting: `alertSortBy(cardKey, colLabel)` — click header to sort, click again to reverse

## Finance Table

Columns (when single account selected / campaign drill-down mode):
`No. | 狀態 | 行銷活動名稱 | 花費 | 月% | 花費+% | Pin`

- 花費 is left-aligned (no `class="num"`)
- 狀態 shows coloured badges: 進行中 (green), 暫停 (gray), 已封存 (light gray), 已刪除 (red)
- KPI row (總花費/總花費+%) removed from Finance view as of 2026-04-12

## Checkbox Style

All checkboxes must use `class="custom-cb"` — never use `accent-color` inline style.
CSS: `.custom-cb:checked` = orange bg, white checkmark via `::after` pseudo-element.

## CTR Distribution Chart

Excludes 0% bucket — only shows campaigns with CTR > 0.

## Dashboard Account Panel

- No search box (removed 2026-04-12)
- No account count label (removed 2026-04-12)

## Server

- Port: `8001`
- Python 3.9 — use `Optional[str]` not `str | None`

## GitHub

- Repo: https://github.com/jason121380/meta-board
- Branch: `main`
- `.env` excluded from git (`.gitignore`)

## Known Issues / Notes

- `business` field on ad accounts: needs `business_management` in token scope
- Personal ad accounts (not in any Business Manager) will never return a business field
- 3rd level ads (adset → ads): loading works when server is running latest code; ensure server is restarted after deploy
- `getMsgCount` must be global — if defined locally inside a function, other module-level helpers (`_alertRowCtx`) will throw ReferenceError and alert cards will be blank

## 2026-04-14 — 3rd-level thumbnail + preview + compact pass

Batch of UX fixes landed on branch `claude/read-all-files-Aj5R8`:

### `escHtml()` in React JSX is a trap (commit `9a9e81b`)
- Legacy `dashboard.html` wraps FB thumbnail URLs in `escHtml()` and injects via `innerHTML`. The browser re-parses `&amp;` back to `&` so the URL is valid.
- React JSX `src={...}` is an attribute binding — React writes the value verbatim, so `&amp;` stays `&amp;` and every `&` in FB's signed CDN URL gets mangled → signature mismatch → FB 403 → broken thumbnail icons.
- Fix: pass raw `thumbnail_url` directly in React. Inline comment in `CreativeRow.tsx` warns the next person porting from innerHTML.

### 3rd-level ad creative preview modal (commit `1175a0f`)
- Clicking a `CreativeRow` opens a Radix Dialog showing the thumbnail enlarged, plus creative title / body text if FB returned them.
- Toggle cell already stops propagation so ACTIVE/PAUSED toggling does not open the modal.

### Larger thumbnails from FB (commit `b8c3354`)
- FB default `thumbnail_url` is ~64×64 which was too blurry in the 520px modal.
- `main.py:get_ads` now passes `thumbnail_width=600` and `thumbnail_height=600` when requesting the creative field. FB honors these on the AdCreative edge and returns the nearest CDN size (400–600 typically). Backend cache key already includes sorted params so it busts cleanly.

### Compact rows + mobile UX polish (commits `40b758c`, `7a8493d`)
- Finance table rows dropped from 52px to 30px: removed `py-2` from every body `<td>`, shrunk pin button from `h-9 w-9` to `h-[30px] w-[30px]`. Matches the dashboard tree compactness.
- Mobile `table.tree` padding reduced from `10px 8px` to `6px 6px` (header `8px 6px`). Combined with the new `.badge { white-space: nowrap }`, mobile tree rows collapsed from ~70px (badge wrapping "進 行 中" into 3 vertical chars) to ~32px.
- `Modal` component always renders a tappable X close button in the top-right. Title/subtitle get `pr-10` so they never overlap the X. Mobile users can't hit Esc easily and backdrop-tap isn't obvious.
- `MobileAccountPicker` got an autofocused search input at the top so 80+ account lists are usable. Search state resets on every open; "全部帳戶" is suppressed while the user is typing. Rows dropped from `min-h-[48px]` to `min-h-[44px]`, lost the per-row border, and extend edge-to-edge via `-mx-5` so the active highlight is continuous.

### Sidebar toggle icon (commits `918b03b`, `e246f94`)
- `AcctSidebarToggle` in the Topbar uses a hamburger (3-line) icon instead of the two-person Users glyph. Outer border and background were dropped; the icon is now frameless and just changes color between ink/orange to signal collapsed state.

### Dashboard "empty block" fix (commit `6181a15`)
- Tree card lost its `bg-white`. Only the search header carries an explicit `bg-white`. Table rows still paint their own white from globals.css. Result: when the table is shorter than the flex-1 card, the area below 合計 shows the page warm-white color inside the rounded card border instead of a large stark white block.

## 2026-04-29 — LINE push UX overhaul + dashboard polish

Branch `claude/audit-optimize-performance-pmMDU`. Sequence of fixes:

### Optimistic toggle update (commit `2026ef0`)
- `CampaignRow` / `AdsetRow` / `CreativeRow` keep a local `pendingStatus` state. Toggle / Badge read `pendingStatus ?? campaign.status`; `useEffect` clears `pendingStatus` whenever the server-side `campaign.status` updates. Result: clicking the switch flips visually within one frame instead of waiting on FB's round-trip.

### Dashboard push button retired + LINE push centralised (commit `05c3a3d`)
- Deleted `LinePushModal`, `useLinePushConfigs`, and the per-row push icon. The `/line-push` page is now the single source of truth.
- Added per-config `include_report_button` (DB BOOLEAN, default FALSE) so the「查看完整報告」footer button is opt-in. UI checkbox lives in `GroupPushConfigModal`.

### LINE flex polish (commits `4958bf0`, `aaa9ce6`, `391e57e`, `e1cae22`)
- Subtitle (報告區間) restyled to `lg + bold` so it visually matches the title.
- Added a status chip pinned to the **top-right of the header**:
  - `status_color` = `#16A34A` (ACTIVE) / `#DC2626` (PAUSED) / `#888888` (ARCHIVED|DELETED)
  - PAUSED prepends `M/D` parsed from FB's `updated_time` (closest free signal — Activity Log is a separate API and updated_time is the last modification, which for a paused campaign is typically when it was paused).
  - Layout: horizontal title row with `flex:1` title + `flex:0, gravity:top, height:22px` chip + `justifyContent:center` so the chip stays small even when the title wraps.
  - `_fetch_campaigns_for_account` now requests `updated_time` on both full and lite paths.
- Added per-config `include_recommendations` (DB BOOLEAN, default FALSE). 優化建議 bullet list is now opt-in; many recipients are external (業主) who only want raw numbers.

### Settings page defaults + line-push topbar (commits `ffe436e`, `6b253fc`, `a5f3a7b`)
- `blankFreq()` defaults: `weekdays = [5]` (週五), `hour = 9`, `dateRange = "month_to_yesterday"`, `reportFields = ["spend_plus", "msgs", "msg_cost"]`, `includeReportButton = false`. `blankState()` defaults `activeFrequency = "weekly"` with `weekly.enabled = true` so a brand-new config is one click away from save.
- `LinePushSettingsView` max-w widened from 640px → 1100px and gained a refresh icon in the Topbar. Click `await refetchQueries(['lineGroups', 'lineGroupConfigs'])` then toast「已重新整理」for explicit feedback (invalidate alone left a fast-network user wondering if anything happened).

### History view loading copy (commit `884c009`)
- `useHistoricalSpend` returns 6 month-counts but the loading subtitle defaulted to「個帳戶已載入」(LoadingState's fallback wording for `loaded`/`total` props). Single-account view passing 6 months looked like "4 / 6 個帳戶已載入". Fixed by passing an explicit `subtitle="X / 6 個月份已載入"`. Other views (Dashboard / Alerts / Analytics) genuinely track per-account counts and still use the default.

### Finance % field clears to 0 (commit `e627694`)
- `<input type="number">` controlled value snapped back when user cleared the field because `Number.parseFloat("")` is `NaN` → onChange skipped. Now we explicitly handle empty string as 0 (placeholder shows "0"). Applied to both row markup and global default markup.

### Campaign picker shows status badge (commit `884c009`)
- `GroupPushConfigModal`'s `SearchableCombobox` items now accept an optional `badge: ReactNode`. `CampaignPicker` passes `<Badge status={c.status} />` so the operator can avoid binding a push to a paused / archived campaign.
