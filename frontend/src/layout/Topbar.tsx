import { useMobileSidebarToggle } from "@/layout/Shell";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

/**
 * Top bar — shared container for every view's top strip (page title +
 * date picker + refresh button + any per-view controls).
 *
 * Mobile (≤768px):
 *   - Leftmost: hamburger button → opens the sidebar drawer
 *   - Page title shown on mobile too (was previously desktop-only when
 *     the bottom tab bar carried navigation context)
 *   - Comfortable vertical padding so the header doesn't feel cramped
 *     under iOS status bar
 *
 * Desktop (≥768px):
 *   - No hamburger (sidebar is always visible)
 *   - Title left-aligned, controls right-aligned
 */

export interface TopbarProps {
  title: ReactNode;
  /** Optional control rendered immediately after the title — used by
   * Dashboard/Alerts/Finance to mount the account-sidebar collapse
   * toggle right next to the page title. */
  titleAction?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Topbar({ title, titleAction, children, className }: TopbarProps) {
  const toggleSidebar = useMobileSidebarToggle();

  return (
    <div
      className={cn(
        // Mobile PWA: include the iOS status-bar safe area in the
        // outer height, while keeping a real 52px content row. Using
        // plain h-56 + padding-top squeezes the controls on standalone
        // iOS because border-box subtracts the safe-area from content.
        "sticky top-0 z-[50] flex h-[calc(52px_+_env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-border bg-white px-3 pb-0 pt-[env(safe-area-inset-top)]",
        "[&_button]:leading-none [&_button_svg]:block",
        "md:h-[60px] md:gap-3 md:px-6",
        className,
      )}
    >
      {/* Hamburger (mobile only) */}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label="開啟選單"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-bg active:scale-95 md:hidden"
      >
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
      <div className="min-w-0 shrink-0 truncate text-[15px] font-bold tracking-[-0.2px] text-ink md:text-base">
        {title}
      </div>
      {titleAction}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2 md:gap-3">
        {children}
      </div>
    </div>
  );
}

export function TopbarSeparator() {
  return null;
}
