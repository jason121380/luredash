import { useAccounts } from "@/api/hooks/useAccounts";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { AcctSidebarToggle } from "@/components/AcctSidebarToggle";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { MobileAccountPicker } from "@/components/MobileAccountPicker";
import { Topbar, TopbarSeparator } from "@/layout/Topbar";
import { useAccountsStore } from "@/stores/accountsStore";
import { useFiltersStore } from "@/stores/filtersStore";
import { useUiStore } from "@/stores/uiStore";
import { useEffect, useMemo, useState } from "react";
import { AlertAccountPanel } from "./AlertAccountPanel";
import { AlertCard } from "./AlertCard";
import { computeAlertBuckets } from "./alertsData";

/**
 * Alerts view — 240px account panel + 3 side-by-side cards
 * (私訊成本過高 / CPC 過高 / 頻次過高) with per-card sort and
 * keyword filter.
 *
 * Ported from the original design lines 2874–3148 + view markup
 * at lines 1008–1030.
 */
export function AlertsView() {
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visibleAll = useAccountsStore((s) => s.visibleAccounts)(allAccounts);

  const selectedAcctId = useUiStore((s) => s.alertSelectedAcctId);
  const setSelectedAcctId = useUiStore((s) => s.setAlertSelectedAcctId);
  const settingsReady = useUiStore((s) => s.settingsReady);
  const [initialScopeReady, setInitialScopeReady] = useState(false);

  const date = useFiltersStore((s) => s.date.shared);
  const setDate = useFiltersStore((s) => s.setDate);

  useEffect(() => {
    if (visibleAll.length === 0) {
      setInitialScopeReady(true);
      return;
    }
    const first = visibleAll[0];
    if (!initialScopeReady && selectedAcctId === null && first) {
      setSelectedAcctId(first.id);
      setInitialScopeReady(true);
      return;
    }
    if (selectedAcctId !== null && !visibleAll.some((a) => a.id === selectedAcctId)) {
      setSelectedAcctId(first?.id ?? null);
    }
    setInitialScopeReady(true);
  }, [initialScopeReady, selectedAcctId, setSelectedAcctId, visibleAll]);

  const queryAccounts = useMemo(() => {
    if (!initialScopeReady) return [];
    if (selectedAcctId === null) return visibleAll;
    return visibleAll.filter((a) => a.id === selectedAcctId);
  }, [initialScopeReady, selectedAcctId, visibleAll]);

  // Fetch only the current account by default. The "全部帳戶" row is
  // still available, but it now requires an explicit user action.
  const overview = useMultiAccountOverview(queryAccounts, date, {
    // 警示列表只需要當前可處理的活動。includeArchived=true 會讓
    // 後端對 /campaigns 加上 archived/deleted effective_status,
    // 很多帳戶會被 FB 回 code=100 Invalid parameter;雖然後端會
    // fallback,但會在工程模式留下大量「參數錯」並浪費 BUCU。
    includeArchived: false,
    source: "alerts",
  });

  const scopedCampaigns = useMemo(() => {
    if (selectedAcctId === null) return overview.campaigns;
    return overview.campaigns.filter((c) => c._accountId === selectedAcctId);
  }, [overview.campaigns, selectedAcctId]);

  const buckets = useMemo(() => computeAlertBuckets(scopedCampaigns), [scopedCampaigns]);

  const businessIdForCampaign = (accountId: string | undefined) => {
    if (!accountId) return undefined;
    return allAccounts.find((a) => a.id === accountId)?.business?.id;
  };

  return (
    <>
      <Topbar title="警示列表" titleAction={<AcctSidebarToggle />}>
        <div className="flex items-center gap-2 md:gap-3">
          <MobileAccountPicker
            accounts={visibleAll}
            selectedId={selectedAcctId}
            onSelect={setSelectedAcctId}
            className="bg-transparent px-0 py-0"
          />
          <TopbarSeparator />
          <DatePicker value={date} onChange={(cfg) => setDate("shared", cfg)} />
        </div>
      </Topbar>

      <div className="flex min-w-0 items-stretch md:flex-row">
        {/* Desktop sidebar (≥768px) */}
        <div className="hidden md:flex">
          <AlertAccountPanel
            accounts={visibleAll}
            selectedAccountId={selectedAcctId}
            onSelect={setSelectedAcctId}
          />
        </div>

        <div className="min-w-0 flex-1 p-3 md:p-5">
          {!settingsReady ? (
            <LoadingState
              title="分析廣告資料中..."
              loaded={overview.loadedCount}
              total={overview.totalCount}
            />
          ) : visibleAll.length === 0 ? (
            <EmptyState>請先在設定中啟用廣告帳戶</EmptyState>
          ) : !initialScopeReady ? (
            <LoadingState title="準備帳戶中..." />
          ) : overview.isLoading || overview.insightsPending ? (
            <LoadingState
              title="分析廣告資料中..."
              loaded={overview.loadedCount}
              total={overview.totalCount}
            />
          ) : overview.campaigns.length === 0 ? (
            <EmptyState>無廣告資料可分析</EmptyState>
          ) : (
            <div className="grid items-start gap-3 md:grid-cols-[repeat(auto-fit,minmax(280px,1fr))] md:gap-3.5">
              <AlertCard
                cardKey="msg"
                title="私訊成本過高"
                description="私訊成本 > $200"
                entries={buckets.msg}
                filterLabel="只顯示標題含私訊"
                businessIdForCampaign={businessIdForCampaign}
              />
              <AlertCard
                cardKey="cpc"
                title="CPC 過高"
                description="示警 >$4 ／ 過高 >$5"
                entries={buckets.cpc}
                filterLabel="隱藏標題含私訊"
                businessIdForCampaign={businessIdForCampaign}
              />
              <AlertCard
                cardKey="freq"
                title="頻次過高"
                description="示警 >4 ／ 過高 >5"
                entries={buckets.freq}
                filterLabel={null}
                businessIdForCampaign={businessIdForCampaign}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
