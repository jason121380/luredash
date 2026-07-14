import { useSubscription } from "@/api/hooks/useSubscription";
import metadashLogoUrl from "@/assets/metadash-logo.svg";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { BucuHeaderChip } from "@/components/BucuHeaderChip";
import { IdentityModal } from "@/components/IdentityModal";
import { TierBadge } from "@/components/TierBadge";
import { withReloadOnChunkError } from "@/lib/chunkReload";
import { cn } from "@/lib/cn";
import { prefetchView } from "@/router";
import { Suspense, lazy, useState } from "react";
import { NavLink } from "react-router-dom";

const importEngineeringModal = withReloadOnChunkError(
  () => import("@/views/engineering/EngineeringView"),
);
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
  beta?: boolean;
}

// ── Icons(reused across groups so we don't duplicate SVG markup) ──
const ICON_DASHBOARD = (
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
);
const ICON_CHART = (
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
);
const ICON_SHIELD = (
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
);
const ICON_ALERT = (
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
);
const ICON_TARGET = (
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
);
const ICON_DOLLAR = (
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
);
const ICON_STORE = (
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
);
const ICON_HISTORY = (
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
);
const ICON_SETTINGS = (
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
);
const ICON_LINE = (
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
);
const ICON_CARD = (
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
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <line x1="2" y1="10" x2="22" y2="10" />
  </svg>
);
const ICON_TERMINAL = (
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
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);
const ICON_LOGOUT = (
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
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

// ── Nav groups ─────────────────────────────────────────────────
// Each group corresponds to a labeled section in the sidebar
// (一般 / 成效 / 花費 / 設定). Top-down ordering matches user spec.
interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "一般",
    items: [
      { to: "/dashboard", label: "儀表板", icon: ICON_DASHBOARD },
      { to: "/analytics", label: "數據圖表", icon: ICON_CHART },
      { to: "/security", label: "安全防護", icon: ICON_SHIELD, beta: true },
    ],
  },
  {
    label: "成效",
    items: [
      { to: "/alerts", label: "警示列表", icon: ICON_ALERT },
      { to: "/optimization", label: "優化中心", icon: ICON_TARGET, beta: true },
    ],
  },
  {
    label: "花費",
    items: [
      { to: "/finance", label: "費用中心", icon: ICON_DOLLAR },
      { to: "/store-expenses", label: "店家花費", icon: ICON_STORE },
      { to: "/history", label: "歷史花費", icon: ICON_HISTORY },
    ],
  },
  {
    label: "設定",
    items: [
      { to: "/settings", label: "廣告帳號", icon: ICON_SETTINGS },
      { to: "/line-push", label: "LINE 推播", icon: ICON_LINE },
      { to: "/billing", label: "我的訂閱", icon: ICON_CARD },
    ],
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
  const [engineeringOpen, setEngineeringOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);

  return (
    <aside
      data-mobile-open={mobileOpen ? "true" : "false"}
      // iOS PWA safe-area: sidebar is `fixed inset-y-0`, so on
      // standalone iOS the top of the sidebar lives under the
      // status bar. Respecting safe-area-inset-top pushes the logo
      // row below the clock/signal indicators when the drawer slides
      // in on mobile. Desktop env() resolves to 0, so no change.
      className={cn(
        "shell-sidebar fixed inset-y-0 left-0 z-[100] flex w-sidebar flex-col overflow-hidden border-r border-border bg-white pt-[env(safe-area-inset-top)]",
      )}
      onClick={() => {
        // Tapping a link inside the sidebar triggers a route change
        // (handled in Shell's useEffect) which auto-closes. This extra
        // onClick is a belt-and-suspenders close for non-link children.
        if (onMobileClose && mobileOpen) onMobileClose();
      }}
    >
      {/* Logo header */}
      <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border px-4 md:h-[60px]">
        <img
          src={metadashLogoUrl}
          alt="Metadash"
          className="h-[18px] max-w-[106px] object-contain"
        />
      </div>

      {/* Nav — owns the scroll so the user dropdown below stays
          glued to the sidebar bottom on iOS PWA. Putting overflow-y
          on the parent <aside> instead causes flex-1 + mt-auto to
          mis-measure and leave a dead-air gap below the avatar. */}
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {NAV_GROUPS.map((group, idx) => (
          <div key={group.label}>
            <div
              className={cn(
                "px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.8px] text-gray-300",
                idx > 0 && "mt-1",
              )}
            >
              {group.label}
            </div>
            {group.items.map((item) => (
              <SidebarLink key={item.to} item={item} />
            ))}
            {group.label === "設定" && (
              <SidebarActionButton
                icon={ICON_TERMINAL}
                label="工程模式"
                onMouseEnter={() => {
                  void importEngineeringModal();
                }}
                onFocus={() => {
                  void importEngineeringModal();
                }}
                onClick={() => {
                  setEngineeringOpen(true);
                }}
              />
            )}
          </div>
        ))}
      </nav>

      {/* User footer */}
      <div
        className="shrink-0 border-t border-border px-2 pt-2.5"
        style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}
      >
        <div
          className="relative"
          // Mobile drawer: the parent <aside> has a belt-and-suspenders
          // onClick that closes the drawer for any non-link tap. Without
          // stopping propagation here the user-name tap would close the drawer.
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className={cn(
              "flex w-full select-none items-center gap-2.5 rounded-lg px-2.5 py-2.5",
              "bg-transparent",
            )}
          >
            <button
              type="button"
              onClick={() => setIdentityOpen(true)}
              aria-label="登入身分"
              title="登入身分"
              className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-orange-bg text-[12px] font-bold text-orange transition hover:ring-2 hover:ring-orange/40 active:scale-95"
            >
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
            </button>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
              <span className="w-full truncate text-[13px] font-semibold text-ink">
                {user?.name ?? ""}
              </span>
              <span className="flex max-w-full items-center gap-1.5">
                {sub && <TierBadge tier={sub.tier} />}
                <BucuHeaderChip />
              </span>
            </div>
            {/* Logout — was a row in the 設定 nav group up until
                2026-05-27; moved to the footer at the user's request
                so the arrow-out icon sits next to the avatar that
                identifies *who* is being signed out. */}
            <button
              type="button"
              onClick={() => {
                void logout();
              }}
              aria-label="登出"
              title="登出"
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400",
                "transition-colors hover:bg-orange-bg hover:text-orange active:scale-95",
              )}
            >
              {ICON_LOGOUT}
            </button>
          </div>
        </div>
      </div>
      {engineeringOpen && (
        <Suspense fallback={null}>
          <EngineeringModal open={engineeringOpen} onOpenChange={setEngineeringOpen} />
        </Suspense>
      )}
      <IdentityModal open={identityOpen} onOpenChange={setIdentityOpen} />
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
          "mb-0.5 flex min-h-[32px] select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5",
          "text-[13px] font-medium transition-[all] duration-150 cursor-pointer",
          "active:scale-[0.98]",
          isActive
            ? "bg-orange-bg font-semibold text-orange"
            : "text-gray-500 hover:bg-orange-bg hover:text-orange",
        )
      }
    >
      <span className="flex w-[18px] shrink-0 items-center justify-center">{item.icon}</span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.beta && <BetaTag />}
    </NavLink>
  );
}

function BetaTag() {
  return (
    <span className="shrink-0 rounded-full bg-orange-bg px-1.5 py-[1px] text-[9px] font-bold uppercase tracking-wider text-orange">
      Beta
    </span>
  );
}

function SidebarActionButton({
  icon,
  label,
  onClick,
  onMouseEnter,
  onFocus,
}: {
  icon: JSX.Element;
  label: string;
  onClick: () => void;
  onMouseEnter?: () => void;
  onFocus?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onFocus={onFocus}
      className={cn(
        "mb-0.5 flex min-h-[32px] w-full select-none items-center gap-2.5 rounded-lg px-2.5 py-1.5",
        "text-[13px] font-medium text-gray-500 transition-[all] duration-150 cursor-pointer",
        "hover:bg-orange-bg hover:text-orange active:scale-[0.98]",
      )}
    >
      <span className="flex w-[18px] shrink-0 items-center justify-center">{icon}</span>
      {label}
    </button>
  );
}
