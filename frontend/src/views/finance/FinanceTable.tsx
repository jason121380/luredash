import { useAccounts } from "@/api/hooks/useAccounts";
import { useNicknames } from "@/api/hooks/useNicknames";
import { FbCampaignLink } from "@/components/FbCampaignLink";
import { NicknameEditModal } from "@/components/NicknameEditModal";
import { cn } from "@/lib/cn";
import type { DateConfig } from "@/lib/datePicker";
import { fM } from "@/lib/format";
import { spendOf } from "@/lib/insights";
import { useFinanceStore } from "@/stores/financeStore";
import { useUiStore } from "@/stores/uiStore";
import type { FbCampaign, FbEntityStatus } from "@/types/fb";
import { useMemo, useState } from "react";
import { InvoiceModal } from "./InvoiceModal";
import {
  type FinSortKey,
  type FinSortState,
  filterFinanceRows,
  formatNickname,
  markupFor,
  sortFinanceRows,
  spendPlus,
} from "./financeData";

/**
 * The main finance table. Supports two modes:
 *   - single account selected   → no 廣告帳號 column
 *   - all accounts (selectedIds empty) → include 廣告帳號 column
 *
 * Row features:
 *   - Per-row markup % editable inline (persists via financeStore)
 *   - Pin-to-top via 📌 button; pinned rows always sort before unpinned
 *   - Spend+markup column shown in orange bold
 *   - Status badge (custom, since Finance uses slightly different
 *     styling than the dashboard badges)
 *
 * Sort state lives in uiStore.finSort so the selection persists
 * across view switches.
 */

export interface FinanceTableProps {
  campaigns: FbCampaign[];
  multiAcct: boolean;
  search: string;
  hideZero: boolean;
  date: DateConfig;
}

