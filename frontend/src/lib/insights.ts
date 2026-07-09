import type { FbBaseEntity, FbInsights } from "@/types/fb";

/**
 * Insights / action helpers — ported from the original template.
 *
 * CLAUDE.md invariants enforced here:
 * - `getMsgCount` is the single source of truth for message counting.
 *   It MUST use the first-found logic across
 *   `onsite_conversion.messaging_conversation_started_7d` and
 *   `messaging_conversation_started_7d` to avoid double-counting.
 * - NEVER use `onsite_conversion.total_messaging_connection` — it
 *   counts total connections, not conversations started, and inflates
 *   the numbers.
 */

/** Extract the first insights row from an entity, or an empty object. */
export function getIns(item: FbBaseEntity): FbInsights {
  return item.insights?.data?.[0] ?? {};
}

/** Get a specific FB action value by action_type, or null. */
export function getAct(item: FbBaseEntity, type: string): string | null {
  const actions = getIns(item).actions;
  if (!actions) return null;
  return actions.find((a) => a.action_type === type)?.value ?? null;
}

const MSG_TYPES = [
  "onsite_conversion.messaging_conversation_started_7d",
  "messaging_conversation_started_7d",
] as const;

/**
 * Get the number of messaging conversations started for an entity.
 * Uses **first-found** logic to avoid double counting: if the entity
 * has both `onsite_conversion.messaging_conversation_started_7d` and
 * `messaging_conversation_started_7d`, we take only the first.
 */
export function getMsgCount(item: FbBaseEntity): number {
  const actions = getIns(item).actions ?? [];
  for (const type of MSG_TYPES) {
    const action = actions.find((a) => a.action_type === type);
    if (action) {
      return Number(action.value) || 0;
    }
  }
  return 0;
}

/** Sum of specific action types (e.g. "purchase", "lead"). */
export function sumAction(item: FbBaseEntity, type: string): number {
  return Number(getAct(item, type) || 0);
}

/** 貼文按讚 / 表情數 (post_reaction) attributed to this ad. */
export function getPostReactions(item: FbBaseEntity): number {
  return sumAction(item, "post_reaction");
}

/** 分享數 (post) attributed to this ad. */
export function getShares(item: FbBaseEntity): number {
  return sumAction(item, "post");
}

/** 收藏數 — FB usually keys saves as `onsite_conversion.post_save`;
 *  some placements report a bare `post_save`. First-found wins. 0 when
 *  no one saved (or the placement doesn't report saves). */
export function getPostSaves(item: FbBaseEntity): number {
  const actions = getIns(item).actions ?? [];
  for (const type of ["onsite_conversion.post_save", "post_save"]) {
    const hit = actions.find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

/** Average seconds the video was watched. 0 for non-video creatives
 *  (FB omits `video_avg_time_watched_actions` for them). */
export function getAvgWatchSeconds(item: FbBaseEntity): number {
  const arr = getIns(item).video_avg_time_watched_actions;
  if (!arr || arr.length === 0) return 0;
  // FB usually keys this by action_type "video_view"; take the first
  // positive value regardless of the exact key.
  const hit = arr.find((a) => Number(a.value) > 0) ?? arr[0];
  return Number(hit?.value) || 0;
}

/** Convenience: numeric spend from an entity's first insights row. */
export function spendOf(item: FbBaseEntity): number {
  return Number(getIns(item).spend || 0);
}

const PURCHASE_TYPES = [
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "purchase",
] as const;

const ATC_TYPES = [
  "omni_add_to_cart",
  "offsite_conversion.fb_pixel_add_to_cart",
  "add_to_cart",
] as const;

/** Walk a priority list of action_types and return the first match's
 * value as a number. Used for both counts (actions[]) and computed
 * values (cost_per_action_type[], purchase_roas[]) which all share
 * the {action_type, value} shape. */
function firstActionValue(
  items: { action_type: string; value: string }[] | undefined,
  candidates: readonly string[],
): number {
  if (!items) return 0;
  for (const type of candidates) {
    const hit = items.find((a) => a.action_type === type);
    if (hit) return Number(hit.value) || 0;
  }
  return 0;
}

export function getPurchaseCount(item: FbBaseEntity): number {
  return firstActionValue(getIns(item).actions, PURCHASE_TYPES);
}

export function getAtcCount(item: FbBaseEntity): number {
  return firstActionValue(getIns(item).actions, ATC_TYPES);
}

export function getCostPerPurchase(item: FbBaseEntity): number {
  return firstActionValue(getIns(item).cost_per_action_type, PURCHASE_TYPES);
}

export function getCostPerAtc(item: FbBaseEntity): number {
  return firstActionValue(getIns(item).cost_per_action_type, ATC_TYPES);
}

export function getLinkClicks(item: FbBaseEntity): number {
  return Number(getIns(item).inline_link_clicks || 0);
}

export function getCostPerLinkClick(item: FbBaseEntity): number {
  return Number(getIns(item).cost_per_inline_link_click || 0);
}

export function getRoas(item: FbBaseEntity): number {
  const ins = getIns(item);
  return firstActionValue(ins.purchase_roas ?? ins.website_purchase_roas, PURCHASE_TYPES);
}
