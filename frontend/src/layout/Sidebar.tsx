import { useSubscription } from "@/api/hooks/useSubscription";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { TierBadge } from "@/components/TierBadge";
import { cn } from "@/lib/cn";
import { prefetchView } from "@/router";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";

const importEngineeringModal = () => import("@/views/engineering/EngineeringView");
const EngineeringModal = lazy(() =>
  importEngineeringModal().then((m) => ({ default: m.EngineeringModal })),
);

/**
 * Left sidebar — 180px fixed on desktop (`w-sidebar`, see
 * tailwind.config spacing), 280px drawer on mobile (globals.css
 * @media override). 60px logo header, nav items, user dropdown at
 * the bottom that opens upward.
 *
 * Layout and behavior ported from the original template.
 * Five visible nav items: 儀表板 / 數據分析 / 警示列表 / 費用中心 / 設定.
 * (快速上架 route still exists for direct URL access but is hidden
 * from the sidebar nav per product decision 2026-04-14.)
 */

interface NavItem {
  to: string;
  icon: JSX.Element;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    to: "/dashboard",
    label: "儀表板",
    icon: (
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
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
      </svg>
    ),
  },
  {
    to: "/analytics",
    label: "數據分析",
    icon: (
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
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    to: "/alerts",
    label: "警示列表",
    icon: (
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
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
  {
    to: "/security",
    label: "安全監控",
    icon: (
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
        <path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" />
        <polyline points="9 12 11 14 15 10" />
      </svg>
    ),
  },
  {
    to: "/optimization",
    label: "AI 幕僚",
    icon: (
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
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" />
      </svg>
    ),
  },
  {
    to: "/finance",
    label: "費用中心",
    icon: (
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
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    ),
  },
  {
    to: "/history",
    label: "歷史花費",
    icon: (
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
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 4 4 5-6" />
      </svg>
    ),
  },
  {
    to: "/store-expenses",
    label: "店家花費",
    icon: (
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
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
];

// 快速上架 hidden from the sidebar nav (route still exists for
// direct URL access). Settings is split into two tools:
//   - 廣告帳號設定 → /settings (account selection + reorder)
//   - LINE 推播設定 → /line-push (LINE group label management)
const TOOL_ITEMS: NavItem[] = [
  {
    to: "/settings",
    label: "廣告帳號設定",
    icon: (
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
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  {
    to: "/line-push",
    label: "LINE 推播設定",
    icon: (
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
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
];

export interface SidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({ mobileOpen = false, onMobileClose }: SidebarProps) {
  const { user, logout } = useFbAuth();
  const subQuery = useSubscription();
  const sub = subQuery.data;
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [engineeringOpen, setEngineeringOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);

  // Close the user menu on click-outside. Hover-close (onMouseLeave)
  // caused "滑鼠移過去，選單消失" because the 8px gap between trigger
  // and popover sits outside the relative container's hit box — the
  // cursor transitioning across the gap fires mouseleave and kills
  // the menu before the user can click an item.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuWrapRef.current) return;
      if (!menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <aside
      data-mobile-open={mobileOpen ? "true" : "false"}
      // iOS PWA safe-area: sidebar is `fixed inset-y-0`, so on
      // standalone iOS the top of the sidebar lives under the
      // status bar. Respecting safe-area-inset-top pushes the logo
      // row below the clock/signal indicators when the drawer slides
      // in on mobile. Desktop env() resolves to 0, so no change.
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      className={cn(
        "shell-sidebar fixed inset-y-0 left-0 z-[100] flex w-sidebar flex-col overflow-hidden border-r border-border bg-white",
      )}
      onClick={() => {
        // Tapping a link inside the sidebar triggers a route change
        // (handled in Shell's useEffect) which auto-closes. This extra
        // onClick is a belt-and-suspenders close for non-link children.
        if (onMobileClose && mobileOpen) onMobileClose();
      }}
    >
      {/* Logo header */}
      <div className="flex h-[56px] shrink-0 items-center gap-2 border-b border-border px-4 md:h-[60px]">
        <div className="text-[15px] font-bold tracking-[-0.2px] text-ink">
          METADASH <span className="text-orange">by LURE</span>
        </div>
      </div>

      {/* Nav — owns the scroll so the user dropdown below stays
          glued to the sidebar bottom on iOS PWA. Putting overflow-y
          on the parent <aside> instead causes flex-1 + mt-auto to
          mis-measure and leave a dead-air gap below the avatar. */}
      <nav className="min-h-0 flex-1 overflow-y-auto p-2.5">
        <div className="px-2.5 pt-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.8px] text-gray-300">
          主選單
        </div>
        {NAV_ITEMS.map((item) => (
          <SidebarLink key={item.to} item={item} />
        ))}

        <div className="mt-2 px-2.5 pt-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.8px] text-gray-300">
          工具
        </div>
        {TOOL_ITEMS.map((item) => (
          <SidebarLink key={item.to} item={item} />
        ))}
      </nav>

      {/* User dropdown — opens upward from the bottom */}
      <div className="shrink-0 border-t border-border px-2 py-3">
        <div
          className="relative"
          ref={menuWrapRef}
          // Mobile drawer: the parent <aside> has a belt-and-suspenders
          // onClick that closes the drawer for any non-link tap. Without
          // stopping propagation here the user-name tap would close the
          // drawer before the dropdown could render → menu never appears.
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className={cn(
              "flex w-full select-none items-center gap-2.5 rounded-lg px-2.5 py-2.5",
              "bg-transparent hover:bg-transparent", // no hover per style.md
            )}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-orange-bg text-[12px] font-bold text-orange">
              {user?.pictureUrl ? (
                <img
                  src={user.pictureUrl}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              ) : (
                (user?.name?.[0] ?? "?").toUpperCase()
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
              <span className="w-full truncate text-[13px] font-semibold text-ink">
                {user?.name ?? ""}
              </span>
              {sub && <TierBadge tier={sub.tier} />}
            </div>
          </button>

          {menuOpen && (
            <div
              className={cn(
                "absolute bottom-[calc(100%+8px)] left-0 z-[999]",
                "w-[165px] rounded-xl border-[1.5px] border-border bg-white p-1.5 shadow-md",
              )}
            >
              <div className="mb-1 border-b border-border px-2 pb-1.5 pt-2 text-xs font-bold text-ink">
                <div className="flex items-center gap-1.5">
                  <span className="truncate">{user?.name}</span>
                  {sub && <TierBadge tier={sub.tier} />}
                </div>
                <div className="mt-0.5 text-[10px] font-normal text-gray-300">Facebook 帳號</div>
              </div>
              <button
                type="button"
                onMouseEnter={() => prefetchView("/billing")}
                onFocus={() => prefetchView("/billing")}
                onClick={() => {
                  setMenuOpen(false);
                  navigate("/billing");
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-gray-500 hover:bg-orange-bg hover:text-orange"
              >
                我的訂閱
              </button>
              <button
                type="button"
                onMouseEnter={() => {
                  void importEngineeringModal();
                }}
                onFocus={() => {
                  void importEngineeringModal();
                }}
                onClick={() => {
                  setMenuOpen(false);
                  setEngineeringOpen(true);
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-gray-500 hover:bg-orange-bg hover:text-orange"
              >
                工程模式
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void logout();
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-gray-500 hover:bg-orange-bg hover:text-orange"
              >
                登出
              </button>
            </div>
          )}
        </div>
      </div>
      {engineeringOpen && (
        <Suspense fallback={null}>
          <EngineeringModal open={engineeringOpen} onOpenChange={setEngineeringOpen} />
        </Suspense>
      )}
    </aside>
  );
}

function SidebarLink({ item }: { item: NavItem }) {
  // Start fetching the target view's JS chunk before the user
  // commits to the navigation. On desktop this fires on hover; on
  // touch devices it fires on touchstart so the chunk is in flight
  // by the time the tap completes.
  const prefetch = () => prefetchView(item.to);
  return (
    <NavLink
      to={item.to}
      onMouseEnter={prefetch}
      onFocus={prefetch}
      onTouchStart={prefetch}
      className={({ isActive }) =>
        cn(
          "mb-1 flex min-h-[44px] select-none items-center gap-3 rounded-xl px-3.5 py-2.5",
          "text-[14px] font-medium transition-[all] duration-150 cursor-pointer",
          "active:scale-[0.98]",
          isActive
            ? "bg-orange-bg font-semibold text-orange"
            : "text-gray-500 hover:bg-orange-bg hover:text-orange",
        )
      }
    >
      <span className="flex w-[22px] shrink-0 items-center justify-center text-[17px]">
        {item.icon}
      </span>
      {item.label}
    </NavLink>
  );
}
