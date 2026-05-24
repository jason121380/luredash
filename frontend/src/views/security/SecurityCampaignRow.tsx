import { useAccountActivities } from "@/api/hooks/useAccountActivities";
import { useAccountAssignedUsers } from "@/api/hooks/useAccountAssignedUsers";
import { Badge } from "@/components/Badge";
import { cn } from "@/lib/cn";
import { fM } from "@/lib/format";
import { useSecurityStore } from "@/stores/securityStore";
import type { FbActivity } from "@/types/fb";
import { useMemo, useState } from "react";
import { type SecurityAnomaly, anomalyLabel, summariseExtraData } from "./securityData";
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
  high_budget: "bg-red-100 text-red-700",
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
  const isSafe = useSecurityStore((s) => s.safeIds.has(campaign.id));
  const toggleSafe = useSecurityStore((s) => s.toggleSafe);

  const activitiesQuery = useAccountActivities(
    accountId,
    activitiesSince,
    activitiesUntil,
    expanded,
  );
  const assignedUsersQuery = useAccountAssignedUsers(accountId, expanded);

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
            {/* Baseline reason badge — every campaign in this view is
                here because it was newly created in the chosen window.
                Showing it explicitly makes "no anomaly badges" read as
                "normal new creation" rather than "missing label". */}
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
            <span>日預算 {fmtDailyBudget(campaign.daily_budget)}</span>
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
          <RosterStatus
            isLoading={assignedUsersQuery.isLoading}
            isError={assignedUsersQuery.isError}
            size={assignedUsersQuery.data?.size ?? 0}
          />
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
                <ActivityLine
                  key={`${a.event_time ?? ""}-${i}`}
                  activity={a}
                  assignedUsers={assignedUsersQuery.data}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

interface ActivityLineProps {
  activity: FbActivity;
  /** Set of FB user ids permitted on this account. `undefined` while
   * loading — don't flag until we know the roster. */
  assignedUsers: Set<string> | undefined;
}

function ActivityLine({ activity, assignedUsers }: ActivityLineProps) {
  const when = activity.event_time ? new Date(activity.event_time) : null;
  const whenLabel = when
    ? `${String(when.getMonth() + 1).padStart(2, "0")}/${String(when.getDate()).padStart(2, "0")} ${String(
        when.getHours(),
      ).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
    : "—";
  const what = activity.translated_event_type ?? activity.event_type ?? "—";
  const who = activity.actor_name ?? "—";
  // Only flag when we have a non-empty roster AND the actor isn't on
  // it. Empty roster (FB returned 0 or the call errored) means we
  // don't know who's authorised — don't show false positives.
  const isExternalActor =
    assignedUsers !== undefined &&
    assignedUsers.size > 0 &&
    !!activity.actor_id &&
    !assignedUsers.has(activity.actor_id);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-relaxed">
      <span className="text-gray-500">{whenLabel}</span>
      <span className="font-medium text-ink">{what}</span>
      <span className="text-gray-500">· {who}</span>
      {isExternalActor && (
        <span className="rounded-full bg-red-100 px-1.5 py-[1px] text-[10px] font-semibold text-red-700">
          非 BM 成員
        </span>
      )}
      {activity.extra_data && <ActivityExtra raw={activity.extra_data} />}
    </li>
  );
}

function RosterStatus({
  isLoading,
  isError,
  size,
}: {
  isLoading: boolean;
  isError: boolean;
  size: number;
}) {
  if (isLoading) {
    return <p className="mb-1.5 text-[10px] text-gray-500">載入 BM 名單...</p>;
  }
  if (isError || size === 0) {
    return (
      <p className="mb-1.5 text-[10px] text-orange">
        BM 名單載入不到 — 跳過「非 BM 成員」檢查(可能是帳戶非 BM-managed 或 token 缺
        business_management 權限)
      </p>
    );
  }
  return <p className="mb-1.5 text-[10px] text-gray-500">BM 名單:{size} 人 · 比對中</p>;
}

function ActivityExtra({ raw }: { raw: string }) {
  const summary = useMemo(() => summariseExtraData(raw), [raw]);
  if (!summary) return null;
  return <span className="text-gray-500">· {summary}</span>;
}
