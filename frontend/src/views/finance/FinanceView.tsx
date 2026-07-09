import { useAccounts } from "@/api/hooks/useAccounts";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { useNicknames } from "@/api/hooks/useNicknames";
import { AcctSidebarToggle } from "@/components/AcctSidebarToggle";
import { Button } from "@/components/Button";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { MobileAccountPicker } from "@/components/MobileAccountPicker";
import { Topbar, TopbarSeparator } from "@/layout/Topbar";
import { toLabel } from "@/lib/datePicker";
import { useAccountsStore } from "@/stores/accountsStore";
import { useFiltersStore } from "@/stores/filtersStore";
import { useFinanceStore } from "@/stores/financeStore";
import { useUiStore } from "@/stores/uiStore";
import type { FbCampaign, FbInsights } from "@/types/fb";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FinanceAccountPanel } from "./FinanceAccountPanel";
import { FinanceTable } from "./FinanceTable";
import {
  buildAccountRows,
  buildFinanceCsv,
  filterFinanceRows,
  sortFinanceRows,
} from "./financeData";

interface OverviewCacheData {
  data?: Record<
    string,
    {
      campaigns?: FbCampaign[];
      insights?: FbInsights | null;
      error?: string | null;
    }
  >;
}

function sameDateConfig(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Finance view (費用中心) — left account panel + toolbar + campaign
 * table with per-row markup calculator and pin-to-top.
 *
 * The "全部帳戶 / single account" mode switch is driven by
 * uiStore.finSelectedAcctIds: empty = all, [id] = single.
 *
 * CSV export builds a string via buildFinanceCsv() and pushes it to
 * the browser via a data URL anchor click (matches legacy).
 */
export function FinanceView() {
  const queryClient = useQueryClient();
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visible = useAccountsStore((s) => s.visibleAccounts)(allAccounts);

  const date = useFiltersStore((s) => s.date.shared);
  const setDate = useFiltersStore((s) => s.setDate);

  const finSelectedAcctIds = useUiStore((s) => s.finSelectedAcctIds);
  const setFinSelectedAcctIds = useUiStore((s) => s.setFinSelectedAcctIds);
  const settingsReady = useUiStore((s) => s.settingsReady);
  const [initialScopeReady, setInitialScopeReady] = useState(false);

  const rowMarkups = useFinanceStore((s) => s.rowMarkups);
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);
  const pinnedIds = useFinanceStore((s) => s.pinnedIds);
  const showNicknames = useFinanceStore((s) => s.showNicknames);
  const setShowNicknames = useFinanceStore((s) => s.setShowNicknames);

  const nicknamesQuery = useNicknames();
  const nicknames = nicknamesQuery.data ?? {};

  const [search, setSearch] = useState("");
  const [hideZero, setHideZero] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    if (visible.length === 0) {
      setInitialScopeReady(true);
      return;
    }
    const currentId = finSelectedAcctIds.length === 1 ? finSelectedAcctIds[0] : null;
    const first = visible[0];
    if (!initialScopeReady && currentId === null && first) {
      setFinSelectedAcctIds([first.id]);
      setInitialScopeReady(true);
      return;
    }
    if (currentId !== null && !visible.some((a) => a.id === currentId)) {
      setFinSelectedAcctIds(first ? [first.id] : []);
    }
    setInitialScopeReady(true);
  }, [finSelectedAcctIds, initialScopeReady, setFinSelectedAcctIds, visible]);

  const selectedId = finSelectedAcctIds.length === 1 ? (finSelectedAcctIds[0] ?? null) : null;
  const queryAccounts = useMemo(() => {
    if (!initialScopeReady) return [];
    if (selectedId === null) return visible;
    return visible.filter((a) => a.id === selectedId);
  }, [initialScopeReady, selectedId, visible]);

  // Single batch request replaces useMultiAccountCampaigns +
  // useMultiAccountInsights. include_archived: true because the
  // Finance table wants every status (matches legacy behavior).
  const overview = useMultiAccountOverview(queryAccounts, date, {
    includeArchived: true,
    source: "finance",
  });

  const cachedAccountData = useMemo(() => {
    const visibleIds = new Set(visible.map((a) => a.id));
    const campaigns: FbCampaign[] = [];
    const insights: Record<string, FbInsights | null> = {};
    const seenCampaignIds = new Set<string>();

    for (const [key, value] of queryClient.getQueriesData<OverviewCacheData>({
      queryKey: ["overview"],
    })) {
      if (!Array.isArray(key)) continue;
      const [, , keyDate, includeArchived, includeAdsets] = key;
      if (includeArchived !== true) continue;
      if (includeAdsets === true) continue;
      if (!sameDateConfig(keyDate, date)) continue;

      const data = value?.data ?? {};
      for (const acc of visible) {
        const bundle = data[acc.id];
        if (!bundle || bundle.error) continue;

        insights[acc.id] = bundle.insights ?? null;
        for (const campaign of bundle.campaigns ?? []) {
          if (seenCampaignIds.has(campaign.id)) continue;
          seenCampaignIds.add(campaign.id);
          campaigns.push({
            ...campaign,
            _accountId: campaign._accountId ?? acc.id,
            _accountName: campaign._accountName ?? acc.name,
          });
        }
      }
    }

    for (const campaign of overview.campaigns) {
      const accountId = campaign._accountId;
      if (!accountId || !visibleIds.has(accountId)) continue;
      if (seenCampaignIds.has(campaign.id)) continue;
      seenCampaignIds.add(campaign.id);
      campaigns.push(campaign);
    }
    for (const [accountId, insight] of Object.entries(overview.insights)) {
      if (visibleIds.has(accountId)) insights[accountId] = insight;
    }

    return { campaigns, insights };
  }, [date, overview.campaigns, overview.insights, queryClient, visible]);

  // Slice campaigns for the right-side table based on selection
  const tableCampaigns = useMemo(() => {
    if (selectedId === null) return overview.campaigns;
    return overview.campaigns.filter((c) => c._accountId === selectedId);
  }, [overview.campaigns, selectedId]);

  // Build left-panel rows (always across ALL visible accounts)
  const accountRows = useMemo(
    () =>
      buildAccountRows(
        visible,
        cachedAccountData.insights,
        cachedAccountData.campaigns,
        rowMarkups,
        defaultMarkup,
      ),
    [visible, cachedAccountData.insights, cachedAccountData.campaigns, rowMarkups, defaultMarkup],
  );

  const onDownloadCsv = () => {
    const filtered = filterFinanceRows(tableCampaigns, hideZero, search, nicknames);
    const sorted = sortFinanceRows(
      filtered,
      { key: null, dir: "desc" },
      pinnedIds,
      rowMarkups,
      defaultMarkup,
      { nicknames, useNicknameForNameSort: showNicknames },
    );
    const csv = buildFinanceCsv({
      rows: sorted,
      defaultMarkup,
      rowMarkups,
      includeAccountColumn: selectedId === null,
      nicknames,
    });
    // Format the filename using the date label so users know which
    // period the export covers.
    const label = toLabel(date).replace(/[/ ~]/g, "_");
    const filename = `財務報表_${label}.csv`;
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Topbar title="費用中心" titleAction={<AcctSidebarToggle />}>
        <div className="flex items-center gap-2 md:gap-3">
          <MobileAccountPicker
            accounts={visible}
            selectedId={selectedId}
            onSelect={(id) => setFinSelectedAcctIds(id ? [id] : [])}
            className="bg-transparent px-0 py-0"
          />
          <TopbarSeparator />
          <Button
            variant="ghost"
            size="sm"
            title="下載 CSV"
            aria-label="下載 CSV"
            onClick={onDownloadCsv}
            className="h-10 w-10 justify-center px-0 md:h-[30px] md:w-[30px]"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="block"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="收款帳戶設定"
            aria-label="收款帳戶設定"
            onClick={() => navigate("/payment-accounts")}
            className="h-10 w-10 justify-center px-0 md:h-[30px] md:w-[30px]"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="block"
            >
              <rect x="2" y="6" width="20" height="13" rx="2" />
              <line x1="2" y1="10" x2="22" y2="10" />
              <line x1="6" y1="15" x2="10" y2="15" />
            </svg>
          </Button>
          <DatePicker value={date} onChange={(cfg) => setDate("shared", cfg)} />
        </div>
      </Topbar>

      <div className="flex min-w-0 items-stretch md:flex-row">
        {/* Desktop sidebar (≥768px) */}
        <div className="hidden md:flex">
          <FinanceAccountPanel
            rows={accountRows}
            selectedId={selectedId}
            onSelect={(id) => setFinSelectedAcctIds(id ? [id] : [])}
          />
        </div>

        <div className="min-w-0 flex-1 px-3 pt-3 md:px-4 md:pt-4">
          {/* Rounded card wrap — sized to content. The parent column
              scrolls as one unit so no blank space below the last row. */}
          <div className="mb-3 flex flex-col overflow-hidden rounded-2xl border border-border md:mb-4">
            <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-t-2xl border-b border-border bg-white px-3 py-2.5 md:gap-2.5 md:px-5">
              <input
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="搜尋活動名稱..."
                className="h-10 min-w-[140px] flex-1 rounded-lg border-[1.5px] border-border px-3 text-[13px] outline-none focus:border-orange md:h-8 md:px-2.5"
              />
              <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-gray-500">
                <input
                  type="checkbox"
                  className="custom-cb"
                  checked={showNicknames}
                  onChange={(e) => setShowNicknames(e.currentTarget.checked)}
                />
                顯示暱稱
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-gray-500">
                <input
                  type="checkbox"
                  className="custom-cb"
                  checked={hideZero}
                  onChange={(e) => setHideZero(e.currentTarget.checked)}
                />
                有花費
              </label>
            </div>

            <div className="w-full overflow-x-auto">
              {!settingsReady ? (
                <LoadingState title="載入財務資料中..." />
              ) : visible.length === 0 ? (
                <EmptyState>請先在設定中啟用廣告帳戶</EmptyState>
              ) : !initialScopeReady ? (
                <LoadingState title="準備帳戶中..." />
              ) : overview.isLoading || overview.insightsPending ? (
                <LoadingState title="載入財務資料中..." />
              ) : (
                <FinanceTable
                  campaigns={tableCampaigns}
                  multiAcct={selectedId === null}
                  search={search}
                  hideZero={hideZero}
                  date={date}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
