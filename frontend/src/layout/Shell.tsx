import { DataPreloader, didPreload } from "@/components/DataPreloader";
import { EmptyAccountsPrompt } from "@/components/EmptyAccountsPrompt";
import { FbUsageBanner } from "@/components/FbUsageBanner";
import { useCallback, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";

/**
 * Authenticated app shell — fixed sidebar on the left, flex main
 * content on the right. The <Outlet/> renders whichever view the
 * current route matched.
 *
 * Mobile (<= 768px): the sidebar slides off-screen and the main
 * content fills the full width. The hamburger in the Topbar
 * (via MobileToggleContext) toggles the open state. Sidebar
 * auto-closes on route change so clicking a nav item immediately
 * reveals the selected view.
 *
 * No bottom tab bar — replaced by the hamburger + sidebar drawer
 * pattern (2026-04-27 redesign). The sidebar's user dropdown
 * provides the logout entry point on mobile.
 */
export function Shell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  // Views (<Outlet/>) are NOT rendered until preloading finishes.
  // This prevents views from firing their own queries (which race
  // with the preloader and produce transient error banners).
  const [preloadDone, setPreloadDone] = useState(didPreload);
  const onPreloadComplete = useCallback(() => setPreloadDone(true), []);
  const { pathname } = useLocation();

  // Close the sidebar whenever the route changes — avoids the
  // "tap nav item, nothing seems to happen" trap where the sidebar
  // covers the new view. `pathname` is the effect trigger; the
  // `void` read satisfies biome's exhaustive-deps check.
  useEffect(() => {
    void pathname;
    setMobileOpen(false);
  }, [pathname]);

  const closeOnBackdrop = useCallback(() => setMobileOpen(false), []);

  return (
    <div className="shell-root flex h-[100dvh] overflow-hidden">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      {mobileOpen && (
        <button
          type="button"
          aria-label="關閉側邊欄"
          className="shell-backdrop fixed inset-0 z-[90] hidden bg-black/40"
          onClick={closeOnBackdrop}
        />
      )}
      {/* Mobile: padding-bottom uses env(safe-area-inset-bottom) so
          content extends to the screen edge but doesn't render under
          the iOS home indicator. Desktop env() resolves to 0 (no-op). */}
      <main
        className="shell-main ml-sidebar flex h-[100dvh] flex-1 flex-col overflow-x-hidden overflow-y-auto bg-bg"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <MobileToggleContext.Provider value={() => setMobileOpen((v) => !v)}>
          {preloadDone && (
            <>
              {/* Sticky-top BUCU warning — surfaces when any account
                  crosses 70% so the operator notices before throttle
                  hits. Always rendered (component returns null when
                  below threshold), no per-view wiring. */}
              <FbUsageBanner />
              <Outlet />
            </>
          )}
        </MobileToggleContext.Provider>
      </main>
      {preloadDone && <EmptyAccountsPrompt />}
      <DataPreloader onComplete={onPreloadComplete} />
    </div>
  );
}

// ── Mobile toggle context ───────────────────────────────────
// A tiny context so Topbar can expose a hamburger button without
// every view having to wire up props. The consumer just calls
// `useMobileSidebarToggle()` to get a click handler.
import { createContext, useContext } from "react";
const MobileToggleContext = createContext<(() => void) | null>(null);

/** Hook returning a function that toggles the mobile sidebar. */
export function useMobileSidebarToggle(): () => void {
  const fn = useContext(MobileToggleContext);
  return fn ?? (() => {});
}
