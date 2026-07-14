/**
 * Objective classification shared by the report components.
 *
 * (The recommendation rule engine that used to live here —
 * `buildCampaignRecommendations`, mirroring the backend's
 * `_evaluate_alert_recommendations` — was removed 2026-07-14 along
 * with the 優化建議 blocks in the reports and the LINE push.)
 */

const TRAFFIC_OBJECTIVES = new Set([
  "OUTCOME_TRAFFIC",
  "LINK_CLICKS",
  "OUTCOME_AWARENESS",
  "BRAND_AWARENESS",
  "REACH",
  "VIDEO_VIEWS",
  "POST_ENGAGEMENT",
  "PAGE_LIKES",
]);

/** Returns true when the campaign objective is traffic / awareness
 *  oriented — for these objectives the message metrics are noise. */
export function isTrafficObjective(objective: string | undefined | null): boolean {
  if (!objective) return false;
  return TRAFFIC_OBJECTIVES.has(objective);
}
