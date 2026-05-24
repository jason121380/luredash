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

export type SecurityAnomaly = "deep_night" | "weekend" | "burst";

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
};

export function anomalyLabel(a: SecurityAnomaly): string {
  return ANOMALY_LABELS[a];
}
