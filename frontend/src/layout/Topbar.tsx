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
      // PWA safe-area: on iOS standalone, viewport-fit=cover puts the
      // status bar (time, signal, battery) on top of y=0. Without
      // padding-top: env(safe-area-inset-top), the topbar's content
      // lives UNDER the status bar. The inline style is mobile-only;
      // desktop browsers return 0 for the env() which is a no-op.
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      className={cn(
        // Mobile: 64px tall, more breathing room (was 56px). The hamburger
        // button + page title sit on the left; per-view controls scroll
        // on the right with overflow-x-auto if they're too wide.
        "sticky top-0 z-[50] flex min-h-[64px] shrink-0 items-center gap-2 border-b border-border bg-white px-3 py-2",
        "[&_button]:leading-none [&_button_svg]:block",
        "md:min-h-[60px] md:gap-3 md:px-6 md:py-0",
        className,
      )}
    >
      {/* Hamburger (mobile only) */}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label="開啟選單"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-ink hover:bg-bg active:scale-95 md:hidden"
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
