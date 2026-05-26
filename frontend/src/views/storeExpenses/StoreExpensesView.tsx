import { useAccounts } from "@/api/hooks/useAccounts";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { useNicknames } from "@/api/hooks/useNicknames";
import { Button } from "@/components/Button";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { toast } from "@/components/Toast";
import { Topbar } from "@/layout/Topbar";
import { cn } from "@/lib/cn";
import { toLabel } from "@/lib/datePicker";
import { fM } from "@/lib/format";
import { useAccountsStore } from "@/stores/accountsStore";
import { useFiltersStore } from "@/stores/filtersStore";
import { useFinanceStore } from "@/stores/financeStore";
import { useUiStore } from "@/stores/uiStore";
import { useMemo, useState } from "react";
import {
  type DesignerBreakdown,
  type StoreSortKey,
  type StoreSortState,
  buildStoreRows,
  filterStoreRows,
  sortStoreRows,
} from "./storeExpensesData";

/** 會計科目固定值 — 此頁所有列都填這兩個 */
const SUBJECT = "代收轉付";
const SUB_SUBJECT = "廣告代操";

/** 設計師欄純文字版本(Excel 用):「name $1,234、name $567」 */
function formatDesignersText(designers: DesignerBreakdown[]): string {
  if (designers.length === 0) return "—";
  return designers.map((d) => `${d.name} $${fM(d.spendPlus)}`).join("、");
}

/**
 * 店家花費 — aggregates spend+markup across ALL enabled ad accounts,
 * grouped by 店家 (campaign nickname's store field). Date range
 * picker top-right; Excel export top-right. Campaigns without a
 * store nickname are excluded — the page's whole purpose is to
 * surface per-store spending, so untagged campaigns have no row to
 * fall into.
 *
 * Aggregation reuses the Finance view's per-row markup overrides +
 * defaultMarkup, so 花費+% here always matches the Finance table's
 * sum across the same set of campaigns.
 */
