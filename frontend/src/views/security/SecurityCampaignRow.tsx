import { useAccountActivities } from "@/api/hooks/useAccountActivities";
import { Badge } from "@/components/Badge";
import { cn } from "@/lib/cn";
import { fM } from "@/lib/format";
import type { FbActivity } from "@/types/fb";
import { useMemo, useState } from "react";
import { type SecurityAnomaly, anomalyLabel } from "./securityData";
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

function fmtDailyBudget(raw: string | undefined): string {
  if (!raw) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "—";
  // FB returns budget in minor units (cents). The dashboard divides
  // by 100 for display; mirror that here.
  return `$${fM(n / 100)}`;
}

const ANOMALY_CLASS: Record<SecurityAnomaly, string> = {
  deep_night: "bg-orange-bg text-orange",
  weekend: "bg-orange-bg text-orange",
  burst: "bg-red-100 text-red-700",
};

export interface SecurityCampaignRowProps {
  row: SecurityRow;
  /** Lower bound for the activities fetch (epoch seconds). Shared with
   * the day-group's date range so we only load activities relevant to
   * the user's filter window. */
  activitiesSince: number;
  /** Upper bound for the activities fetch (epoch seconds). */
  activitiesUntil: number;
}

export function SecurityCampaignRow({
  row,
  activitiesSince,
  activitiesUntil,
}: SecurityCampaignRowProps) {
  const [expanded, setExpanded] = useState(false);
  const campaign = row.campaign;
  const accountId = campaign._accountId ?? null;

  const activitiesQuery = useAccountActivities(
    accountId,
    activitiesSince,
    activitiesUntil,
    expanded,
  );

  const objLabel = campaign.objective
    ? (OBJECTIVE_LABELS[campaign.objective] ?? campaign.objective)
    : "—";

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
            <span>日預算 {fmtDailyBudget(campaign.daily_budget)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 self-start rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-gray-500 hover:bg-orange-bg hover:text-orange md:self-center"
        >
          {expanded ? "收合編輯紀錄" : "編輯紀錄"}
        </button>
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
  const parsed = useMemo(() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, [raw]);
  if (!parsed || typeof parsed !== "object") return null;
  const entries = Object.entries(parsed as Record<string, unknown>).slice(0, 4);
  if (entries.length === 0) return null;
  return (
    <span className="text-gray-500">
      ·{" "}
      {entries
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(" / ")}
    </span>
  );
}
