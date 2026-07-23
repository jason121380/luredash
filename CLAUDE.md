# CLAUDE.md — LURE Meta Platform

## Project Overview

Facebook Ads management dashboard for LURE agency. FastAPI backend + React SPA.
Connects to Facebook Marketing API v21.0 to manage 80+ ad accounts across multiple Business Managers.

## Branding

- Product: **LURE META PLATFORM**
- Colors: Orange `#FF6B2C` (primary), `#FFF5F0` (light bg / warm-white), `#FFE8D9` (border)
- Font: Noto Sans TC
- Reference design: https://github.com/jason121380/Google-My-Business

## Tech Stack

- **Backend**: Python 3.9+ / FastAPI / httpx (async)
- **Frontend**: React 18 + Vite + TypeScript (`frontend/`)
- **Charts**: Chart.js 4.4.0 + chartjs-plugin-datalabels 2.2.0
- **Auth**: Facebook JS SDK (browser) + FastAPI token endpoint (server)
- **AI**: Google Gemini API (optional, for AI recommendations)
- **Storage (as of 2026-04-17)**:
  - **PostgreSQL** (via `asyncpg`, `DATABASE_URL` env) — source of truth for:
    - `campaign_nicknames` (campaign_id → store, designer) — shared team-wide
    - `user_settings` (fb_user_id, key, value JSONB) — per-user: `selected_accounts`, `account_order`
    - `shared_settings` (key, value JSONB) — team-wide: `finance_row_markups`, `finance_pinned_ids`, `finance_default_markup`, `finance_show_nicknames`, **`security_safe_campaigns`** (array of campaign ids the team has reviewed and marked safe — drives the 待查看 / 已標記安全 tabs in 安全監控). **Underscore-prefixed keys (`_fb_runtime_token`, `_history_warm_auto_state`, `_cost_center_warm_auto_state`) are server-internal** and are filtered out by `GET /api/settings/shared` — never expose to the frontend. `_history_warm_auto_state` tracks the monthly auto re-warm of last month's `account_month_snapshots`; `_cost_center_warm_auto_state` does the same for the lurefin export snapshot (`cost_center_snapshots`, those three accounts). Both run in `_scheduler_loop` on/after day `_SNAPSHOT_SETTLE_DAY` (3) of each month; before that day the previous month is in a settle window — `_overview_snapshot_month` / `/api/cost-center` refuse to lazy-fill it and both 工程模式 manual warms are blocked — because FB insights keep back-filling attribution for 1-2 days after month end. The gate is `_latest_snapshotable_month()`: last month only becomes snapshotable once today ≥ day 3 of this month; every snapshot write path (overview lazy-fill, cost-center read lazy-fill, `/api/cost-center/backfill`, both 工程模式 capture endpoints) checks it, and after settle the two auto ticks force-overwrite once so any dirty snapshot frozen before the fix (or before settle) is corrected — the read paths never re-fetch a month that already has a snapshot.
    - `invoice_buyers` (store PK, category B2B|B2C, buyer_name, tax_id 統編, email, carrier_type/carrier_num 載具, love_code 捐贈碼, print_flag, address, notes) — 電子發票 買方資料, keyed by the free-text 店家 label (matches `campaign_nicknames.store`) so the 開立發票 form prefills from 店家花費. Admin-gated CRUD via `/api/invoice-buyers[/{store}]`. B2B 需 8 碼統編 + 檢查碼(`_valid_tw_tax_id`)且強制 print_flag=Y;B2C 載具與捐贈碼互斥。
    - `einvoices` (id PK, store, buyer snapshot 欄位, tax_type/amt/tax_amt/total_amt, items JSONB, **merchant_order_no UNIQUE** 冪等鍵, invoice_number/random_number, status issued|void|allowance, void/allowance 欄位, raw_request/raw_response JSONB PII, created_by, **account_id/campaign_id/period/spend/markup_percent** 出處) — 已開立發票帳本。**開立(Phase 2, `POST /api/einvoice/issue`)**:`ezpay_client.py`(AES-256-CBC hex、`EZPAY_MOCK` 模式)呼叫 ezPay `/Api/invoice_issue`(即時開立 Status=1)。金額用**應稅5%含稅**:`Amt=round(total/1.05)`、`TaxAmt=total-Amt`(相減不可各自四捨五入);**B2C 品項含稅(=TotalAmt)、B2B 品項未稅(=Amt)**。左側花費群組「電子發票」分頁(`/e-invoice`,`EInvoiceView`)。**開立發票** tab 右上選月份,直接沿用**費用中心**的 花費/%/花費+%(`useMultiAccountOverview` + `financeData` 的 `markupFor`/`spendPlus`,**% 不可改**),選一個活動→花費+% 為含稅金額;個人=雲端發票免填,統編填統編+抬頭(可由 `invoice_buyers` 依店家預帶)。作廢/折讓與發票紀錄列表於後續 phase。**商店金鑰可從前端設定**(見 `einvoice_merchants`):開立時 `_resolve_ezpay_creds()` 先查 DB 設定,沒有才退回 `EZPAY_*` env 全域預設。
    - `einvoice_merchants` (account_id PK, merchant_id, hash_key, hash_iv, is_test, updated_by, updated_at) — **單一全域 ezPay 商店金鑰**(全部廣告帳號共用同一組,存在固定 PK `__global__` 那一列;table 保留 account_id 欄只為將來若要 per-帳號的擴充彈性)。`is_test` 選 cinv(測試)/inv(正式)host。電子發票分頁右上齒輪 icon 開 `MerchantSettingsModal`(admin-gated):單一表單(商店代號 / HashKey 32碼 / HashIV 16碼 / 環境測試·正式)。**secret 金鑰唯寫** —— `GET /api/einvoice/merchant` 只回 `has_key`/`has_iv` 布林不回金鑰內容;`POST /api/einvoice/merchant` 的 HashKey/HashIV 留空 = 保留原值(可只改 merchant_id / is_test);`DELETE /api/einvoice/merchant` 移除(退回 env 預設)。
    - `line_groups` (group_id PK, **group_name** (real LINE display name from /v2/bot/group/{id}/summary), label (user nickname), joined_at, left_at, **channel_id**, **folder_id**) — auto-upserted by the `/api/line/webhook` route on LINE `join`/`leave` events. Lifespan startup also runs a one-shot backfill for legacy rows whose `group_name` is empty. `folder_id` (nullable = 未分類) points at `line_group_folders`.
    - `line_group_folders` (id PK, channel_id → line_channels ON DELETE CASCADE, name, sort_order) — user-defined folders for categorising groups **within one OA (channel)**. A group belongs to at most one folder; deleting a folder un-categorises its groups (`line_groups.folder_id` ON DELETE SET NULL, never deletes groups). CRUD via `/api/line-group-folders` (GET list w/ group_count, POST create, PATCH rename/reorder, DELETE) + `POST /api/line-groups/{id}/folder` to move a group (validates the target folder is on the group's own channel). Owner/admin-grant can manage; viewers read-only. Drives the LINE 群組管理 UI's OA tabs + left folder list.
    - `campaign_line_push_configs` (campaign ↔ group pairings: frequency, weekdays/month_day, hour/minute, date_range, enabled, next_run_at, fail_count, **report_fields TEXT[]**, **include_report_button BOOLEAN DEFAULT FALSE**, **include_recommendations BOOLEAN DEFAULT FALSE** (dead as of 2026-07-14 — 優化建議 removed; column kept for row compatibility, never honoured)) — partial index on `(next_run_at) WHERE enabled` for the scheduler tick.
    - `line_push_logs` (per-push audit rows, success/error/preview)
    - `security_push_configs` (event-driven LINE alert subscriptions for 安全監控: name, owner_fb_user_id, channel_id, group_ids[], account_ids[], anomaly_filters[] (deep_night/weekend/high_budget/burst), poll_interval_minutes, enabled, last_run_at, next_run_at, fail_count) — partial index on `(next_run_at) WHERE enabled`. The scheduler tick (`_security_push_tick`) piggybacks on `_scheduler_loop`; on each tick it fetches campaigns created since `last_run_at`, evaluates anomalies, and pushes a plain-text message via `line_client.line_push` to every group in `group_ids`. 5 consecutive failures auto-flip `enabled=false`.
    - `fb_throttle_events` (id, ts, scope 'account'|'global', account_id, path, error_code, source, fb_user_id, bucu_pct) — **durable** FB rate-limit / throttle log for 工程模式「FB 限流戰情室」(`/api/engineering/fb-calls`). Written fire-and-forget (`_spawn_bg(_persist_throttle_event(...))`) from `_record_account_throttle` (per-account 80000-80014) and `_record_global_throttle` (global 4/17/32/613), capturing WHO (`_current_fb_user_id`) + WHAT page (`_fb_call_source`) + BUCU% at the moment of the hit. The in-memory ring buffers (`_account_throttle_events`/`_global_throttle_events`) are still the restart-lossy fast path / fallback; this table is the complete history (survives restart, not limited to the 5-min window). The endpoint returns `throttle_events` (newest-first, up to 200, DB-backed) + `throttle_total`, and **every table (`recent`, `top_sources_5m`, `top_accounts_5m`, `top_paths_5m`, `throttle_events`) carries the triggering `fb_user_id` + a resolved display name** (`_fb_user_display_names` batch-resolves via `fb_user_profiles`). The frontend `EngineeringView` marks the **newest** throttle event (`throttle_events[0]`) in strong red as「最後爆」. `_log_fb_call` now also records `fb_user_id`.
  - **Browser localStorage** — ephemeral UI state only:
    - `fb_active_accounts` (dashboard current selection — intentionally NOT synced)
    - `filter_active_only`, date-picker preferences, sidebar collapse state
    - `meta_dash_fb_token` (FB login token cache)

## Key Files

| File | Purpose |
|------|---------|
| `main.py` | FastAPI app, all API routes |
| `frontend/` | React + Vite + TypeScript SPA source |
| `frontend/src/main.tsx` | React entry + QueryClient provider |
| `frontend/src/App.tsx` | Auth gate + host-level modals |
| `frontend/src/router.tsx` | Router + lazy-loaded views (no `/launch` route — 快速上架 removed 2026-05-26) |
| `frontend/src/layout/Sidebar.tsx` | Grouped nav (一般/成效/花費/設定) + 工程模式 / 登出 buttons + footer with avatar / tier / Bucu chip |
| `frontend/src/components/LoadingState.tsx` | Shared loading block — 3×3 blocks-shuffle SVG animation + asymptotic % curve |
| `frontend/src/views/optimization/` | 優化中心 (formerly AI 幕僚) — per-account collapsible cards rendered by `Markdown.tsx` |
| `frontend/src/views/billing/BillingView.tsx` | `/billing` — self-serve subscription + Polar customer portal |
| `agent_personas/` | Python module exporting `PERSONAS` dict (bundled into deploy artefact, NOT read from disk at runtime) |
| `frontend/public/` | Favicon + PWA icons (copied to `dist/` root at build) |
| `dist/` | `pnpm build` output — served by FastAPI in prod |
| `.env` | FB + Gemini credentials (never commit) |
| `.env.example` | Template for credentials |
| `MEMORY.md` | Project context, known issues, architecture decisions |

## Environment Variables

```
LINE_CHANNEL_ACCESS_TOKEN — LINE Messaging API channel access token (required for push)
LINE_CHANNEL_SECRET       — LINE channel secret (verifies X-Line-Signature on /api/line/webhook)
LINE_MOCK                 — Set to "1" to print push payloads instead of calling LINE (dev)
SCHEDULER_TZ              — IANA zone for HH:MM in push configs (default Asia/Taipei)
FB_APP_ID       — Facebook App ID (2780372365654462)
FB_APP_SECRET   — Facebook App Secret
FB_ACCESS_TOKEN — Long-lived user access token (fallback, overridden by FB Login)
FB_API_VERSION  — Graph API version (default: v21.0)
GEMINI_API_KEY  — Google Gemini API key (for AI recommendations)
GEMINI_MODEL    — Gemini model (default: gemini-3-flash-preview)
EZPAY_MERCHANT_ID / EZPAY_HASH_KEY / EZPAY_HASH_IV — 藍新 ezPay 電子發票 商店金鑰 (HashKey 32碼 / HashIV 16碼, AES-256-CBC)
EZPAY_API_BASE  — ezPay API base (default TEST https://cinv.ezpay.com.tw; prod https://inv.ezpay.com.tw)
EZPAY_MOCK      — "1" prints the decrypted invoice payload instead of calling ezPay (dev)
```

## Token Flow

1. User visits `/` → sees login page
2. Clicks FB Login → FB OAuth popup → gets token
3. Browser POSTs token to `/api/auth/token`
4. Server stores in `_runtime_token` AND **persists to PG** as `_fb_runtime_token` in `shared_settings`
5. All API calls use `get_token()` which prefers runtime token (fallback to .env `FB_ACCESS_TOKEN`)
6. Lifespan startup restores `_runtime_token` from PG → server restarts (e.g. Zeabur redeploy) don't break the public share page until the token actually expires (~60 days for long-lived)

For the public **/r/:campaignId** share page: viewers do NOT log in. The frontend `request()` helper detects `window.location.pathname.startsWith("/r/")` and skips `refreshBackendToken()` (the FB SDK isn't loaded there anyway), translating any 401 to a friendly "報告暫時無法載入,請聯繫管理員" instead of FB's raw "Please log in".

Required FB scopes: `ads_read`, `ads_management`, `business_management`, `pages_read_engagement`

## Running Locally

```bash
python main.py          # port 8001
# or
uvicorn main:app --port 8001 --reload
```

## Views / Layout Structure

```
[Left Sidebar 200px - fixed (`w-sidebar` = tailwind spacing.sidebar)]
  Logo: METADASH by LURE
  Nav grouped (一般 / 成效 / 花費 / 設定):
    一般 → 儀表板 | 數據圖表 | 安全防護 (Beta)
    成效 → 警示列表 | 優化中心 (Beta)
    花費 → 費用中心 | 店家花費 | 歷史花費
    設定 → 廣告帳號 | LINE 推播 | 我的訂閱
             (button) 工程模式 — opens `EngineeringModal` (lazy)
             (button) 登出
  Footer: avatar + name + TierBadge + BucuHeaderChip
          (no dropdown — 登出 moved into 設定 group; chip moved out of Topbar 2026-05-27)

[Main Content]
  [Topbar 60px desktop / 52px mobile — title + date picker + controls (right-aligned)]
  [View-specific body]
```

Renames (2026-05-26):
- 數據分析 → **數據圖表**
- 安全監控 → **安全防護** (Beta tag)
- AI 幕僚 → **優化中心** (Beta tag)
- 廣告帳號設定 → **廣告帳號** / LINE 推播設定 → **LINE 推播**
- New entry: **我的訂閱** (`/billing`)
- **快速上架** view + `/api/quick-launch/campaign` endpoint + AI chat (`/api/ai/chat`) **deleted** (commit `e382110`, 2026-05-26). No replacement.

`TopbarSeparator` is now a no-op component (`return null`) — kept as a stub for old call sites until they're removed.

### Dashboard view
```
[Account List 240px] | [Topbar: date + filter]
                       [Stats row: spend/impressions/clicks/CTR/CPC/CPM/freq/msg]
                       [Tree table: Campaign → Adset → Ad (3 levels)]
```

### 關注名單 (Alert/Watch List)
```
[Account List 240px] | [3 side-by-side cards]
  dash-acct-item style  私訊成本過高 | CPC過高 | 頻次過高
  全部帳戶 + per-account  sortable headers, keyword filters
```

### 安全監控 (Security Monitor)
```
[Account List 160px] | [Topbar: date picker (預設 last_7d) + 推播設定 button]
                       [Tabs: 待查看 (N) | 已標記安全 (N)]
                       [Per-day groups]
                         [Campaign card: status / 新建立 + anomaly badges
                          編號 / 帳戶 / 目標 / 時間 / 建立者 / 日預算 / 已花費
                          右側: 標記為沒問題 / 編輯紀錄 (兩個 tab 都預設收合,點才 lazy 拉 activities)]
```
- 每張卡片預設顯示「新建立」灰 badge,有異常時加 deep_night / weekend / burst / high_budget badge
- 「編輯紀錄」展開時拉 `/api/accounts/{id}/activities` 並用 `summariseExtraData()` 把 FB extra_data 翻成「狀態:進行中 → 暫停」「日預算:$X → $Y」「Meta 政策審查 (代碼 4134001)」等人話
- 「標記為沒問題」寫入 `shared_settings.security_safe_campaigns`,team-wide
- 「推播設定」開 `SecurityPushSettingsModal` 建立 `security_push_configs` 行(channel + groups + anomaly filter + 輪詢頻率)
- BM 成員自動偵測之前嘗試過(`/api/accounts/{id}/assigned-users` + `business_users`),但 FB API 對非完全 BM-managed 帳戶都回空,實務上沒用,已移除
- `effectiveDailyBudget(campaign)` 拿不到 campaign.daily_budget 時加總 ACTIVE adsets 的 daily_budget,卡片顯示「(廣告組合加總)」suffix
- high_budget 閾值 = 2000(raw FB value,跟儀表板 `fM()` 同 scale);burst 在前端是「同帳戶 2 小時內 ≥ 5 個」,Python 端 push tick 不計算

### Finance view
```
[Account List 160px] | [Toolbar: search + filter + markup]
                        [Campaign table: No.|狀態|名稱|花費|月%|花費+%|Pin]
```

### Settings view
Sidebar 工具區拆成兩個入口（2026-04-26 後）:
- **廣告帳號設定** `/settings` — BM panel + 帳戶啟用 / 多選 / 拖曳排序。Topbar 右上有 **廣告金額預設%** input(2026-07-09 從費用中心工具列搬來):寫 `finance_default_markup` shared setting,是費用中心「沒有 per-row override 的活動」的 fallback markup(讀寫同一個 `useFinanceStore`,`SettingsProvider` 登入時 hydrate,任何頁面都可用)。
- **LINE 推播設定** `/line-push` — `LineGroupsContent` **用 OA(channel)分頁**呈現(2026-07-07 改版:一個 tab 一個官方帳號,無「全部」總覽,預設第一個 OA);每個分頁內**左側是該 OA 的資料夾清單**(全部 / 未分類 / 使用者自訂資料夾 + 新增/改名/刪除,owner/admin 才可管理),右側表格列出該分類的群組(只顯示 `left_at IS NULL`)+ 每列一個「資料夾」下拉可搬移群組 + 該群組綁定的所有 push configs(一個 group 多 campaign)。**搜尋框 scope 在當下 OA 分頁**(選了資料夾則再收窄)。`channel_id` 為 NULL 的舊群組歸在「未指定官方帳號」分頁(無資料夾)。Topbar 右上有 **重新整理** icon:點擊後 `POST /api/line-groups/refresh-all` 批次拉每個 group 的 LINE display name、若 LINE 回 404(bot 已被踢出 / token 失效)就把 row 標記 `left_at = NOW()` 從 UI 中移除,接著 `refetchQueries(['lineGroups', 'lineGroupConfigs'])` 並 toast「已更新 N 個群組名稱、移除 M 個已退出群組」。每筆 config 有編輯/刪除按鈕,新增推播時用可搜尋的 `GroupPushConfigModal` 選帳戶 / 行銷活動(combobox 顯示活動狀態 badge)。
- 推播設定 modal 預設值:每週五 09:00 / 本月1日-昨日 / 花費+%/私訊數/私訊成本 / `include_report_button=false`(opt-in)。(「是否啟用優化建議」checkbox 已於 2026-07-14 移除。)

## Account Selection Logic

- `savedSelectedIds` (localStorage: `fb_selected_accounts`) = accounts enabled in Settings
- `selectedAccounts` (localStorage: `fb_active_accounts`) = accounts active in dashboard
- Dashboard left panel only shows accounts that are in `savedSelectedIds` (if any configured)
- `getVisibleAccounts()` returns accounts sorted by `acctOrder`

## Common Patterns

### Backend
- All FB API calls: `fb_get()` or `fb_post()` helpers in main.py
- Pagination: `get_accounts()` follows `paging.next` in while loop
- Budget values: render with `fM(daily_budget)` directly — no /100 transformation. FB stores budget in the account's currency major unit (TWD has no subunit, so 500 = NT$500). Dashboard / Alerts / Security view all render raw FB value. The `× 100` note in older code only applies to the Activity Log `extra_data` for budget-change events (FB returns those in cents-equivalent there).
- Account IDs include `act_` prefix (e.g. `act_123456`)
- `_fetch_campaigns_for_account` requests `id,name,status,objective,daily_budget,lifetime_budget,created_time,updated_time,adsets.limit(50){daily_budget,lifetime_budget,status},{insights}`. `created_time` powers 安全監控's per-day grouping. `updated_time` is needed by the LINE flex push to render「M/D 已暫停」. The nested `adsets{daily_budget}` lets the security view's `effectiveDailyBudget()` aggregate ABO budgets when the campaign itself uses CBO=off.
- **Insights always come from the `/insights` EDGE, never from field-expanding `insights` on a node or nested edge** — node/nested expansion returns an EMPTY insights row for some entities (awareness objectives / certain delivery structures) even when they spent. `get_campaign` stitches `_fetch_single_entity_insights` (edge, single entity); `get_adsets` → `_fetch_adsets_with_insights` stitches `_fetch_child_insights_bulk(campaign_id, "adset", ...)`; `get_ads` stitches `_fetch_child_insights_bulk(adset_id, "ad", ...)` (ad tier includes the video metrics). All stitch under `entity["insights"]["data"][0]` so `getIns(c)` is unchanged.
- **Never call a route function directly from Python if its signature has a `Query(...)` default** — the default is the fastapi Query OBJECT (truthy!), not the value. This bit `get_adsets(budget_only=Query(False))`: the snapshot gather called it directly and silently got budget-only adsets with no insights. Route functions guard with `is True`; internal callers use the extracted plain helpers (`_fetch_adsets_with_insights`).

### Frontend
- Date params: `_insights_clause()` builds `insights.date_preset(X){fields}` or `insights.time_range(X){fields}`
- Cache: `_cacheGet/Set(type, acctId, dateParam)` — in-memory, cleared on date change
- `getIns(c)` extracts the `insights.data[0]` object from a campaign/adset/ad
- `getMsgCount(c)` — **global function** (not local to any view) — reads `onsite_conversion.messaging_conversation_started_7d` or `messaging_conversation_started_7d` from `actions[]`, first-found to avoid double counting. Never use `total_messaging_connection`.
- `fM(v)` formats money (comma separator), `fP(v)` formats percentage, `fN(v)` formats integer count

### Ad tree (Dashboard)
- `adData[adsetId]`: `undefined` = not fetched, `null` = error, `[]` = empty, `[...]` = loaded
- `expandedAdsets` Set tracks which adsets are expanded
- `toggleAdset(id)` handles fetch + expand/collapse

### Alert cards
- `_alertRows`, `_alertSort`, `_alertCols`, `_alertFilter` — module-level state
- `alertSortBy(cardKey, colLabel)` — toggles sort direction
- `alertFilterToggle(cardKey)` — toggles keyword filter
- `_renderAlertCardRows(cardKey)` + `_renderAlertCardHead(cardKey)` — re-render without full page reload
- IDs: `alert-thead-msg`, `alert-tbody-msg`, `alert-thead-cpc`, etc.

### Checkboxes
All checkboxes use `.custom-cb` class for consistent white-checkmark-on-orange style.
Do NOT use `accent-color` inline style — always use the `custom-cb` class.

### Tree / Finance row compactness (React)
- Body `<td>`s in `table.tree` and `FinanceTable` have NO vertical padding — row height is driven by the tallest child control (typically `Button size="sm"` = 30px or pin button `h-[30px] w-[30px]`). Result: both tables have ~30px row height on desktop.
- On mobile, `globals.css` overrides `table.tree th/td` padding to `6px 6px` (header `8px 6px` for sort-arrow headroom). Combined with the nowrap badge, mobile tree rows are ~32px instead of the ~70px they used to be.
- `.badge` has `white-space: nowrap` so "進行中" never wraps into three stacked CJK characters in narrow mobile cells.

### Modal (Radix Dialog)
- The `<Modal/>` component always renders a tappable X close button in the top-right corner. Title and subtitle get `pr-10` so they do not overlap the X. Mobile users can't hit Esc, and the backdrop-tap affordance isn't always discoverable.
- `MobileAccountPicker` opens a search-enabled Modal: autofocused `<input type="search">` filters accounts by substring match on name. Search state resets every open. "全部帳戶" is suppressed while the user is typing.

### Ad creative preview (3rd level)
- Clicking a `CreativeRow` opens a preview Modal showing the FB thumbnail enlarged, plus the creative title / body text.
- Backend `get_ads` passes `thumbnail_width=600` and `thumbnail_height=600` when requesting the creative field so the thumbnail is sharp at modal scale. FB returns the nearest CDN size.
- The dashboard tree card has a transparent bg (only the search header has `bg-white` explicitly). When the table is shorter than the card, the area below 合計 shows the page warm-white instead of a stark white block.

### Optimization view (優化中心, formerly AI 幕僚)
- Backend `/api/optimization/run-agents-stream` ships campaign digests up to Gemini grouped by ad account; `_format_campaigns_for_prompt` (main.py:10493) renders each account as its own `### 帳號:` section in the markdown table, capped per-account so low-spend accounts still get a slot. The system prompt forces the model to emit `## [帳戶名稱] → ### 嚴重/中等/低 → bullet to-dos`, including a mandatory `### 無待辦` block for clean accounts.
- Frontend `Markdown.tsx` walks the parsed block list and wraps every `##` (account) heading + its descendants in a collapsible `<details open>` card with chevron icon (`renderGrouped`). Severity `### h3` headings render as pill badges (red / orange / gray for 嚴重 / 中等 / 低).
- Two-phase hydration in `OptimizationView.tsx`: phase 1 reads cached payload from `localStorage["ai-staff-last-run"]` synchronously; phase 2 fetches `/api/optimization/last-run` and overwrites only if newer than the local copy. This is what lets a user open the same report on a second device without re-spending Gemini quota.
- Quota lives in `subscriptions.agent_advice_limit` (per-tier; -1 = unlimited). `_count_advice_runs_for_quota` selects monthly-or-lifetime counts based on `agent_advice_period`. Each click of 「產生分析」 inserts one row in `agent_advice_runs` with the JSONB payload.

### LoadingState animation (2026-05-27)
- The shared `<LoadingState/>` block renders a 3×3 **blocks-shuffle SVG** in the product orange gradient (was previously a Spinner). The 9 `<rect>` boxes animate via inline CSS keyframes (`moveBox5631-1..9`) on a 4s cycle.
- Progress curve is unchanged: time-based asymptotic `1 - e^(-t/tau)` capped at 92%, OR per-query `loaded/total` if the caller supplies honest counts.

### Optimistic status toggle (Dashboard)
- `CampaignRow` / `AdsetRow` / `CreativeRow` keep a local `pendingStatus: FbEntityStatus | null` so the Toggle + Badge flip instantly. Source of truth = `pendingStatus ?? entity.status`. A `useEffect` clears `pendingStatus` whenever `entity.status` changes (server-side update arrived). On mutation error, also clear `pendingStatus` so the UI snaps back to truth. Without this the controlled Toggle component snaps back to the stale prop while the FB round-trip is in flight, and users mash the switch repeatedly.

### LINE flex card (`line_client.build_flex_report`)
- **KPI source (all 3 levels)**: `_build_flex_for_config` fetches metadata and insights **separately, in parallel** at every level. Numbers come from `_fetch_single_entity_insights` which hits the entity's `/insights` EDGE (`GET /{id}/insights`) — level-agnostic, so it works for campaign / adset / ad ids alike, and matches the canonical path the dashboard uses at campaign level (`act_xxx/insights?level=campaign`). Do NOT field-expand `insights` on an entity node (`?fields=insights.date_preset(X){...}`) — node expansion returned an EMPTY insights row for some entities (awareness objectives / certain delivery structures) even when they clearly spent, causing 花費 $0 on the LINE card while the dashboard showed real spend. Both the campaign-level single bubble AND the per-member carousel (adset/ad `以廣告組合/廣告播報`, via the nested `_fetch_member` coroutine) read the edge. Tiered field fallback + rate-limit re-raise mirror `_fetch_campaign_insights_bulk`.
- Header layout: outer `vertical` orange box → child 0 = horizontal "title row" with `flex:1` title + `flex:0, gravity:top` status chip → child 1 = subtitle (`size:lg, weight:bold` to match title) → optional 「目標 · X」line.
- Status chip parameters (caller passes hex color directly):
  - ACTIVE → `#16A34A` 「進行中」
  - PAUSED → `#DC2626` 「M/D 已暫停」(M/D from FB campaign `updated_time`)
  - ARCHIVED / DELETED → `#888888`
- Chip is a vertical box with `cornerRadius:md`, `backgroundColor:#FFFFFF`, small symmetric padding, `gravity:top`. **Do not** add `height` or `justifyContent` — some property combos cause LINE to 400 the entire message ("messages[0] is invalid"). Intrinsic text height + padding + gravity is sufficient.
- Body section is opt-in:
  - `include_report_button=true` → footer button linking to the LIVE share page `/r/:campaignId` (`_share_url_for_config`, window concretized to from/to). Frozen snapshots are dashboard-生成報告-only — see the "LINE push report button" note below.

## Alert Thresholds

| Code | Category | Trigger |
|------|----------|---------|
| P1 | CPC過高 | CPC > avgCpc × 3, spend > $5,000 |
| P2 | 私訊成本過高 | msgCost > avgMsgCost × 3, has msg data |
| P3 | CPC過高 | CPC > avgCpc × 2, spend > $3,000 |
| P4 | 頻次過高 | frequency > 7 |
| W1 | CTR偏低 | CTR < 0.5%, spend > $3,000 |
| W2 | CTR偏低 | CTR < 1%, spend > $10,000 |
| W3 | CPC偏高 | CPC > avgCpc × 1.5 |
| W4 | 頻次偏高 | frequency > 5 |
| W5 | 私訊成本偏高 | msgCost > avgMsgCost × 2 |

## Insight Report (LINE flex push + share page `/r/:id`)

**優化建議 removed everywhere (2026-07-14)**: the rule engine (backend `_evaluate_alert_recommendations`, frontend `buildCampaignRecommendations`) and its rendering (LINE flex bullet list, report 優化建議 block, 推播設定 modal「是否啟用優化建議」checkbox, `?advice=` share param) were all deleted. Reports and pushes carry raw numbers only. `lib/recommendations.ts` still exists but only exports `isTrafficObjective`. The `include_recommendations` DB column / API field remains for row compatibility but is never honoured (UI always saves false).

### Report versions (dashboard 報告 icon)

The dashboard `CampaignRow` 報告 icon opens `<ReportModal/>`, which **first shows a version chooser** (2026-07-09) — the user picks before any report renders:
- **以廣告組合報告** (`standard`) → `ReportContent` (the insight report below — KPI grid + per-adset breakdown).
- **以廣告報告** (`perf`) → `PerformanceReportContent` — campaign KPI summary (花費 / 曝光 / 觸及 / CPC / CTR) + **素材成效(依點擊率排序)**: EVERY ad that spent, ranked by CTR desc (zero-spend dropped, zero-CTR kept at bottom), each a vertical creative card: thumbnail + 點擊率 / 點擊成本 / 曝光 / 平均播放時間 / 按讚 / 分享. Ads are fetched per-adset via `useQueries` (reusing the `["report-ads", …]` cache), flattened, ranked. Card image uses the 600px hires thumbnail (`api.creatives.hiresThumbnail`, same `["hires-thumbnail", id, 600]` cache as the preview modal, no auth gate so it works on the logged-out share page) because video creatives have no `image_url` and the field-expanded `thumbnail_url` is only ~64px → blurry when stretched. Metrics: 按讚 = `actions[]` `post_reaction`, 分享 = `post`, 平均播放時間 = `video_avg_time_watched_actions` (added to `get_ads`; video creatives only, hidden when 0). Still omitted (not in the Marketing API): IG 追蹤 / 收藏 / 觀看率.

Modal chrome: the modal **title is the version name** (`以廣告報告` / `以廣告組合報告`); **複製分享連結** sits top-right (Modal `titleAction`, left of the X) — there is no 換版本 button (re-open to re-pick). The **指標選擇** picker (`ReportFieldsPicker`, same catalog `REPORT_FIELDS` as the LINE push) is **always expanded** (no 花費顯示 / 顯示指標 toggles) — 花費 vs 花費+% is chosen via its mutex chips, and `useSpendPlus` is derived from whether `spend_plus` is in the selection. Picked fields drive the campaign KPI **single-row table** (`KpiTable`, exported from `ReportContent`; scrolls horizontally) + adset/ad KPI grids (standard) / creative cards (perf) via `selectedFields`/`pickCells`/`buildKpiCells` (all exported from `ReportContent`), and are threaded into the share URL as `?fields=`. The selection is **per-campaign + team-wide**, persisted to `shared_settings.report_selected_fields` as a map `{campaignId: string[]}` (**ordered** — drives which KPIs show AND their order) via `useFinanceStore.reportFieldsByCampaign` / `setReportFields(campaignId, v|null)` (debounced POST; null clears that campaign's entry) — hydrated by `SettingsProvider`. The picker is always **`reorderable`** in the modal: selected chips drag-to-reorder (`moveReportField`) + tap-to-remove, unselected chips tap-to-add appended (`addReportFieldOrdered`, preserves order, unlike `toggleReportField` which the LINE push picker still uses in flat catalog-order mode). All KPI cells render uniform grey (the `highlight` hint no longer styles). The 成效報告 card also shows 收藏 (`getPostSaves` → `onsite_conversion.post_save`|`post_save`). The dashboard report icon is a bar-chart glyph (was a document glyph).

Report header shows the **店家 · 設計師 nickname** instead of the raw campaign name (and no longer shows the ad-account name): `campaign.nickname` (server-resolved on `GET /api/campaigns/{id}` via `_campaign_nickname_display`, for the share page) → cached `useNicknames()` map (dashboard) → raw `campaign.name`. `/api/nicknames` (full list) is deliberately NOT public — only the single campaign's nickname is exposed via the already-public campaign endpoint.

**下載 PDF** button (top-right, left of 複製分享連結): opens the share page with `?print=1`; `ShareReportPage` auto-calls `window.print()` ~1.5 s after the campaign loads. Uses native print (not a canvas capture) so the cross-origin FB CDN thumbnails render — the share page adds `print:static print:overflow-visible` so the whole report flows onto pages instead of clipping to one viewport.

Thumbnail sharpness applies to BOTH reports' ad cards (`ReportContent`'s `AdCard` + `PerformanceReportContent`'s `CreativeCard`): image_url → 600px hires → raw thumbnail_url. **Share page is view-only**: `<ShareReportPage/>` passes `disablePreview` to both report components (a `PreviewDisabledContext` in `ReportContent` reaches the deep `AdCard`; a prop on `PerformanceReportContent`) so clients see thumbnails but cannot click to open the enlarge modal.

**LINE push report button** (`campaign_line_push_configs.report_variant`, `'standard'|'perf'`, `_norm_report_variant` whitelists): when `include_report_button` is on, `GroupPushConfigModal` shows a dropdown (以廣告組合報告 / 以廣告報告). The button links to the **LIVE** share page (`/r/:campaignId` via `_share_url_for_config`, window concretized to `from`/`to`, `?report=perf` for perf). **Division of labor (2026-07-14 decision)**: pushes are periodic and each send re-reads FB anyway, so the button just opens current numbers — frozen snapshots (`/r/s/:id`) are generated ONLY by the dashboard's manual 生成報告 flow (`POST /api/report-snapshots`, browser-payload path). A push-time snapshot generation existed briefly the same day and was removed (it made 測試 slow/504-prone and cluttered 生成紀錄 with `line-push` rows).

Both versions share the 花費/花費+% toggle and the 複製分享連結 button. The share URL carries `?report=perf` for 成效報告 (`buildShareUrl({variant})` → `ShareReportPage` parses `report` and renders the matching component). `translateObjective` was extracted to `@/lib/objective` so both report components use it.

### Share page (`/r/:campaignId`) layout

`ReportContent` (shared by `<ReportModal/>` and `<ShareReportPage/>`) is **insight-oriented**, fully auto-expanded:
1. Header (status / objective / date label)
2. 12-cell KPI grid — 花費 / 私訊數 / 私訊成本 cards have an orange highlight border so the operator's eye lands on outcomes first.
4. Per-adset card (`AdsetCard`):
   - Mini KPI row
   - `<BreakdownInsightStrip/>` — 4 cards (版位 / 性別 / 年齡 / 地區), each fires its own React Query in parallel and shows the **winner** for that dim. Winner picked by: msgCost (lowest, if any bucket has messages) → CTR (highest, requires impressions ≥100) → impressions (fallback).
   - Ad cards grid (2 cols on ≥sm). Each card has 56px thumbnail (click → `<CreativePreviewModal/>` 600px hi-res), KPI inline, and the best-performing ad in this adset gets a "★ 表現最佳" orange badge.

### Breakdown endpoint

`GET /api/breakdown?level={adset|ad}&id=&dim={age|gender|region|publisher_platform}&date_preset=...&time_range=...` — proxies FB Graph's `<entity>/insights?breakdowns=...` with the dim whitelisted. Returns `{key, spend, impressions, clicks, ctr, cpc, cpm, msgs}` per bucket.

## Do Not

- Commit `.env`
- Use sync httpx — all FB calls must be async
- Use `str | None` syntax (Python 3.9 — use `Optional[str]` from typing)
- Add emojis to the UI
- Define `getMsgCount` locally inside a function — it must remain a global function (legacy) or a module-level named export (React rewrite). NEVER copy its logic inline.
- Use `onsite_conversion.total_messaging_connection` for message counting (double-counts)
- Use `accent-color` on checkboxes — always use `class="custom-cb"`
- **Use any CSS class name starting with `ad-` or `ads-`**. Ad blockers
  (uBlock Origin, AdBlock Plus) include filter list rules like
  `[class^="ad-"]` that set `display:none !important` on matching
  elements. This is the root cause of commit `d720fa2` (3rd-level ads
  invisible). Use `creative-*` or another prefix instead. The
  `frontend/scripts/check-no-ad-class.mjs` pre-commit guard enforces
  this automatically — it runs as part of `pnpm lint`.
- **Wrap URLs passed to React JSX `src={...}` in any `escHtml()`-style
  helper**. JSX attribute bindings write the value literally — they do
  NOT re-parse `&amp;` back to `&`. Any HTML-escaping of a Facebook
  signed CDN URL will literally insert `&amp;` into the attribute and
  break the signature (→ 403 → broken thumbnail). Use the raw URL
  directly in React; React already escapes attribute values correctly.

## React-only architecture (as of 2026-04-15)

The legacy `dashboard.html` single-file SPA was deleted in the
React-only cutover. The React app under `frontend/` is now the ONE
and ONLY frontend:

- `main.py` serves the built React bundle at `/` from module-level
  cached bytes (the SPA catch-all reads from `_REACT_INDEX_HTML`,
  not from disk per request)
- `pnpm build` output goes to repo-root `dist/`
- Top-level PWA assets (`favicon.png`, `icon-192.png`, `icon-512.png`)
  live in `frontend/public/` and are copied to `dist/` at build time;
  `main.py` serves them via dedicated routes
- Zeabur deploy config: `zeabur.json` runs
  `corepack enable && cd frontend && pnpm install && pnpm build && cd .. && pip install -r requirements.txt`
- User settings (selected accounts, markups, pins, nicknames, etc.)
  are persisted to **PostgreSQL** via `DATABASE_URL`. See the Storage
  section above for the split between per-user, shared, and ephemeral
  (localStorage) state. `SettingsProvider` (under `providers/`) is the
  hydration gate — it fires the two GETs in parallel on login and
  only renders the app once both settle.

Quality gates (all run in CI, enforced by `pnpm check`):
- `pnpm typecheck` — strict TS + `noUncheckedIndexedAccess`
- `pnpm lint`      — Biome + `lint:no-ad-class` guard
- `pnpm test`      — Vitest unit tests for pure business logic
- `pnpm test:e2e`  — Playwright visual regression
