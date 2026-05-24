import { useAccountActivities } from "@/api/hooks/useAccountActivities";
import { Badge } from "@/components/Badge";
import { cn } from "@/lib/cn";
import { fM } from "@/lib/format";
import { useSecurityStore } from "@/stores/securityStore";
import type { FbActivity } from "@/types/fb";
import { useMemo, useState } from "react";
import {
  type SecurityAnomaly,
  anomalyLabel,
  effectiveDailyBudgetCents,
  summariseExtraData,
} from "./securityData";
import type { SecurityRow } from "./securityData";

/**
 * One campaign row inside a day group. Renders the headline campaign
 * fields plus an expandable 編輯紀錄 panel that lazy-loads FB Activity
 * Log entries for that campaign's account and filters to this
 * campaign's id.
 */

const OBJECTIVE_LABELS: Record<string, string> = {
  OUTCOME_TRAFFIC: "流量",
  OUTCOME_AWARENESS: "品牌知名度",
  OUTCOME_ENGAGEMENT: "互動",
  OUTCOME_LEADS: "開發潛在顧客",
  OUTCOME_SALES: "銷售",
  OUTCOME_APP_PROMOTION: "推廣應用程式",
  MESSAGES: "訊息",
  CONVERSIONS: "轉換",
  LINK_CLICKS: "連結點擊",
  BRAND_AWARENESS: "品牌知名度",
  REACH: "觸及人數",
};

