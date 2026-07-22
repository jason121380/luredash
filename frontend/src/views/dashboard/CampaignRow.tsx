import { useAccounts } from "@/api/hooks/useAccounts";
import { useAdsets } from "@/api/hooks/useAdsets";
import { mutationErrorMessage, useEntityStatusMutation } from "@/api/hooks/useEntityMutations";
import { useNicknames } from "@/api/hooks/useNicknames";
import { Badge } from "@/components/Badge";
import { confirm } from "@/components/ConfirmDialog";
import { FbCampaignLink } from "@/components/FbCampaignLink";
import { Spinner } from "@/components/Spinner";
import { toast } from "@/components/Toast";
import { Toggle } from "@/components/Toggle";
import type { DateConfig } from "@/lib/datePicker";
import { fM, fN, fP } from "@/lib/format";
import { getIns, getMsgCount } from "@/lib/insights";
import { useFinanceStore } from "@/stores/financeStore";
import { useUiStore } from "@/stores/uiStore";
import type { FbCampaign, FbEntityStatus } from "@/types/fb";
import { formatNickname, markupFor } from "@/views/finance/financeData";
import { memo, useEffect, useState } from "react";
import { AdsetRow } from "./AdsetRow";
import type { BudgetModalTarget } from "./BudgetModal";
import { ExtraTreeCells, SpendPlusCell } from "./ExtraTreeCells";
import { ReportModal } from "./ReportModal";

export interface CampaignRowProps {
  campaign: FbCampaign;
  index: number;
  multiAcct: boolean;
  colCount: number;
  date: DateConfig;
  onOpenBudget: (target: BudgetModalTarget) => void;
  extras: string[];
}

/**
 * First-level row — a single FB campaign with lazy-loaded adsets
 * inside an expanded state. Matches the original design lines 1971–2003.
 *
 * Budget column shows either daily_budget or lifetime_budget; if
 * neither is set we display a hint that the budget lives on the
 * adset level (matches legacy `budgetStr(camp, true)`).
 *
 * `React.memo`-wrapped at the bottom of this file. The parent
 * `TreeTable` passes a stable `onOpenBudget` (wrapped in
 * `useCallback` inside `DashboardView`), and `campaign` itself is
 * the same object reference across renders while the cached
 * overview data is unchanged — so the memo short-circuits row
 * re-renders during sort / filter / unrelated expansion.
 */