export function FinanceTable({ campaigns, multiAcct, search, hideZero, date }: FinanceTableProps) {
  const rowMarkups = useFinanceStore((s) => s.rowMarkups);
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);
  const setRowMarkup = useFinanceStore((s) => s.setRowMarkup);
  const pinnedIds = useFinanceStore((s) => s.pinnedIds);
  const togglePin = useFinanceStore((s) => s.togglePin);
  const showNicknames = useFinanceStore((s) => s.showNicknames);

  const finSort = useUiStore((s) => s.finSort);
  const setFinSort = useUiStore((s) => s.setFinSort);

  const nicknamesQuery = useNicknames();
  const nicknames = nicknamesQuery.data ?? {};

  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    store: string;
    designer: string;
  } | null>(null);
  const [invoicing, setInvoicing] = useState<{ campaign: FbCampaign; markup: number } | null>(null);

  const accountsQuery = useAccounts();
  const businessIdFor = (acctId: string | undefined) =>
    acctId ? accountsQuery.data?.find((a) => a.id === acctId)?.business?.id : undefined;

  const visible = useMemo(() => {
    const sortState: FinSortState = {
      key: (finSort.key as FinSortKey) ?? null,
      dir: finSort.dir,
    };
    const filtered = filterFinanceRows(campaigns, hideZero, search, nicknames);
    return sortFinanceRows(filtered, sortState, pinnedIds, rowMarkups, defaultMarkup, {
      nicknames,
      useNicknameForNameSort: showNicknames,
    });
  }, [
    campaigns,
    hideZero,
    search,
    nicknames,
    showNicknames,
    finSort.key,
    finSort.dir,
    pinnedIds,
    rowMarkups,
    defaultMarkup,
  ]);

  const spendSum = visible.reduce((s, c) => s + spendOf(c), 0);
  const plusSum = visible.reduce((s, c) => {
    const m = markupFor(c.id, rowMarkups, defaultMarkup);
    return s + spendPlus(spendOf(c), m);
  }, 0);

  return (
    <>
      {editing && (
        <NicknameEditModal
          open={true}
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          campaignId={editing.id}
          campaignName={editing.name}
          initialStore={editing.store}
          initialDesigner={editing.designer}
        />
      )}
      <InvoiceModal
        open={invoicing !== null}
        onOpenChange={(o) => {
          if (!o) setInvoicing(null);
        }}
        campaign={invoicing?.campaign ?? null}
        date={date}
        markup={invoicing?.markup ?? 0}
      />
      {/* min-w-[640px] on mobile (was 720px) packs columns tighter so
          more fit in the viewport before horizontal scroll kicks in;
          desktop (md:) keeps the original 720px target. */}
      <table className="w-full min-w-[640px] border-collapse text-[12px] md:min-w-[720px] md:text-[13px]">
        <thead>
          <tr className="bg-bg">
            <th className="sticky top-0 z-[1] w-8 border-b border-border bg-bg px-1.5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.5px] text-gray-300 md:w-10 md:px-3.5 md:py-2.5">
              No.
            </th>
            <th className="sticky top-0 z-[1] w-14 border-b border-border bg-bg px-1.5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.5px] text-gray-300 md:w-20 md:px-3.5 md:py-2.5">
              狀態
            </th>
            {multiAcct && (
              <SortHeader label="廣告帳號" sortKey="acct" sort={finSort} onSort={setFinSort} />
            )}
            <SortHeader label="行銷活動名稱" sortKey="name" sort={finSort} onSort={setFinSort} />
            <SortHeader label="花費" sortKey="spend" sort={finSort} onSort={setFinSort} />
            <SortHeader label="月%" sortKey="markup" sort={finSort} onSort={setFinSort} right />
            <SortHeader label="花費+%" sortKey="plus" sort={finSort} onSort={setFinSort} right />
            <th className="sticky top-0 z-[1] w-9 border-b border-border bg-bg px-1.5 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.5px] text-gray-300 md:w-12 md:px-3.5 md:py-2.5">
              Pin
            </th>
            <th className="sticky top-0 z-[1] w-9 border-b border-border bg-bg px-1.5 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.5px] text-gray-300 md:w-12 md:px-3.5 md:py-2.5">
              請款單
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td
                colSpan={multiAcct ? 9 : 8}
                className="px-5 py-10 text-center text-xs text-gray-300"
              >
                無花費資料
              </td>
            </tr>
          ) : (
            visible.map((camp, i) => {
              const sp = spendOf(camp);
              const m = markupFor(camp.id, rowMarkups, defaultMarkup);
              const plus = spendPlus(sp, m);
              const isPinned = pinnedIds.includes(camp.id);
              const nick = nicknames[camp.id];
              const label = formatNickname(nick);
              const hasNickname = Boolean(label);
              return (
                <tr
                  key={camp.id}
                  className={cn(
                    // Explicit bg-white on data rows so the scroll
                    // container's transparent bg (set up by FinanceView
                    // for the card wrap trick) doesn't bleed through
                    // and make rows look warm-white.
                    "border-b border-border bg-white",
                    isPinned && "border-l-[3px] border-l-orange bg-orange-bg",
                  )}
                >
                  <td className="w-8 px-1.5 text-gray-500 md:w-10 md:px-3.5">{i + 1}</td>
                  <td className="w-14 px-1.5 md:w-20 md:px-3.5">
                    <FinanceStatusBadge status={camp.status} />
                  </td>
                  {multiAcct && (
                    <td
                      className="max-w-[80px] truncate px-1.5 text-[11px] text-gray-500 md:max-w-[120px] md:px-3.5"
                      title={camp._accountName ?? ""}
                    >
                      {camp._accountName ?? ""}
                    </td>
                  )}
                  <td className="px-1.5 font-medium md:px-3.5" title={camp.name}>
                    <div className="flex items-center gap-1 md:gap-1.5">
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate",
                          !hasNickname && "font-bold text-orange",
                          multiAcct
                            ? "max-w-[160px] md:max-w-[260px]"
                            : "max-w-[200px] md:max-w-[300px]",
                        )}
                      >
                        {showNicknames && label ? label : camp.name}
                      </span>
                      <button
                        type="button"
                        title="編輯暱稱"
                        aria-label={`編輯暱稱 ${camp.name}`}
                        onClick={() =>
                          setEditing({
                            id: camp.id,
                            name: camp.name,
                            store: nicknames[camp.id]?.store ?? "",
                            designer: nicknames[camp.id]?.designer ?? "",
                          })
                        }
                        className="shrink-0 cursor-pointer text-gray-300 hover:text-orange"
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
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                        </svg>
                      </button>
                      <FbCampaignLink
                        campaignId={camp.id}
                        accountId={camp._accountId}
                        campaignName={camp.name}
                        businessId={businessIdFor(camp._accountId)}
                      />
                    </div>
                  </td>
                  <td className="px-1.5 tabular-nums md:px-3.5">${fM(sp)}</td>
                  <td className="px-1.5 text-right md:px-3.5">
                    <input
                      type="number"
                      value={m === 0 ? "" : m}
                      placeholder="0"
                      min={0}
                      max={999}
                      step={0.5}
                      onChange={(e) => {
                        const raw = e.currentTarget.value;
                        if (raw === "") {
                          setRowMarkup(camp.id, 0);
                          return;
                        }
                        const v = Number.parseFloat(raw);
                        if (!Number.isNaN(v)) setRowMarkup(camp.id, v);
                      }}
                      className="h-6 w-[44px] rounded border-[1.5px] border-border bg-white px-1 text-center text-xs md:w-[52px]"
                    />
                    %
                  </td>
                  <td className="px-1.5 text-right font-semibold tabular-nums text-orange md:px-3.5">
                    ${fM(plus)}
                  </td>
                  <td className="px-1.5 text-center md:px-3.5">
                    <button
                      type="button"
                      title={isPinned ? "取消置頂" : "置頂"}
                      aria-label={isPinned ? `取消置頂 ${camp.name}` : `置頂 ${camp.name}`}
                      aria-pressed={isPinned}
                      onClick={() => togglePin(camp.id)}
                      className={cn(
                        "h-[30px] w-[30px] cursor-pointer border-none bg-transparent text-sm leading-none active:scale-90",
                        isPinned ? "opacity-100" : "opacity-25 hover:opacity-60",
                      )}
                    >
                      <span aria-hidden="true">📌</span>
                    </button>
                  </td>
                  <td className="px-1.5 text-center md:px-3.5">
                    <button
                      type="button"
                      title="下載請款單"
                      aria-label={`下載 ${camp.name} 的請款單`}
                      onClick={() => setInvoicing({ campaign: camp, markup: m })}
                      className="inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-gray-300 hover:text-orange active:scale-90"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="9" y1="14" x2="15" y2="14" />
                        <line x1="9" y1="18" x2="13" y2="18" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })
          )}
          {visible.length > 0 && (
            // Totals row — matches the Dashboard tree's totals row
            // visually: same border-t-2 + bg-bg, same px-3.5 py-2.5
            // padding (≈ 32px row height), same 13px bold ink. Only
            // the 花費+% cell keeps the orange tint to flag it as
            // the "marked-up" computed column.
            <tr className="border-t border-border bg-bg">
              <td
                colSpan={multiAcct ? 4 : 3}
                className="px-1.5 py-2 text-[12px] font-bold text-ink md:px-3.5 md:py-2.5 md:text-[13px]"
              >
                合計
              </td>
              <td className="px-1.5 py-2 text-[12px] font-bold tabular-nums text-ink md:px-3.5 md:py-2.5 md:text-[13px]">
                ${fM(spendSum)}
              </td>
              <td />
              <td className="px-1.5 py-2 text-right text-[12px] font-bold tabular-nums text-orange md:px-3.5 md:py-2.5 md:text-[13px]">
                ${fM(plusSum)}
              </td>
              <td />
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  right,
}: {
  label: string;
  sortKey: FinSortKey;
  sort: { key: string | null; dir: "asc" | "desc" };
  onSort: (key: string | null) => void;
  right?: boolean;
}) {
  const active = sort.key === sortKey;
  const arrow = active ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
  return (
    <th
      onClick={() => sortKey && onSort(sortKey)}
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

function FinanceStatusBadge({ status }: { status: FbEntityStatus }) {
  if (status === "ACTIVE") {
    return (
      <span className="inline-block whitespace-nowrap rounded-[10px] bg-[#E8F5E9] px-[7px] py-[2px] text-[11px] font-semibold text-[#2E7D32]">
        進行中
      </span>
    );
  }
  if (status === "PAUSED") {
    return (
      <span className="inline-block whitespace-nowrap rounded-[10px] bg-[#F5F5F5] px-[7px] py-[2px] text-[11px] font-semibold text-[#757575]">
        暫停
      </span>
    );
  }
  if (status === "ARCHIVED") {
    return (
      <span className="inline-block whitespace-nowrap rounded-[10px] bg-[#EEEEEE] px-[7px] py-[2px] text-[11px] font-semibold text-[#9E9E9E]">
        已封存
      </span>
    );
  }
  return (
    <span className="inline-block whitespace-nowrap rounded-[10px] bg-[#FFEBEE] px-[7px] py-[2px] text-[11px] font-semibold text-[#B71C1C]">
      {status === "DELETED" ? "已刪除" : String(status)}
    </span>
  );
}