export function StoreExpensesView() {
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visible = useAccountsStore((s) => s.visibleAccounts)(allAccounts);

  const date = useFiltersStore((s) => s.date.shared);
  const setDate = useFiltersStore((s) => s.setDate);
  const settingsReady = useUiStore((s) => s.settingsReady);

  const rowMarkups = useFinanceStore((s) => s.rowMarkups);
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);

  const nicknamesQuery = useNicknames();
  const nicknames = nicknamesQuery.data ?? {};

  const [search, setSearch] = useState("");
  const [hideZero, setHideZero] = useState(true);
  const [sort, setSort] = useState<StoreSortState>({ key: "plus", dir: "desc" });

  // include_archived: true so historical spend rolls up correctly,
  // matching the Finance view's behaviour.
  const overview = useMultiAccountOverview(visible, date, {
    includeArchived: true,
    source: "store-expenses",
  });

  const allRows = useMemo(
    () => buildStoreRows(overview.campaigns, nicknames, rowMarkups, defaultMarkup),
    [overview.campaigns, nicknames, rowMarkups, defaultMarkup],
  );

  const visibleRows = useMemo(() => {
    const filtered = filterStoreRows(allRows, search, hideZero);
    return sortStoreRows(filtered, sort);
  }, [allRows, search, hideZero, sort]);

  const totalPlus = visibleRows.reduce((s, r) => s + r.spendPlus, 0);

  const onSort = (key: StoreSortKey) => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
      }
      return { key, dir: "desc" };
    });
  };

  const onDownloadExcel = async () => {
    if (visibleRows.length === 0) {
      toast("沒有資料可匯出", "info");
      return;
    }
    try {
      // Lazy-load the heavy xlsx chunk only when the user actually
      // exports — keeps it out of the initial app bundle.
      const xlsx = await import("xlsx");
      const aoa: Array<Array<string | number>> = [
        ["花費+%", "店家", "科目", "子科目", "設計師"],
        ...visibleRows.map((r) => [
          r.spendPlus,
          r.store,
          SUBJECT,
          SUB_SUBJECT,
          formatDesignersText(r.designers),
        ]),
        [totalPlus, "合計", "", "", ""],
      ];
      const ws = xlsx.utils.aoa_to_sheet(aoa);
      // Column widths for a readable Excel layout
      ws["!cols"] = [{ wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 32 }];
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, ws, "店家花費");
      const dateLabel = toLabel(date).replace(/[/ ~]/g, "_");
      xlsx.writeFile(wb, `店家花費_${dateLabel}.xlsx`);
      toast("已下載 Excel");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知錯誤";
      toast(`匯出失敗:${msg}`, "error");
    }
  };

  return (
    <>
      <Topbar title="店家花費">
        <div className="flex items-center gap-2 md:gap-3">
          <Button
            variant="ghost"
            size="sm"
            title="匯出 Excel"
            aria-label="匯出 Excel"
            onClick={onDownloadExcel}
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
          <DatePicker value={date} onChange={(cfg) => setDate("shared", cfg)} />
        </div>
      </Topbar>

      <div className="min-w-0 flex-1 px-3 pt-3 md:px-4 md:pt-4">
        <div className="mb-3 flex flex-col overflow-hidden rounded-2xl border border-border md:mb-4">
          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-white px-3 py-2.5 md:gap-2.5 md:px-5">
            <input
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              placeholder="搜尋店家或設計師..."
              className="h-10 min-w-[140px] flex-1 rounded-lg border-[1.5px] border-border px-3 text-[13px] outline-none focus:border-orange md:h-8 md:px-2.5"
            />
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

          {/* Table */}
          <div className="w-full overflow-x-auto">
            {!settingsReady ? (
              <LoadingState title="載入店家花費中..." />
            ) : visible.length === 0 ? (
              <EmptyState>請先在設定中啟用廣告帳戶</EmptyState>
            ) : overview.isLoading || overview.insightsPending ? (
              <LoadingState title="載入店家花費中..." />
            ) : allRows.length === 0 ? (
              <EmptyState>
                此區間沒有任何已設定店家暱稱的行銷活動,請先到費用中心或儀表板編輯活動暱稱
              </EmptyState>
            ) : (
              <table className="w-full min-w-[760px] border-collapse text-[12px] md:text-[13px]">
                <thead>
                  <tr className="bg-bg">
                    <SortHeader
                      label="花費+%"
                      sortKey="plus"
                      active={sort.key === "plus"}
                      dir={sort.dir}
                      onSort={onSort}
                      right
                    />
                    <SortHeader
                      label="店家"
                      sortKey="store"
                      active={sort.key === "store"}
                      dir={sort.dir}
                      onSort={onSort}
                    />
                    <th className="sticky top-0 z-[1] min-w-[86px] whitespace-nowrap border-b border-border bg-bg px-1.5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.5px] text-gray-300 md:px-3.5 md:py-2.5">
                      科目
                    </th>
                    <th className="sticky top-0 z-[1] min-w-[86px] whitespace-nowrap border-b border-border bg-bg px-1.5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.5px] text-gray-300 md:px-3.5 md:py-2.5">
                      子科目
                    </th>
                    <th className="sticky top-0 z-[1] border-b border-border bg-bg px-1.5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.5px] text-gray-300 md:px-3.5 md:py-2.5">
                      設計師
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-10 text-center text-xs text-gray-300">
                        無符合條件的資料
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((row) => (
                      <tr key={row.store} className="border-b border-border bg-white">
                        <td className="px-1.5 py-2 text-right font-semibold tabular-nums text-orange md:px-3.5 md:py-2.5">
                          ${fM(row.spendPlus)}
                        </td>
                        <td className="px-1.5 py-2 font-medium md:px-3.5 md:py-2.5">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate" title={row.store}>
                              {row.store}
                            </span>
                            <span className="shrink-0 rounded-full bg-bg px-1.5 py-[1px] text-[10px] font-normal text-gray-300">
                              {row.campaignCount}
                            </span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-1.5 py-2 text-gray-500 md:px-3.5 md:py-2.5">{SUBJECT}</td>
                        <td className="whitespace-nowrap px-1.5 py-2 text-gray-500 md:px-3.5 md:py-2.5">
                          {SUB_SUBJECT}
                        </td>
                        <td className="px-1.5 py-2 text-gray-500 md:px-3.5 md:py-2.5">
                          <DesignerCell designers={row.designers} />
                        </td>
                      </tr>
                    ))
                  )}
                  {visibleRows.length > 0 && (
                    <tr className="border-t border-border bg-bg">
                      <td className="px-1.5 py-2 text-right text-[12px] font-bold tabular-nums text-orange md:px-3.5 md:py-2.5 md:text-[13px]">
                        ${fM(totalPlus)}
                      </td>
                      <td
                        colSpan={4}
                        className="px-1.5 py-2 text-[12px] font-bold text-ink md:px-3.5 md:py-2.5 md:text-[13px]"
                      >
                        合計({visibleRows.length} 個店家)
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function DesignerCell({ designers }: { designers: DesignerBreakdown[] }) {
  if (designers.length === 0) return <span>—</span>;
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5">
      {designers.map((d) => (
        <span key={d.name} className="whitespace-nowrap">
          {d.name}
          <span className="ml-1 font-semibold tabular-nums text-orange">${fM(d.spendPlus)}</span>
        </span>
      ))}
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  right,
}: {
  label: string;
  sortKey: Exclude<StoreSortKey, null>;
  active: boolean;
  dir: "asc" | "desc";
  onSort: (key: StoreSortKey) => void;
  right?: boolean;
}) {
  const arrow = active ? (dir === "asc" ? " ↑" : " ↓") : "";
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        "sticky top-0 z-[1] cursor-pointer select-none whitespace-nowrap border-b border-border bg-bg px-1.5 py-2 md:px-3.5 md:py-2.5",
        "text-[11px] font-semibold uppercase tracking-[0.5px]",
        right ? "text-right" : "text-left",
        active ? "text-orange" : "text-gray-300",
      )}
    >
      {label}
      {arrow}
    </th>
  );
}
