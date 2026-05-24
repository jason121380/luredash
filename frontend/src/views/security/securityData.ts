import type { DateConfig } from "@/lib/datePicker";
import { resolveRange } from "@/lib/datePicker";
import type { FbCampaign } from "@/types/fb";

/**
 * Pure logic for the 安全監控 view. Two responsibilities:
 *
 *   1. Filter the full campaign list by `created_time` falling inside
 *      the user-picked date range, then group by creation day.
 *   2. Tag each campaign with anomaly badges:
 *        - 深夜創建: created between 00:00 and 05:59 local time
 *        - 週末創建: created on Saturday or Sunday
 *        - 短時間高頻: ≥ 5 campaigns created in the same account
 *          within a 2-hour rolling window
 *
 * Kept as pure functions so the view component stays slim and the
 * detection logic is unit-tested without rendering.
 */

export type SecurityAnomaly = "deep_night" | "weekend" | "burst" | "high_budget";

/** Daily budget threshold — RAW FB value (same scale as
 * dashboard's `fM(campaign.daily_budget)`). FB returns budget as
 * integer in the account's currency; no /100 transformation. */
export const HIGH_DAILY_BUDGET = 2000;

/** Return the effective daily budget for a campaign in the RAW FB
 * value (same scale dashboard renders directly via `fM`).
 *
 *   - CBO: campaign.daily_budget is set. Use it.
 *   - ABO: campaign budget is empty; sum ACTIVE / PAUSED adsets'
 *     daily_budget so the security view can still surface a total.
 *   - Neither set: return null.
 *
 * Returns `null` rather than `0` so callers can distinguish "no
 * budget data" from "$0 budget".
 */
