import {
  getAtcCount,
  getCostPerAtc,
  getCostPerLinkClick,
  getCostPerPurchase,
  getIns,
  getLinkClicks,
  getMsgCount,
  getPurchaseCount,
  getRoas,
} from "@/lib/insights";
import type { FbBaseEntity } from "@/types/fb";

/**
 * Status sort weight — lower = higher priority. ACTIVE first,
 * PAUSED second, ARCHIVED third, DELETED / unknown last. Gives the
 * tree a useful "what's live at the top" grouping on descending sort.
 */
function statusRank(status: string | undefined): number {
  switch (status) {
    case "ACTIVE":
      return 0;
    case "PAUSED":
      return 1;
    case "ARCHIVED":
      return 2;
    case "DELETED":
      return 3;
    default:
      return 4;
  }
}

/**
 * Name sort uses a hashed numeric surrogate so the TreeTable sort
 * comparator (which assumes numeric return from `sortKey`) still
 * works without refactoring to a Comparator<T>. We use the UTF-16
 * code units of the name so the ordering is deterministic and
 * locale-insensitive (matches legacy the original design behavior). For
 * proper zh-TW collation we'd switch to localeCompare, but that
 * requires touching the TreeTable sorter.
 */
function nameRank(name: string | undefined): number {
  if (!name) return 0;
  // Only use the first ~8 chars so the resulting number stays
  // inside Number.MAX_SAFE_INTEGER after the base-16 weighting.
  const sample = name.slice(0, 8);
  let rank = 0;
  for (let i = 0; i < sample.length; i++) {
    rank = rank * 65536 + sample.charCodeAt(i);
  }
  return rank;
}

/**
 * Column schema for the dashboard tree table. Ported from the
 * `cols` array defined inside `renderTree()` at the original design line
 * 1958. Multi-account mode inserts the "帳戶" column between name and
 * status.
 *
 * Kept as a pure data structure (no JSX) so it can be reused from
 * the table renderer, the header, and sort handlers without pulling
 * React into this file.
 */

export type TreeColKey =
  | "no"
  | "name"
  | "account"
  | "status"
  | "spend"
  | "spend_plus"
  | "impressions"
  | "clicks"
  | "ctr"
  | "cpc"
  | "msg"
  | "msgcost"
  | "link_clicks"
  | "cost_per_link_click"
  | "add_to_cart"
  | "cost_per_add_to_cart"
  | "purchases"
  | "cost_per_purchase"
  | "roas"
  | "budget"
  | "actions";

export interface TreeCol {
  key: TreeColKey;
  label: string;
  /** Function returning the sort value for a row. Omit for non-sortable. */
  sortKey?: (entity: FbBaseEntity) => number;
  /** Render the header label in orange + bold (matches the cell styling).
   *  Used by 花費+% so the whole column reads as the highlighted total. */
  emphasize?: boolean;
}

/** Optional e-commerce columns surfaced via the gear-icon picker.
 * Order here = order they appear in the table when enabled.
 * Default-off — empty extras list keeps the legacy 11-column layout. */
export const EXTRA_TREE_COLS: { key: TreeColKey; label: string }[] = [
  // 花費+% is special: it renders IMMEDIATELY after the 花費 column
  // (not in the trailing extras block) and needs the campaign markup
  // %, so buildTreeCols / the row components handle it out-of-band.
  // Listed here only so it appears as a checkbox in the column picker.
  { key: "spend_plus", label: "花費+%" },
  { key: "link_clicks", label: "連結點擊" },
  { key: "cost_per_link_click", label: "連結點擊成本" },
  { key: "add_to_cart", label: "加入購物車" },
  { key: "cost_per_add_to_cart", label: "加入購物車成本" },
  { key: "purchases", label: "購買數" },
  { key: "cost_per_purchase", label: "購買成本" },
  { key: "roas", label: "ROAS" },
];

const EXTRA_SORT_KEYS: Partial<Record<TreeColKey, (i: FbBaseEntity) => number>> = {
  link_clicks: (i) => getLinkClicks(i),
  cost_per_link_click: (i) => {
    const v = getCostPerLinkClick(i);
    return v > 0 ? v : Number.POSITIVE_INFINITY;
  },
  add_to_cart: (i) => getAtcCount(i),
  cost_per_add_to_cart: (i) => {
    const v = getCostPerAtc(i);
    return v > 0 ? v : Number.POSITIVE_INFINITY;
  },
  purchases: (i) => getPurchaseCount(i),
  cost_per_purchase: (i) => {
    const v = getCostPerPurchase(i);
    return v > 0 ? v : Number.POSITIVE_INFINITY;
  },
  roas: (i) => getRoas(i),
};

export function buildTreeCols(multiAcct: boolean, extras: string[] = []): TreeCol[] {
  const cols: TreeCol[] = [
    { key: "no", label: "No." },
    { key: "name", label: "名稱", sortKey: (i) => nameRank(i.name) },
  ];
  if (multiAcct) {
    cols.push({ key: "account", label: "帳戶" });
  }
  const enabled = new Set(extras);
  cols.push(
    { key: "status", label: "狀態", sortKey: (i) => statusRank(i.status) },
    { key: "spend", label: "花費", sortKey: (i) => Number(getIns(i).spend) || 0 },
  );
  // 花費+% sits right after 花費. Non-sortable: the value depends on the
  // per-campaign markup %, which the entity-only sortKey signature can't
  // resolve — sorting by raw 花費 (its proxy) would be misleading when
  // campaigns carry different markups, so we leave the header static.
  if (enabled.has("spend_plus")) {
    cols.push({ key: "spend_plus", label: "花費+%", emphasize: true });
  }
  cols.push(
    { key: "impressions", label: "曝光", sortKey: (i) => Number(getIns(i).impressions) || 0 },
    { key: "clicks", label: "點擊", sortKey: (i) => Number(getIns(i).clicks) || 0 },
    { key: "ctr", label: "CTR", sortKey: (i) => Number(getIns(i).ctr) || 0 },
    { key: "cpc", label: "CPC", sortKey: (i) => Number(getIns(i).cpc) || 0 },
    { key: "msg", label: "私訊數", sortKey: (i) => getMsgCount(i) },
    {
      key: "msgcost",
      label: "私訊成本",
      sortKey: (i) => {
        const m = getMsgCount(i);
        if (m <= 0) return Number.POSITIVE_INFINITY;
        return (Number(getIns(i).spend) || 0) / m;
      },
    },
  );
  // Insert opt-in extras AFTER msgcost, BEFORE budget/actions, in the
  // order defined by EXTRA_TREE_COLS (so the picker order is stable
  // regardless of the order the user clicked checkboxes). spend_plus is
  // skipped here — it was already inserted right after 花費 above.
  for (const extra of EXTRA_TREE_COLS) {
    if (extra.key === "spend_plus") continue;
    if (!enabled.has(extra.key)) continue;
    cols.push({
      key: extra.key,
      label: extra.label,
      sortKey: EXTRA_SORT_KEYS[extra.key],
    });
  }
  cols.push({ key: "budget", label: "預算" }, { key: "actions", label: "" });
  return cols;
}
