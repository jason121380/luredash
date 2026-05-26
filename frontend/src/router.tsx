import { LoadingState } from "@/components/LoadingState";
import { Shell } from "@/layout/Shell";
import { withReloadOnChunkError } from "@/lib/chunkReload";
import { DashboardView } from "@/views/dashboard/DashboardView";
import { type ReactNode, Suspense, lazy } from "react";
import { Navigate, createBrowserRouter } from "react-router-dom";

/**
 * Browser router — 6 authenticated routes inside a <Shell/> layout
 * route, plus a root redirect. The auth guard is NOT in the router:
 * <App/> conditionally renders <LoginView/> vs <RouterProvider/>
 * based on useFbAuth().status, so unauthenticated users never see
 * any protected route path.
 *
 * Code-splitting: only <DashboardView/> ships in the main bundle
 * (it's the landing page). The remaining 5 views are lazy-loaded
 * on demand via React.lazy(). This shrinks the initial JS payload
 * substantially and cuts time-to-first-meaningful-paint.
 *
 * Each lazy import is also exposed as a ``prefetch*`` function so
 * the sidebar can start the network request on hover/touchstart and
 * the view appears instantly when the user actually navigates.
 */

// Memoised import promises so prefetch + lazy resolve to the same chunk.
const importAnalytics = () => import("@/views/analytics/AnalyticsView");
const importAlerts = () => import("@/views/alerts/AlertsView");
const importSecurity = () => import("@/views/security/SecurityMonitorView");
const importOptimization = () => import("@/views/optimization/OptimizationView");
const importFinance = () => import("@/views/finance/FinanceView");
const importHistory = () => import("@/views/history/HistoryView");
const importStoreExpenses = () => import("@/views/storeExpenses/StoreExpensesView");
const importLaunch = () => import("@/views/launch/QuickLaunchView");
const importSettings = () => import("@/views/settings/SettingsView");
const importLinePush = () => import("@/views/settings/LinePushSettingsView");
const importPaymentAccounts = () => import("@/views/settings/PaymentAccountsView");
const importPricing = () => import("@/views/pricing/PricingView");
const importBilling = () => import("@/views/billing/BillingView");

const AnalyticsView = lazy(() =>
  withReloadOnChunkError(importAnalytics)().then((m) => ({ default: m.AnalyticsView })),
);
const AlertsView = lazy(() =>
  withReloadOnChunkError(importAlerts)().then((m) => ({ default: m.AlertsView })),
);
const SecurityMonitorView = lazy(() =>
  withReloadOnChunkError(importSecurity)().then((m) => ({ default: m.SecurityMonitorView })),
);
const OptimizationView = lazy(() =>
  withReloadOnChunkError(importOptimization)().then((m) => ({ default: m.OptimizationView })),
);
const FinanceView = lazy(() =>
  withReloadOnChunkError(importFinance)().then((m) => ({ default: m.FinanceView })),
);
const HistoryView = lazy(() =>
  withReloadOnChunkError(importHistory)().then((m) => ({ default: m.HistoryView })),
);
const StoreExpensesView = lazy(() =>
  withReloadOnChunkError(importStoreExpenses)().then((m) => ({
    default: m.StoreExpensesView,
  })),
);
const QuickLaunchView = lazy(() =>
  withReloadOnChunkError(importLaunch)().then((m) => ({ default: m.QuickLaunchView })),
);
const SettingsView = lazy(() =>
  withReloadOnChunkError(importSettings)().then((m) => ({ default: m.SettingsView })),
);
const LinePushSettingsView = lazy(() =>
  withReloadOnChunkError(importLinePush)().then((m) => ({ default: m.LinePushSettingsView })),
);
const PaymentAccountsView = lazy(() =>
  withReloadOnChunkError(importPaymentAccounts)().then((m) => ({
    default: m.PaymentAccountsView,
  })),
);
const PricingView = lazy(() =>
  withReloadOnChunkError(importPricing)().then((m) => ({ default: m.PricingView })),
);
const BillingView = lazy(() =>
  withReloadOnChunkError(importBilling)().then((m) => ({ default: m.BillingView })),
);

/** Trigger an early download of a view's JS chunk before navigation. */
export const prefetchView = (path: string): void => {
  switch (path) {
    case "/analytics":
      void importAnalytics();
      return;
    case "/alerts":
      void importAlerts();
      return;
    case "/security":
      void importSecurity();
      return;
    case "/optimization":
      void importOptimization();
      return;
    case "/finance":
      void importFinance();
      return;
    case "/history":
      void importHistory();
      return;
    case "/store-expenses":
      void importStoreExpenses();
      return;
    case "/launch":
      void importLaunch();
      return;
    case "/settings":
      void importSettings();
      return;
    case "/line-push":
      void importLinePush();
      return;
    case "/payment-accounts":
      void importPaymentAccounts();
      return;
    case "/pricing":
      void importPricing();
      return;
    case "/billing":
      void importBilling();
      return;
  }
};

function lazyView(node: ReactNode) {
  return <Suspense fallback={<LoadingState title="載入頁面中..." />}>{node}</Suspense>;
}

export const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: "dashboard", element: <DashboardView /> },
      { path: "analytics", element: lazyView(<AnalyticsView />) },
      { path: "alerts", element: lazyView(<AlertsView />) },
      { path: "security", element: lazyView(<SecurityMonitorView />) },
      { path: "optimization", element: lazyView(<OptimizationView />) },
      { path: "finance", element: lazyView(<FinanceView />) },
      { path: "history", element: lazyView(<HistoryView />) },
      { path: "store-expenses", element: lazyView(<StoreExpensesView />) },
      { path: "launch", element: lazyView(<QuickLaunchView />) },
      { path: "settings", element: lazyView(<SettingsView />) },
      { path: "line-push", element: lazyView(<LinePushSettingsView />) },
      { path: "payment-accounts", element: lazyView(<PaymentAccountsView />) },
      { path: "pricing", element: lazyView(<PricingView />) },
      { path: "billing", element: lazyView(<BillingView />) },
      { path: "*", element: <Navigate to="/dashboard" replace /> },
    ],
  },
]);