export function effectiveDailyBudget(c: FbCampaign): number | null {
  const campaignBudget = Number(c.daily_budget);
  if (Number.isFinite(campaignBudget) && campaignBudget > 0) {
    return campaignBudget;
  }
  const adsets = c.adsets?.data ?? [];
  let sum = 0;
  let any = false;
  for (const a of adsets) {
    // Archived / deleted adsets aren't actively spending — skip.
    if (a.status === "ARCHIVED" || a.status === "DELETED") continue;
    const v = Number(a.daily_budget);
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

export interface SecurityRow {
  campaign: FbCampaign;
  createdAt: Date;
  anomalies: SecurityAnomaly[];
}

export interface SecurityDay {
  /** YYYY-MM-DD local date key. */
  dateKey: string;
  /** Sort key: epoch ms of midnight on the day, descending. */
  epoch: number;
  rows: SecurityRow[];
}

/** Format Date as YYYY-MM-DD (local). Mirrors `lib/datePicker.fmtDate`
 * but inlined to keep this module dependency-free for testing. */
function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse an FB ISO timestamp ("2026-05-22T15:30:00+0000") into a Date.
 * Returns null if missing / malformed. */
export function parseFbTime(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date range bounds in epoch ms, inclusive of the entire `end` day. */
export function resolveBounds(date: DateConfig, now = new Date()): { from: number; to: number } {
  const range = resolveRange(date, now);
  const [sy, sm, sd] = range.start.split("-").map(Number);
  const [ey, em, ed] = range.end.split("-").map(Number);
  const from = new Date(sy ?? 1970, (sm ?? 1) - 1, sd ?? 1, 0, 0, 0, 0).getTime();
  const to = new Date(ey ?? 1970, (em ?? 1) - 1, ed ?? 1, 23, 59, 59, 999).getTime();
  return { from, to };
}

/** Detect burst windows: any campaign that sits inside a rolling
 * 2-hour window with ≥ 5 campaigns in the same account is tagged.
 * Returns the set of campaign ids to flag. */
function detectBursts(rows: SecurityRow[]): Set<string> {
  const flagged = new Set<string>();
  const byAccount = new Map<string, SecurityRow[]>();
  for (const r of rows) {
    const aid = r.campaign._accountId ?? "_";
    const list = byAccount.get(aid);
    if (list) list.push(r);
    else byAccount.set(aid, [r]);
  }
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const THRESHOLD = 5;
  for (const list of byAccount.values()) {
    if (list.length < THRESHOLD) continue;
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    // Sliding window: for each i, find the largest j such that
    // sorted[j].createdAt - sorted[i].createdAt <= 2h. If j - i + 1
    // ≥ threshold, every row in [i..j] is in a burst.
    let j = 0;
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i];
      if (!start) continue;
      if (j < i) j = i;
      while (j + 1 < sorted.length) {
        const next = sorted[j + 1];
        if (!next) break;
        if (next.createdAt.getTime() - start.createdAt.getTime() > TWO_HOURS) break;
        j++;
      }
      if (j - i + 1 >= THRESHOLD) {
        for (let k = i; k <= j; k++) {
          const id = sorted[k]?.campaign.id;
          if (id) flagged.add(id);
        }
      }
    }
  }
  return flagged;
}

/** Filter `campaigns` to those whose `created_time` falls inside the
 * user-picked range, attach anomaly badges, and group by creation
 * day (descending). */
export function buildSecurityDays(
  campaigns: FbCampaign[],
  date: DateConfig,
  now = new Date(),
): SecurityDay[] {
  const { from, to } = resolveBounds(date, now);
  const rows: SecurityRow[] = [];
  for (const c of campaigns) {
    const created = parseFbTime(c.created_time);
    if (!created) continue;
    const ts = created.getTime();
    if (ts < from || ts > to) continue;
    const hour = created.getHours();
    const weekday = created.getDay();
    const anomalies: SecurityAnomaly[] = [];
    if (hour < 6) anomalies.push("deep_night");
    if (weekday === 0 || weekday === 6) anomalies.push("weekend");
    const effective = effectiveDailyBudget(c);
    if (effective !== null && effective > HIGH_DAILY_BUDGET) {
      anomalies.push("high_budget");
    }
    rows.push({ campaign: c, createdAt: created, anomalies });
  }
  // Burst is a cross-row signal — compute it after the per-row pass.
  const burstIds = detectBursts(rows);
  for (const r of rows) {
    if (burstIds.has(r.campaign.id)) r.anomalies.push("burst");
  }
  // Group by local day and sort within each day by createdAt desc.
  const groups = new Map<string, SecurityRow[]>();
  for (const r of rows) {
    const key = dateKey(r.createdAt);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const days: SecurityDay[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const [y, m, d] = key.split("-").map(Number);
    const epoch = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
    days.push({ dateKey: key, epoch, rows: list });
  }
  days.sort((a, b) => b.epoch - a.epoch);
  return days;
}

const WEEKDAY_LABELS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

/** Render a day key as "5月23日 (週六)". */
export function formatDayLabel(dateKey: string): string {
  const [, m, d] = dateKey.split("-").map(Number);
  const [yy, mm, dd] = dateKey.split("-").map(Number);
  const dt = new Date(yy ?? 1970, (mm ?? 1) - 1, dd ?? 1);
  return `${m}月${d}日 (${WEEKDAY_LABELS[dt.getDay()] ?? ""})`;
}

const ANOMALY_LABELS: Record<SecurityAnomaly, string> = {
  deep_night: "深夜創建",
  weekend: "週末創建",
  burst: "短時間高頻",
  high_budget: `日預算 > $${HIGH_DAILY_BUDGET}`,
};

export function anomalyLabel(a: SecurityAnomaly): string {
  return ANOMALY_LABELS[a];
}

// ── Activity Log extra_data formatter ───────────────────────────
//
// FB's Activity Log emits an `extra_data` JSON string whose shape
// varies by event_type. The most common cases for our users:
//
//   {"type":"run_status","old_value":"進行中","new_value":"暫停",
//    "run_status":{"old_value":1,"new_value":15}}
//   {"type":"run_status",...,"with_issue_code":4134001}   (Meta 政策)
//   {"type":"composite_data","new_value":{"type":"payment_amount",
//    "currency":"TWD","new_value":692,"additional_value":"單日"}}
//   {"type":"daily_budget","old_value":"10000","new_value":"20000"}
//
// The formatter recurses into composite_data, formats money types as
// currency, and tacks on a plain-Chinese explanation for `with_issue_code`
// (Meta's automated policy flag) since the raw integer alone is
// meaningless to operators.

const CHANGE_TYPE_LABELS: Record<string, string> = {
  run_status: "狀態",
  daily_budget: "日預算",
  lifetime_budget: "總預算",
  bid_amount: "出價",
  bid_cap: "出價上限",
  name: "名稱",
  targeting: "受眾",
  start_time: "開始時間",
  end_time: "結束時間",
  campaign_objective: "活動目標",
  campaign_budget_optimization: "活動預算最佳化",
  bid_strategy: "出價策略",
  pacing_type: "投放節奏",
};

const MONEY_TYPES = new Set(["daily_budget", "lifetime_budget", "bid_amount", "bid_cap"]);

function fmtMoney(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  // FB stores budgets in cents.
  return `$${Math.round(n / 100).toLocaleString("en-US")}`;
}

function fmtValue(v: unknown, isMoney: boolean): string {
  if (v === undefined || v === null || v === "") return "—";
  if (isMoney) return fmtMoney(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Translate Meta's `with_issue_code` integer into a plain-Chinese
 * hint. We don't have a published mapping table — anything we don't
 * know about gets a generic "Meta 政策審查" label so the operator
 * knows it's an automated Meta-side action rather than a user edit. */
function describeIssueCode(code: unknown): string {
  // 4133*** and 4134*** are the policy-violation family in our
  // observed data. Without an official lookup, just mark it.
  return `Meta 政策審查 (代碼 ${String(code)}) — 請至廣告管理員查看完整原因`;
}

/** Recursive summariser. Returns a sentence describing the change,
 * or null if the shape is unrecognised. */
function summariseChangeObj(obj: Record<string, unknown>): string | null {
  const type = typeof obj.type === "string" ? obj.type : null;
  const oldVal = obj.old_value;
  const newVal = obj.new_value;

  // composite_data wraps a nested change — recurse into whichever
  // side has the nested object.
  if (type === "composite_data") {
    const nested =
      newVal && typeof newVal === "object"
        ? (newVal as Record<string, unknown>)
        : oldVal && typeof oldVal === "object"
          ? (oldVal as Record<string, unknown>)
          : null;
    if (nested) return summariseChangeObj(nested);
    return null;
  }

  // payment_amount: budget/charge set on creation. Shape:
  //   {type:"payment_amount", currency:"TWD", new_value:692,
  //    additional_value:"單日"}
  if (type === "payment_amount") {
    const currency = String(obj.currency ?? "");
    const amount = fmtMoney(newVal ?? oldVal);
    const period = String(obj.additional_value ?? "");
    const periodLabel = period ? `${period} ` : "";
    return `預算 ${periodLabel}${amount}${currency ? ` ${currency}` : ""}`;
  }

  // Generic change with old/new — produces "標籤:舊 → 新".
  if (oldVal !== undefined || newVal !== undefined) {
    const label = type ? (CHANGE_TYPE_LABELS[type] ?? type) : "變更";
    const isMoney = type ? MONEY_TYPES.has(type) : false;
    let result = `${label}:${fmtValue(oldVal, isMoney)} → ${fmtValue(newVal, isMoney)}`;
    if (obj.with_issue_code !== undefined) {
      result += ` · ${describeIssueCode(obj.with_issue_code)}`;
    }
    return result;
  }

  // No old/new but has issue code (rare): still surface it.
  if (obj.with_issue_code !== undefined) {
    return describeIssueCode(obj.with_issue_code);
  }
  return null;
}

/** Convert FB Activity Log `extra_data` JSON string into a plain
 * Chinese sentence. Returns null when the shape is empty or
 * unrecognisable. */
export function summariseExtraData(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  return summariseChangeObj(parsed as Record<string, unknown>);
}