function fmtTimeHM(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function fmtCents(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return "—";
  return `$${fM(n / 100)}`;
}

const ANOMALY_CLASS: Record<SecurityAnomaly, string> = {
  deep_night: "bg-orange-bg text-orange",
  weekend: "bg-orange-bg text-orange",
  burst: "bg-red-100 text-red-700",
  high_budget: "bg-red-100 text-red-700",
};

export interface SecurityCampaignRowProps {
  row: SecurityRow;
  /** Name of the FB user who created this campaign (read from the
   * Activity Log's `create_campaign_group` event). Empty when the
   * creator event is missing from the fetched window (e.g. campaign
   * was created before the date range). */
  creator?: string;
  /** Initial value of the expanded state. Set to true for the 待查看
   * tab so the editor's history is visible without an extra click. */
  defaultExpanded?: boolean;
  /** Lower bound for the activities fetch (epoch seconds). Shared with
   * the day-group's date range so we only load activities relevant to
   * the user's filter window. */
  activitiesSince: number;
  /** Upper bound for the activities fetch (epoch seconds). */
  activitiesUntil: number;
}

export function SecurityCampaignRow({
  row,
  creator,
  defaultExpanded,
  activitiesSince,
  activitiesUntil,
}: SecurityCampaignRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const campaign = row.campaign;
  const accountId = campaign._accountId ?? null;
  const isSafe = useSecurityStore((s) => s.safeIds.has(campaign.id));
  const toggleSafe = useSecurityStore((s) => s.toggleSafe);

  // Activity log fetch — shares its React Query cache key with the
  // view-level multi-account fetch, so by the time this row mounts
  // the data is typically already in cache.
  const activitiesQuery = useAccountActivities(
    accountId,
    activitiesSince,
    activitiesUntil,
    expanded,
  );

  const objLabel = campaign.objective
    ? (OBJECTIVE_LABELS[campaign.objective] ?? campaign.objective)
    : "—";

  // Daily budget: prefer campaign-level (CBO); fall back to summed
  // active-adset budgets (ABO). Returns cents.
  const dailyBudgetCents = effectiveDailyBudgetCents(campaign);
  const dailyBudgetIsAggregate = dailyBudgetCents !== null && !campaign.daily_budget;

  // Spend so far in the date-range window. FB insights return spend
  // as a string IN DOLLARS (not cents). Undefined until the full
  // overview query resolves.
  const spendRaw = campaign.insights?.data?.[0]?.spend;
  const spendDollars = spendRaw ? Number(spendRaw) : Number.NaN;
  const spendLabel = Number.isFinite(spendDollars) ? `$${fM(spendDollars)}` : "—";

  const matchedActivities = useMemo<FbActivity[]>(() => {
    if (!activitiesQuery.data) return [];
    return activitiesQuery.data
      .filter((a) => a.object_id === campaign.id)
      .sort((a, b) => {
        const ta = a.event_time ? new Date(a.event_time).getTime() : 0;
        const tb = b.event_time ? new Date(b.event_time).getTime() : 0;
        return tb - ta;
      });
  }, [activitiesQuery.data, campaign.id]);

  return (
    <div className="rounded-lg border border-border bg-white">
      <div className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:gap-3 md:p-3.5">
        <Badge status={campaign.status} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="truncate text-[14px] font-semibold text-ink" title={campaign.name}>
              {campaign.name}
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-[2px] text-[10px] font-semibold text-gray-600">
              新建立
            </span>
            {row.anomalies.map((a) => (
              <span
                key={a}
                className={cn(
                  "rounded-full px-2 py-[2px] text-[10px] font-semibold",
                  ANOMALY_CLASS[a],
                )}
              >
                {anomalyLabel(a)}
              </span>
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
            <span>編號 {campaign.id}</span>
            {campaign._accountName && <span>{campaign._accountName}</span>}
            <span>{objLabel}</span>
            <span>{fmtTimeHM(row.createdAt)} 建立</span>
            <span>
              建立者 <span className="font-semibold text-ink">{creator || "—"}</span>
            </span>
            <span>
              日預算 {fmtCents(dailyBudgetCents)}
              {dailyBudgetIsAggregate && (
                <span className="ml-1 text-[10px] text-gray-300">(廣告組合加總)</span>
              )}
            </span>
            <span>
              已花費 <span className="font-semibold text-ink">{spendLabel}</span>
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 self-start md:self-center">
          <button
            type="button"
            onClick={() => toggleSafe(campaign.id)}
            aria-pressed={isSafe}
            title={isSafe ? "取消標記" : "標記此活動為沒問題"}
            className={cn(
              "rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors",
              isSafe
                ? "border-green-600 bg-green-50 text-green-700 hover:bg-green-100"
                : "border-border bg-white text-gray-500 hover:bg-orange-bg hover:text-orange",
            )}
          >
            {isSafe ? "✓ 已標記安全" : "標記為沒問題"}
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-orange-bg hover:text-orange"
          >
            {expanded ? "收合編輯紀錄" : "編輯紀錄"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border bg-bg/40 px-3 py-2 md:px-3.5">
          {!accountId ? (
            <p className="text-[11px] text-gray-500">無帳戶資訊,無法載入編輯紀錄</p>
          ) : activitiesQuery.isLoading ? (
            <p className="text-[11px] text-gray-500">載入編輯紀錄...</p>
          ) : activitiesQuery.isError ? (
            <p className="text-[11px] text-red-700">
              編輯紀錄載入失敗。FB Activity Log 需要 ads_management 權限。
            </p>
          ) : matchedActivities.length === 0 ? (
            <p className="text-[11px] text-gray-500">此活動在所選日期區間內沒有編輯紀錄</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {matchedActivities.map((a, i) => (
                <ActivityLine key={`${a.event_time ?? ""}-${i}`} activity={a} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityLine({ activity }: { activity: FbActivity }) {
  const when = activity.event_time ? new Date(activity.event_time) : null;
  const whenLabel = when
    ? `${String(when.getMonth() + 1).padStart(2, "0")}/${String(when.getDate()).padStart(2, "0")} ${String(
        when.getHours(),
      ).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
    : "—";
  const what = activity.translated_event_type ?? activity.event_type ?? "—";
  const who = activity.actor_name ?? "—";
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-relaxed">
      <span className="text-gray-500">{whenLabel}</span>
      <span className="font-medium text-ink">{what}</span>
      <span className="text-gray-500">· {who}</span>
      {activity.extra_data && <ActivityExtra raw={activity.extra_data} />}
    </li>
  );
}

function ActivityExtra({ raw }: { raw: string }) {
  const summary = useMemo(() => summariseExtraData(raw), [raw]);
  if (!summary) return null;
  return <span className="text-gray-500">· {summary}</span>;
}