function CampaignRowInner({
  campaign,
  index,
  multiAcct,
  colCount,
  date,
  onOpenBudget,
  extras,
}: CampaignRowProps) {
  const expanded = useUiStore((s) => s.expandedCamps.includes(campaign.id));
  const toggleCamp = useUiStore((s) => s.toggleCamp);
  const adsetsQuery = useAdsets(campaign.id, date, expanded);
  const mutation = useEntityStatusMutation();
  const accountsQuery = useAccounts();
  const businessId = accountsQuery.data?.find((a) => a.id === campaign._accountId)?.business?.id;
  const [reportOpen, setReportOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<FbEntityStatus | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep — clear optimistic override whenever server status changes
  useEffect(() => {
    setPendingStatus(null);
  }, [campaign.status]);
  const displayStatus = pendingStatus ?? campaign.status;

  const rowMarkups = useFinanceStore((s) => s.rowMarkups);
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);
  const markupPercent = markupFor(campaign.id, rowMarkups, defaultMarkup);
  const showSpendPlus = extras.includes("spend_plus");
  // 店家 · 設計師 nickname (falls back to raw campaign name) — threaded to
  // the creative preview so downloads are named「暱稱 廣告名稱」not the FB
  // CDN gibberish filename.
  const nicknames = useNicknames();
  const campaignLabel =
    campaign.nickname?.trim() || formatNickname(nicknames.data?.[campaign.id]) || campaign.name;

  const ins = getIns(campaign);
  const msgs = getMsgCount(campaign);
  const spend = Number(ins.spend) || 0;

  const onRowClick = () => toggleCamp(campaign.id);

  const onToggleStatus = async (nextChecked: boolean) => {
    const status: FbEntityStatus = nextChecked ? "ACTIVE" : "PAUSED";
    const action = nextChecked ? "開啟" : "暫停";
    const ok = await confirm(`確定要${action}此行銷活動？`);
    if (!ok) return;
    setPendingStatus(status);
    try {
      await mutation.mutateAsync({ kind: "campaign", id: campaign.id, status });
      toast(`已${action}行銷活動`, "success");
    } catch (e) {
      setPendingStatus(null);
      toast(`${action}行銷活動失敗：${mutationErrorMessage(e)}`, "error", 4500);
    }
  };

  const budgetText = campaign.daily_budget
    ? `日 $${fM(campaign.daily_budget)}`
    : campaign.lifetime_budget
      ? `總 $${fM(campaign.lifetime_budget)}`
      : null;

  return (
    <>
      <tr
        className="campaign-row cursor-pointer"
        data-camp={campaign.id}
        onClick={onRowClick}
        aria-expanded={expanded}
      >
        <td className="w-10 text-center text-xs text-gray-300">{index + 1}</td>
        <td>
          <div className="flex max-w-[260px] items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[10px] text-ink"
            >
              {expanded ? "▼" : "▶"}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-[13px] font-semibold"
              title={campaign.name}
            >
              {campaign.name}
            </span>
            <FbCampaignLink
              campaignId={campaign.id}
              accountId={campaign._accountId}
              campaignName={campaign.name}
              businessId={businessId}
            />
          </div>
        </td>
        {multiAcct && (
          <td>
            <span className="text-[11px] text-gray-500">{campaign._accountName}</span>
          </td>
        )}
        <td>
          <Badge status={displayStatus} />
        </td>
        <td className="num">{fM(ins.spend)}</td>
        <SpendPlusCell show={showSpendPlus} spend={spend} markupPercent={markupPercent} />
        <td className="num">{fN(ins.impressions)}</td>
        <td className="num">{fN(ins.clicks)}</td>
        <td className="num">{fP(ins.ctr)}</td>
        <td className="num">{fM(ins.cpc)}</td>
        <td className="num">{msgs > 0 ? fN(msgs) : "—"}</td>
        <td className="num">{msgs > 0 ? `$${fM(spend / msgs)}` : "—"}</td>
        <ExtraTreeCells entity={campaign} extras={extras} />
        <td className="num whitespace-nowrap">
          {budgetText ?? <span className="text-[11px] text-orange-muted">廣告組合預算</span>}
        </td>
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
              onClick={() =>
                onOpenBudget({ kind: "campaign", id: campaign.id, name: campaign.name })
              }
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
            <button
              type="button"
              title="報告"
              aria-label="報告"
              className="cursor-pointer border-0 bg-transparent p-1 text-gray-400 hover:text-orange outline-none"
              onClick={() => setReportOpen(true)}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
            </button>
          </div>
        </td>
      </tr>
      <ReportModal open={reportOpen} onOpenChange={setReportOpen} campaign={campaign} date={date} />
      {expanded && (
        <CampaignAdsets
          query={adsetsQuery}
          colCount={colCount}
          multiAcct={multiAcct}
          date={date}
          onOpenBudget={onOpenBudget}
          campaignName={campaignLabel}
          extras={extras}
          campaignMarkup={markupPercent}
        />
      )}
    </>
  );
}

export const CampaignRow = memo(CampaignRowInner);

function CampaignAdsets({
  query,
  colCount,
  multiAcct,
  date,
  onOpenBudget,
  campaignName,
  extras,
  campaignMarkup,
}: {
  query: ReturnType<typeof useAdsets>;
  colCount: number;
  multiAcct: boolean;
  date: DateConfig;
  onOpenBudget: (target: BudgetModalTarget) => void;
  campaignName: string;
  extras: string[];
  campaignMarkup: number;
}) {
  if (query.isLoading || query.isPending) {
    return (
      <tr className="adset-row">
        <td colSpan={colCount}>
          <div className="flex items-center gap-2 py-3 pl-6 text-xs text-gray-300">
            <Spinner size={14} /> 載入廣告組合...
          </div>
        </td>
      </tr>
    );
  }
  if (query.isError) {
    return (
      <tr className="adset-row">
        <td colSpan={colCount}>
          <div className="py-3 pl-6 text-xs text-red">
            載入廣告組合失敗：{query.error instanceof Error ? query.error.message : "未知錯誤"}
          </div>
        </td>
      </tr>
    );
  }
  const data = query.data ?? [];
  if (data.length === 0) {
    return (
      <tr className="adset-row">
        <td colSpan={colCount}>
          <div className="py-3 pl-12 text-xs text-gray-300">無廣告組合</div>
        </td>
      </tr>
    );
  }
  return (
    <>
      {data.map((adset) => (
        <AdsetRow
          key={adset.id}
          adset={adset}
          multiAcct={multiAcct}
          colCount={colCount}
          date={date}
          onOpenBudget={onOpenBudget}
          campaignName={campaignName}
          extras={extras}
          campaignMarkup={campaignMarkup}
        />
      ))}
    </>
  );
}
