/** FB returns campaign objective as an enum (e.g. "OUTCOME_TRAFFIC"
 *  or the older "LINK_CLICKS"); the Marketing API never localises.
 *  Map the common values to zh-TW so report headers read as「流量」
 *  rather than「OUTCOME_TRAFFIC」. Unknown values pass through
 *  unchanged so we never silently drop information. */
export function translateObjective(raw: string): string {
  const map: Record<string, string> = {
    // ODAX (Outcome-Driven Ad Experience) — current
    OUTCOME_AWARENESS: "知名度",
    OUTCOME_TRAFFIC: "流量",
    OUTCOME_ENGAGEMENT: "互動",
    OUTCOME_LEADS: "開發潛在顧客",
    OUTCOME_APP_PROMOTION: "應用程式推廣",
    OUTCOME_SALES: "銷售業績",
    // Legacy objectives — still appear on older campaigns
    BRAND_AWARENESS: "品牌知名度",
    REACH: "觸及人數",
    LINK_CLICKS: "連結點擊",
    VIDEO_VIEWS: "影片觀看",
    POST_ENGAGEMENT: "貼文互動",
    PAGE_LIKES: "粉絲專頁讚數",
    EVENT_RESPONSES: "活動回應",
    LEAD_GENERATION: "開發潛在顧客",
    MESSAGES: "訊息",
    CONVERSIONS: "轉換次數",
    CATALOG_SALES: "目錄銷售",
    STORE_VISITS: "來店造訪",
    APP_INSTALLS: "應用程式安裝",
  };
  return map[raw] ?? raw;
}
