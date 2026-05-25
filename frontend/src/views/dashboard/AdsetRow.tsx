import { friendlyApiError } from "@/api/client";
import { useCreatives } from "@/api/hooks/useCreatives";
import { mutationErrorMessage, useEntityStatusMutation } from "@/api/hooks/useEntityMutations";
import { Badge } from "@/components/Badge";
import { confirm } from "@/components/ConfirmDialog";
import { Spinner } from "@/components/Spinner";
import { toast } from "@/components/Toast";
import { Toggle } from "@/components/Toggle";
import type { DateConfig } from "@/lib/datePicker";
import { fM, fN, fP } from "@/lib/format";
import { getIns, getMsgCount } from "@/lib/insights";
import { useUiStore } from "@/stores/uiStore";
import type { FbAdset, FbEntityStatus } from "@/types/fb";
import { memo, useEffect, useState } from "react";
import type { BudgetModalTarget } from "./BudgetModal";
import { CreativeRow } from "./CreativeRow";
import { ExtraTreeCells } from "./ExtraTreeCells";

export interface AdsetRowProps {
  adset: FbAdset;
  multiAcct: boolean;
  colCount: number;
  date: DateConfig;
  onOpenBudget: (target: BudgetModalTarget) => void;
  /** Forwarded down to each CreativeRow → CreativePreviewModal so
   *  downloaded files inherit the parent campaign's name. */
  campaignName?: string;
  extras: string[];
}

/**
 * Second-level row — a single adset.
 *
 * Self-contained fetch behavior: when the user expands this row we
 * call `useCreatives(adsetId, date, true)` which fires the lazy
 * query. React rules-of-hooks are respected because each AdsetRow is
 * its own component with a stable hook order.
 *
 * `React.memo`-wrapped at the bottom — the parent `CampaignRow`
 * passes an `onOpenBudget` handler that's itself stabilised via
 * `useCallback` in `DashboardView`, and the `adset` object stays
 * identity-stable across renders from the React Query cache.
 */
function AdsetRowInner({
  adset,
  multiAcct,
  colCount,
  date,
  onOpenBudget,
  campaignName,
  extras,
}: AdsetRowProps) {
  const expanded = useUiStore((s) => s.expandedAdsets.includes(adset.id));
  const toggleAdset = useUiStore((s) => s.toggleAdset);
  const creativesQuery = useCreatives(adset.id, date, expanded);
  const mutation = useEntityStatusMutation();
  const [pendingStatus, setPendingStatus] = useState<FbEntityStatus | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep — clear optimistic override whenever server status changes
  useEffect(() => {
    setPendingStatus(null);
  }, [adset.status]);
  const displayStatus = pendingStatus ?? adset.status;

  const ins = getIns(adset);
  const msgs = getMsgCount(adset);
  const spend = Number(ins.spend) || 0;

  const onRowClick = () => toggleAdset(adset.id);

  const onToggleStatus = async (nextChecked: boolean) => {
    const status: FbEntityStatus = nextChecked ? "ACTIVE" : "PAUSED";
    const action = nextChecked ? "開啟" : "暫停";
    const ok = await confirm(`確定要${action}此廣告組合？`);
    if (!ok) return;
    setPendingStatus(status);
    try {
      await mutation.mutateAsync({ kind: "adset", id: adset.id, status });
      toast(`已${action}廣告組合`, "success");
    } catch (e) {
      setPendingStatus(null);
      toast(`${action}廣告組合失敗：${mutationErrorMessage(e)}`, "error", 4500);
    }
  };

  const budgetText = adset.daily_budget
    ? `日 $${fM(adset.daily_budget)}`
    : adset.lifetime_budget
      ? `總 $${fM(adset.lifetime_budget)}`
      : "—";

  return (
    <>
      <tr
        className="adset-row cursor-pointer"
        data-adset={adset.id}
        onClick={onRowClick}
        aria-expanded={expanded}
      >
        <td />
        <td>
          <div className="flex max-w-[240px] items-center gap-1.5 pl-6">
            <span
              aria-hidden="true"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[10px] text-ink"
            >
              {expanded ? "▼" : "▶"}
            </span>
            <span className="truncate text-[13px] font-medium" title={adset.name}>
              {adset.name}
            </span>
          </div>
        </td>
        {multiAcct && <td />}
        <td>
          <Badge status={displayStatus} />
        </td>
        <td className="num">{fM(ins.spend)}</td>
        <td className="num">{fN(ins.impressions)}</td>
        <td className="num">{fN(ins.clicks)}</td>
        <td className="num">{fP(ins.ctr)}</td>
        <td className="num">{fM(ins.cpc)}</td>
        <td className="num">{msgs > 0 ? fN(msgs) : "—"}</td>
        <td className="num">{msgs > 0 ? `$${fM(spend / msgs)}` : "—"}</td>
        <ExtraTreeCells entity={adset} extras={extras} />
        <td className="num whitespace-nowrap">{budgetText}</td>
        <td onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5">
            <Toggle
              checked={displayStatus === "ACTIVE"}
              disabled={mutation.isPending}
              onChange={(e) => {
                void onToggleStatus(e.currentTarget.checked);
              }}
            />
            <button
              type="button"
              title="調整預算"
              aria-label="調整預算"
              className="cursor-pointer border-0 bg-transparent p-1 text-gray-400 hover:text-orange outline-none"
              onClick={() => onOpenBudget({ kind: "adset", id: adset.id, name: adset.name })}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <AdsetCreatives
          query={creativesQuery}
          colCount={colCount}
          multiAcct={multiAcct}
          campaignName={campaignName}
          extras={extras}
        />
      )}
    </>
  );
}

export const AdsetRow = memo(AdsetRowInner);

function AdsetCreatives({
  query,
  colCount,
  multiAcct,
  campaignName,
  extras,
}: {
  query: ReturnType<typeof useCreatives>;
  colCount: number;
  multiAcct: boolean;
  campaignName?: string;
  extras: string[];
}) {
  if (query.isLoading || query.isPending) {
    return (
      <tr className="creative-row">
        <td colSpan={colCount} className="bg-orange-soft">
          <div className="flex items-center gap-2.5 pl-[72px] pr-6 py-3 text-[13px] font-semibold text-orange">
            <Spinner size={16} /> 載入廣告中...
          </div>
        </td>
      </tr>
    );
  }
  if (query.isError) {
    return (
      <tr className="creative-row">
        <td colSpan={colCount} className="bg-orange-bg">
          <div className="flex flex-wrap items-center gap-3 pl-[72px] pr-6 py-3 text-[13px]">
            <span className="font-semibold text-red">
              無法載入廣告:{friendlyApiError(query.error)}
            </span>
            <button
              type="button"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              className="rounded-md border border-red/40 bg-white px-2.5 py-1 text-[12px] font-semibold text-red hover:bg-red/5 disabled:opacity-50"
            >
              {query.isFetching ? "重試中…" : "重試"}
            </button>
          </div>
        </td>
      </tr>
    );
  }
  const data = query.data ?? [];
  if (data.length === 0) {
    return (
      <tr className="creative-row">
        <td colSpan={colCount} className="bg-orange-soft">
          <div className="pl-[72px] pr-6 py-3 text-[13px] font-medium text-gray-500">
            此廣告組合下沒有廣告
          </div>
        </td>
      </tr>
    );
  }
  return (
    <>
      {data.map((creative) => (
        <CreativeRow
          key={creative.id}
          creative={creative}
          multiAcct={multiAcct}
          campaignName={campaignName}
          extras={extras}
        />
      ))}
    </>
  );
}
