import { Modal } from "@/components/Modal";
import { StatusDot } from "@/components/StatusDot";
import { accountDotState } from "@/lib/accountStatus";
import { cn } from "@/lib/cn";
import type { FbAccount } from "@/types/fb";
import { useEffect, useMemo, useState } from "react";

/**
 * Mobile-only account picker — a single tap-target that displays the
 * currently selected account name, and opens a Modal listing all
 * available accounts when tapped. Replaces the desktop 240px sidebar
 * (<AlertAccountPanel/>, <AccountPanel/>, <FinanceAccountPanel/>) on
 * narrow viewports so the alert/dashboard/finance pages don't waste
 * vertical space on a horizontal-scrolling chip strip.
 *
 * Hidden automatically on desktop; desktop views use the account
 * sidebar instead.
 *
 * Pass `selectedId={null}` and an empty selected label to represent
 * the "全部帳戶" (all-accounts) option, which is supported by
 * AlertsView and FinanceView (DashboardView always picks exactly one).
 *
 * The dialog body supports substring search on account name. With
 * 80+ accounts per user, scrolling the whole list on mobile is
 * painful; tapping the search box brings up the keyboard on demand.
 * We intentionally don't autofocus — the user usually wants to see
 * the list first before deciding to filter.
 */

export interface MobileAccountPickerProps {
  accounts: FbAccount[];
  /** Current selection, or null for "全部帳戶". */
  selectedId: string | null;
  /** Click handler. Called with null for the "all" row, otherwise the account id. */
  onSelect: (id: string | null) => void;
  /** Whether the "全部帳戶" entry should be rendered at the top of the list. */
  includeAllOption?: boolean;
  /** Label for the field shown above the button. Defaults to "廣告帳戶". */
  label?: string;
  className?: string;
}

export function MobileAccountPicker({
  accounts,
  selectedId,
  onSelect,
  includeAllOption = true,
  label = "廣告帳戶",
  className,
}: MobileAccountPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Reset the search box every time the dialog opens so users never
  // see stale filter state from a previous session.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) => a.name.toLowerCase().includes(q));
  }, [accounts, query]);

  // Suppress "全部帳戶" while searching — if the user typed anything
  // they clearly want a specific account, not the aggregate view.
  const showAll = includeAllOption && query.trim() === "";

  const currentName =
    selectedId === null
      ? includeAllOption
        ? "全部帳戶"
        : "請選擇帳戶"
      : (accounts.find((a) => a.id === selectedId)?.name ?? "請選擇帳戶");

  const handlePick = (id: string | null) => {
    onSelect(id);
    setOpen(false);
  };

  return (
    // mr-auto on mobile pushes this picker to the LEFT of the topbar,
    // leaving the DatePicker and other controls right-aligned. Reset
    // on desktop so the normal `justify-end` flow still works.
    <div className={cn("mr-auto flex shrink-0 items-center gap-2 md:!hidden", className)}>
      <span className="hidden whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.5px] text-gray-300 sm:inline">
        {label}
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`選擇廣告帳戶,目前:${currentName}`}
        aria-haspopup="dialog"
        className="flex h-10 min-w-0 max-w-[200px] items-center justify-between gap-2.5 rounded-pill border-[1.5px] border-border bg-white px-4 text-left text-[13px] font-medium text-ink active:scale-[0.98] active:bg-orange-bg sm:h-9 md:max-w-[280px]"
      >
        <span className="min-w-0 truncate">{currentName}</span>
        <span aria-hidden="true" className="text-[10px] text-gray-300">
          ▼
        </span>
      </button>

      <Modal open={open} onOpenChange={setOpen} title="選擇廣告帳戶" width={360}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="搜尋帳戶..."
          aria-label="搜尋帳戶"
          className="mb-2 mt-1 h-10 w-full rounded-lg border-[1.5px] border-border bg-white px-3 text-[14px] text-ink placeholder:text-gray-300 focus:border-orange focus:outline-none"
        />
        {/* Negative horizontal margin lets the active-row highlight
            bleed to the modal edge so the list reads as a list, not
            a set of inset cards. */}
        <div className="-mx-5 max-h-[58vh] overflow-y-auto md:-mx-6">
          {showAll && (
            <PickerRow
              active={selectedId === null}
              dotState="on"
              label="全部帳戶"
              onClick={() => handlePick(null)}
            />
          )}
          {filtered.map((a) => (
            <PickerRow
              key={a.id}
              active={selectedId === a.id}
              dotState={accountDotState(a.account_status)}
              label={a.name}
              onClick={() => handlePick(a.id)}
            />
          ))}
          {filtered.length === 0 && !showAll && (
            <div className="px-5 py-6 text-center text-xs text-gray-300">
              {query.trim() ? "沒有符合的帳戶" : "尚無帳戶"}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function PickerRow({
  active,
  dotState,
  label,
  onClick,
}: {
  active: boolean;
  dotState: "on" | "off";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-[44px] w-full cursor-pointer select-none items-center gap-2.5 px-5 py-2 text-left md:px-6",
        active ? "bg-orange-bg" : "active:bg-orange-bg hover:bg-orange-bg/60",
      )}
    >
      <StatusDot state={dotState} />
      <span
        className={cn(
          "flex-1 truncate text-[14px] font-medium",
          active ? "font-semibold text-orange" : "text-ink",
        )}
        title={label}
      >
        {label}
      </span>
      {active && (
        <span aria-hidden="true" className="text-base text-orange">
          ✓
        </span>
      )}
    </button>
  );
}
