import { EmptyState } from "@/components/EmptyState";
import { Loading } from "@/components/Loading";
import { StatusDot } from "@/components/StatusDot";
import { accountDotState } from "@/lib/accountStatus";
import { cn } from "@/lib/cn";
import { useUiStore } from "@/stores/uiStore";
import type { FbAccount } from "@/types/fb";

/**
 * Dashboard left column — 180px list of the user's visible accounts.
 * Selecting a row sets it as the single "active" account for the
 * dashboard view.
 *
 * Empty states:
 *  - accounts still loading        → <Loading/>
 *  - 0 accounts enabled in Settings → inline hint
 *
 * Collapsed mode: when ``acctSidebarCollapsed`` is true the panel
 * renders nothing — the toggle button in the Topbar
 * (<AcctSidebarToggle/>) brings it back. The collapsed flag lives
 * in uiStore and persists to localStorage so it survives reloads.
 */

export interface AccountPanelProps {
  accounts: FbAccount[];
  activeAccountId: string | null;
  isLoading: boolean;
  onSelect: (account: FbAccount) => void;
  /** Whether the 重點關注 pseudo-account is the active selection. */
  focusActive?: boolean;
  /** Number of starred campaigns (shown as a chip on 重點關注). */
  focusCount?: number;
  /** Select the 重點關注 view. When omitted (e.g. 歷史花費), the 重點關注
   *  row is not rendered at all. */
  onSelectFocus?: () => void;
}

export function AccountPanel({
  accounts,
  activeAccountId,
  isLoading,
  onSelect,
  focusActive = false,
  focusCount = 0,
  onSelectFocus,
}: AccountPanelProps) {
  const collapsed = useUiStore((s) => s.acctSidebarCollapsed);

  if (collapsed) return null;

  return (
    <aside className="sticky top-0 flex min-h-[calc(100dvh-64px)] w-[160px] shrink-0 flex-col border-r border-border bg-bg">
      <div className="border-b border-border bg-white px-3 pb-2 pt-2.5">
        <h4 className="text-[11px] font-bold uppercase tracking-[0.6px] text-gray-300">廣告帳戶</h4>
      </div>
      <div className="flex-1 overflow-y-auto">
        {/* 重點關注 — always pinned first (starred campaigns across accounts).
            Only rendered when the host wires onSelectFocus (Dashboard). */}
        {onSelectFocus && (
          <button
            type="button"
            onClick={onSelectFocus}
            className={cn(
              "flex w-full cursor-pointer select-none items-center gap-2 border-b border-border px-3 py-2 text-left",
              focusActive ? "bg-orange-bg" : "hover:bg-orange-bg",
            )}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="shrink-0 text-orange"
              aria-hidden="true"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
            <span
              className={cn(
                "flex-1 truncate text-xs font-medium",
                focusActive ? "font-semibold text-orange" : "text-ink",
              )}
            >
              重點關注
            </span>
            {focusCount > 0 && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-[10px] font-semibold leading-[16px]",
                  focusActive ? "bg-orange text-white" : "bg-orange-bg text-orange",
                )}
              >
                {focusCount}
              </span>
            )}
          </button>
        )}
        {isLoading ? (
          <Loading />
        ) : accounts.length === 0 ? (
          <EmptyState>請先在設定中啟用帳戶</EmptyState>
        ) : (
          accounts.map((acc) => {
            const active = activeAccountId === acc.id;
            return (
              <button
                type="button"
                key={acc.id}
                onClick={() => onSelect(acc)}
                className={cn(
                  "flex w-full cursor-pointer select-none items-center gap-2 border-b border-border px-3 py-2 text-left",
                  active ? "bg-orange-bg" : "hover:bg-orange-bg",
                )}
              >
                <StatusDot state={accountDotState(acc.account_status)} />
                <span
                  className={cn(
                    "flex-1 truncate text-xs font-medium",
                    active ? "font-semibold text-orange" : "text-ink",
                  )}
                  title={acc.name}
                >
                  {acc.name}
                </span>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
}
