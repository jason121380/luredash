# LURE Meta Platform

Facebook 廣告管理後台，串接 Facebook Marketing API v21.0，支援 80+ 廣告帳戶管理、AI 廣告分析、財務試算、快速上架。

設計風格參考：[Google-My-Business](https://github.com/jason121380/Google-My-Business)

---

## 功能總覽

### 儀表板（Dashboard）
- 左側帳戶選擇面板（支援多選、拖曳排序）
- 右側即時成效數據：花費、曝光、點擊、CTR、CPC、CPM、頻次、私訊數
- 樹狀三層表格：行銷活動 → 廣告組合 → 廣告（點擊展開）
- **廣告預覽彈窗**：點擊第三層廣告列開啟大圖預覽，顯示 FB 創意縮圖、標題、內文
- 篩選：只顯示有花費的活動
- 日期區間：預設區間選擇 + 自訂日期範圍
- 開關活動/廣告組合狀態、調整預算
- Topbar 漢堡按鈕收合 / 展開左側廣告帳戶側欄

### 數據分析（AI Analytics）
- 帳戶整體 KPI：總花費、進行中活動數、平均 CTR、平均 CPC、總私訊數、平均私訊成本
- 11 個 Chart.js 圖表（每列 3 個，RWD 自適應）：
  - 各帳戶花費分布、私訊數、各帳戶私訊成本
  - CTR 分布區間（0% 自動排除）
  - 花費 vs 私訊成本散點圖
  - 私訊成本分布、最佳效率活動、頻次分布
  - 私訊數 vs ROI 效率
  - 有/無私訊數據比例（甜甜圈圖）
  - 各帳戶私訊佔比（甜甜圈圖）
- 使用 chartjs-plugin-datalabels 在 bar 上直接顯示數值

### 關注名單（原 AI警示建議）
- 左側廣告帳戶選擇面板（全部 / 單一帳戶過濾）
- 三張並排卡片：**私訊成本過高**、**CPC 過高**、**頻次過高**
  - 私訊成本過高：欄位「行銷活動、花費、私訊數、私訊成本」+ checkbox「隱藏標題含流量」（預設勾選）
  - CPC 過高：欄位「行銷活動、CPC」+ checkbox「隱藏標題含私訊」（預設勾選）
  - 頻次過高：欄位「行銷活動、頻次」
  - 各卡片欄位標題可點擊排序（升/降序）
- 異常判定門檻：
  - P1: CPC > 均值 × 3（花費 > $5,000）
  - P2: 私訊成本 > 均值 × 3（有私訊數據）
  - P3: CPC > 均值 × 2（花費 > $3,000）
  - P4: 頻次 > 7
  - W1: CTR < 0.5%（花費 > $3,000）
  - W2: CTR < 1%（花費 > $10,000）
  - W3: CPC > 均值 × 1.5
  - W4: 頻次 > 5
  - W5: 私訊成本 > 均值 × 2

### 財務專區（Finance）
- 左側帳戶列表 + 花費摘要
- 右側按帳戶或行銷活動列表（支援月%加成計算）
- 行銷活動表格欄位：No.、狀態（進行中/暫停/封存）、行銷活動名稱、花費、月%、花費+%、Pin
- 列高與儀表板 tree 一致（~30px 緊湊版）
- 匯出 CSV（當前視圖）
- 篩選：只顯示有花費

### 優化中心（Optimization,Beta)
- 按下「產生分析」呼叫 Gemini 對所有啟用帳戶的行銷活動產生待辦清單
- **以廣告帳戶分組**:每個帳戶一張可摺疊卡片(預設展開),內部依嚴重程度分區(嚴重 / 中等 / 低,以紅 / 橘 / 灰 pill badge 顯示)
- 用 `agent_advice_limit` 控制配額,免費版 2 次 / 終身,付費依方案計算月份
- 結果同時寫入 PostgreSQL(`agent_advice_runs`)與 localStorage(`ai-staff-last-run`),換裝置開報告免重跑

### 設定(Settings)
拆成三個入口(2026-05-26 起):
- **廣告帳號** `/settings` — BM panel + 帳戶啟用 / 多選 / 拖曳排序
- **LINE 推播** `/line-push` — 群組管理表格,搜尋過濾,Topbar 右上有重新整理按鈕
- **我的訂閱** `/billing` — 訂閱方案 + 用量條 + Polar customer portal
- 設定群組底下另有兩個按鈕:**工程模式**(開 `EngineeringModal` 看 cache / 工具)、**登出**(2026-05-26 後從 avatar dropdown 移到這裡)

### LINE 推播（LINE Push）
- 群組自動登錄:LINE bot 加入群組時 webhook upsert 入 `line_groups`
- 一個群組可綁多筆活動推播,從 LINE 推播設定頁的「+ 新增推播」開
- 設定欄位:廣告帳號 → 行銷活動(可搜尋,顯示活動狀態 badge)、頻率(每日/每週/雙週/每月)、推播時間、報告資料區間、KPI 欄位多選、是否出現按鈕、是否啟用優化建議
- 預設值:每週五 09:00、本月1日-昨日、花費+%/私訊數/私訊成本、按鈕關閉、優化建議關閉
- LINE Flex 報告 header 右上角顯示活動狀態 chip:綠色「進行中」/ 紅色「M/D 已暫停」/ 灰色「已封存」「已刪除」

---

## 技術架構

| 層 | 說明 |
|----|------|
| Backend | Python 3.9+ / FastAPI / httpx (async) |
| Frontend | React 18 + Vite + TypeScript（`frontend/`）|
| Auth | Facebook JS SDK (browser) + `/api/auth/token` (server) |
| Charts | Chart.js 4.4.0 + chartjs-plugin-datalabels 2.2.0 |
| AI | Google Gemini API (generativelanguage.googleapis.com) |
| Storage | PostgreSQL(`asyncpg`,`DATABASE_URL`)+ localStorage(僅 ephemeral UI state)|
| Port | 8001 |

---

## 環境需求

- Python 3.9+
- Node.js 20+ / pnpm 10（用於 `pnpm build` 產生 React 前端的 `dist/`）
- Facebook App（需有 `ads_read`、`ads_management`、`business_management` 權限）
- Gemini API Key（選用，關注名單 AI 建議功能）

---

## 安裝與啟動

```bash
# 1. 安裝後端套件
pip install -r requirements.txt

# 2. 建置 React 前端(產生 dist/,供 FastAPI 提供服務)
cd frontend && pnpm install && pnpm build && cd ..

# 3. 設定環境變數
cp .env.example .env
# 填入 FB_APP_ID、FB_APP_SECRET、FB_ACCESS_TOKEN 等

# 4. 啟動
python main.py
# 或
uvicorn main:app --port 8001 --reload
```

開啟瀏覽器:http://localhost:8001

---

## 環境變數

| 變數 | 說明 |
|------|------|
| `FB_APP_ID` | Facebook App ID(`2780372365654462`)|
| `FB_APP_SECRET` | Facebook App Secret |
| `FB_ACCESS_TOKEN` | 長效用戶 token(備用,登入後以 runtime token 覆蓋)|
| `FB_API_VERSION` | Graph API 版本(預設 `v21.0`)|
| `GEMINI_API_KEY` | Google Gemini API Key |
| `GEMINI_MODEL` | Gemini 模型名稱(預設 `gemini-3-flash-preview`)|

---

## API 端點

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/accounts` | 取得所有廣告帳戶（分頁）|
| GET | `/api/accounts/{id}/campaigns` | 取得行銷活動（含 insights）|
| GET | `/api/accounts/{id}/insights` | 帳戶整體成效 |
| GET | `/api/campaigns/{id}/adsets` | 取得廣告組合 |
| GET | `/api/adsets/{id}/ads` | 取得廣告（含 creative）|
| POST | `/api/campaigns/{id}/status` | 切換行銷活動狀態 |
| POST | `/api/campaigns/{id}/budget` | 更新行銷活動預算 |
| POST | `/api/adsets/{id}/status` | 切換廣告組合狀態 |
| POST | `/api/adsets/{id}/budget` | 更新廣告組合預算 |
| POST | `/api/ads/{id}/status` | 切換廣告狀態 |
| POST | `/api/auth/token` | 設定 FB access token |
| DELETE | `/api/auth/token` | 清除 token(登出)|
| GET | `/api/auth/me` | 取得目前登入用戶資訊 |
| GET | `/api/posts/{post_id}/media` | 抓前台貼文的完整圖片 / 影片來源 |
| GET | `/api/pages/{page_id}/info` | 抓 FB 粉專名稱 + 頭像 |
| GET | `/api/videos/{video_id}/source` | 抓廣告影片的可播放來源 |
| GET | `/api/creatives/{id}/hires-thumbnail` | 600px 縮圖(預覽 Modal fallback)|
| GET | `/api/overview` | 多帳戶批次(campaigns + insights) |
| GET | `/api/breakdown` | 廣告組合 / 廣告 的 age / gender / region / publisher_platform 細分 |
| GET | `/api/line-push/groups` | LINE 群組清單(bot 加入 / 退出時 webhook 自動更新)|
| GET | `/api/line-push/configs` | 取得指定群組的所有推播設定 |
| POST | `/api/line-push/configs` | 新增 / 更新推播設定 |
| DELETE | `/api/line-push/configs/{id}` | 刪除推播設定 |
| POST | `/api/line-push/configs/{id}/test` | 立即發送測試推播 |
| POST | `/api/line/webhook` | LINE Messaging API webhook(校驗 X-Line-Signature)|
| GET | `/api/optimization/agents` | 列出可用的優化 agent metadata |
| GET | `/api/optimization/health` | 檢查 Gemini key / persona / DB 設定 |
| POST | `/api/optimization/run-agents-stream` | 串流送出每帳戶分組的 to-do markdown(計入 `agent_advice_limit` 配額) |
| GET | `/api/optimization/last-run` | 取回上次成功的 advice payload(換裝置同步) |
| GET | `/api/billing/usage` | 取得當期配額使用量 |
| POST | `/api/billing/portal` | 開 Polar customer portal session |

---

## 手機 / 響應式

- 手機版廣告帳戶選擇彈窗內建搜尋欄（autofocus，輸入即時過濾 80+ 帳戶）
- 所有 Modal 在右上角都有 X 關閉鈕（手機沒有 Esc 鍵）
- 手機版 tree 表格 row 高度與桌面版一致（~32px），不再把「進行中」badge 擠成三行垂直字

## 注意事項

- `.env` 已排除於 git，憑證不會上傳
- 企業管理平台欄位需要 token 包含 `business_management` scope
- Python 3.9 — 使用 `Optional[str]` 而非 `str | None` 語法
- 私訊數使用 `onsite_conversion.messaging_conversation_started_7d`（不使用 `total_messaging_connection`，避免重複計算）
- 預算值:傳送時 × 100(分),顯示時 ÷ 100
- 帳戶 ID 包含 `act_` 前綴(例如 `act_123456`)
- React JSX `src={...}` 是 attribute binding,**不要**把 FB signed URL 用 `escHtml()` 包起來(會被 literal 地寫入 `&amp;` 而破壞 signature)
