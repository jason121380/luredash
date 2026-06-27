import { api, apiAuthHeaders } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { useShowBucuInHeader } from "@/components/BucuHeaderChip";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { ProgressBar } from "@/components/ProgressBar";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/cn";
import { queryClient } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

/**
 * Returns true when the tab is currently visible (i.e. user is looking
 * at this page). All polling panels use this to STOP firing requests
 * when the user has switched tabs — saves a /api/engineering/memory
 * (cheap) and /api/engineering/fb-calls (cheap but adds backend load)
 * call every 10s for every backgrounded EngineeringView tab.
 */
const subscribeVisibility = (cb: () => void) => {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
};
const getVisibilitySnapshot = () => document.visibilityState === "visible";
const getVisibilitySnapshotServer = () => true;
function useTabVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    getVisibilitySnapshot,
    getVisibilitySnapshotServer,
  );
}

/**
 * 工程模式 (Engineering Mode) — internal health / diagnostic view.
 *
 * Rendered as a Modal (opened from the avatar dropdown) instead of a
 * full page route — the operator usually wants to glance at the
 * diagnostics without leaving whatever view they were on. Panels are
 * all read-only observers of state that already exists somewhere;
 * each panel auto-refreshes its own source.
 *
 * Polling panels gate their `refetchInterval` on tab visibility so a
 * closed modal stops issuing requests immediately (the Modal unmounts
 * children when `open` flips false).
 */
type EngineeringTab = "dashboard" | "ad-account" | "cost-center" | "other";

const ENGINEERING_TABS: Array<{
  id: EngineeringTab;
  label: string;
  mobileLabel: string;
  subtitle: string;
}> = [
  {
    id: "dashboard",
    label: "FB 限流戰情室",
    mobileLabel: "戰情室",
    subtitle: "即時 FB 呼叫 / 節流總覽",
  },
  {
    id: "ad-account",
    label: "各帳戶 FB 限流",
    mobileLabel: "各帳戶",
    subtitle: "FB API 節流狀態",
  },
  {
    id: "cost-center",
    label: "費用中心歷史回填",
    mobileLabel: "歷史回填",
    subtitle: "逐月撈取存進資料庫",
  },
  {
    id: "other",
    label: "其他",
    mobileLabel: "其他",
    subtitle: "其他診斷",
  },
];

function EngineeringPanels() {
  const [activeTab, setActiveTab] = useState<EngineeringTab>("dashboard");
  const activeMeta = ENGINEERING_TABS.find((t) => t.id === activeTab) ?? ENGINEERING_TABS[0];

  return (
    <div className="grid gap-4 md:h-[calc(100dvh-140px)] md:min-h-0 md:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="md:sticky md:top-0 md:self-start">
        <div
          className="flex gap-1 overflow-x-auto rounded-lg bg-bg p-1 md:flex-col md:gap-2 md:overflow-visible md:bg-transparent md:p-0"
          role="tablist"
          aria-label="工程模式分類"
        >
          {ENGINEERING_TABS.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "min-w-[104px] flex-1 select-none rounded-md px-2 py-2 text-center transition-[all] duration-150 active:scale-[0.98] md:min-w-0 md:flex-none md:rounded-lg md:px-2.5 md:text-left",
                  selected
                    ? "bg-orange-bg text-orange"
                    : "text-gray-500 hover:bg-orange-bg hover:text-orange",
                )}
              >
                <div
                  className={cn(
                    "text-[12px] leading-tight md:text-[13px]",
                    selected ? "font-semibold" : "font-medium",
                  )}
                >
                  <span className="md:hidden">{tab.mobileLabel}</span>
                  <span className="hidden md:inline">{tab.label}</span>
                </div>
                <div
                  className={cn(
                    "mt-1 hidden text-[10px] leading-tight md:block",
                    selected ? "text-orange/70" : "text-gray-400",
                  )}
                >
                  {tab.subtitle}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <div
        role="tabpanel"
        aria-label={activeMeta?.label ?? "工程模式"}
        className="min-w-0 md:min-h-0 md:overflow-y-auto md:pr-2"
      >
        {activeTab === "dashboard" ? (
          <FbCallsPanel />
        ) : activeTab === "ad-account" ? (
          <FbUsagePanel />
        ) : activeTab === "cost-center" ? (
          <CostCenterBackfillPanel />
        ) : (
          <RuntimeDiagnosticsPanel />
        )}
      </div>
    </div>
  );
}

export function EngineeringModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="工程模式"
      width={1100}
      className="max-h-[92dvh] md:h-[calc(100dvh-48px)] md:max-h-[calc(100dvh-48px)] md:overflow-hidden"
    >
      <EngineeringPanels />
    </Modal>
  );
}

function RuntimeDiagnosticsPanel() {
  return (
    <section>
      <header className="mb-3">
        <h2 className="text-[15px] font-bold text-ink">其他</h2>
        <p className="mt-0.5 text-xs text-gray-400">
          其他診斷:身分、記憶體、前端快取與本機環境。
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-2">
        <IdentityPanel />
        <MemoryPanel />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <ReactQueryPanel />
        <ApiHealthPanel />
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <BrowserPanel />
        <StoragePanel />
      </div>
    </section>
  );
}

// ── 費用中心歷史回填 ─────────────────────────────────────────
//
// 逐月把「費用中心」的帳號資料從 FB 撈下來存進 DB。過往月份是固定的,
// 存一次之後 lurefin 讀 /api/cost-center 就直接讀 DB、不再打 FB。每列一
// 個「更新」按鈕(可重抓覆蓋),撈取時跑進度條,完成寫「完成」。

interface CcRowState {
  status: "idle" | "running" | "done" | "error";
  progress: number; // 0-100
  message?: string;
}

function fmtCcMonth(m: string): string {
  const [y, mm] = m.split("-");
  return `${y}/${Number.parseInt(mm ?? "0", 10)}`;
}

function fmtCcTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-TW", { hour12: false });
}

function CostCenterBackfillPanel() {
  const monthsQuery = useQuery({
    queryKey: ["cc-backfill-months"],
    queryFn: () => api.engineering.costCenterMonths(),
    staleTime: 30_000,
  });
  const [rowState, setRowState] = useState<Record<string, CcRowState>>({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const timersRef = useRef<Record<string, number>>({});

  // Clear any running fake-progress timers on unmount (modal close).
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id of Object.values(timers)) window.clearInterval(id);
    };
  }, []);

  const data = monthsQuery.data;
  const accounts = data?.accounts ?? [];
  // Newest month first in the table.
  const rows = useMemo(() => [...(data?.months ?? [])].reverse(), [data?.months]);

  const setRS = (month: string, s: Partial<CcRowState>) =>
    setRowState((prev) => ({
      ...prev,
      [month]: { ...(prev[month] ?? { status: "idle", progress: 0 }), ...s },
    }));

  // Capture one month — runs an asymptotic fake-progress bar while the
  // (single, slow) request is in flight, then snaps to 100% on done.
  const capture = async (month: string): Promise<boolean> => {
    setRS(month, { status: "running", progress: 8, message: undefined });
    const start = Date.now();
    const tick = window.setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      const p = Math.min(90, 8 + 82 * (1 - Math.exp(-elapsed / 12)));
      setRS(month, { progress: p });
    }, 400);
    timersRef.current[month] = tick;
    try {
      const res = await api.engineering.costCenterCapture(month);
      window.clearInterval(tick);
      if (res.stored) {
        setRS(month, { status: "done", progress: 100, message: `完成 · ${res.rows} 列` });
        return true;
      }
      const errs = res.accounts
        .filter((a) => a.fetch_error)
        .map((a) => `${a.account}:${a.fetch_error}`);
      setRS(month, {
        status: "error",
        progress: 100,
        message: errs.length ? errs.join(" / ") : "沒抓到資料(該月無花費或被限流),可重抓",
      });
      return false;
    } catch (e) {
      window.clearInterval(tick);
      const msg =
        (e as { detail?: string })?.detail ?? (e instanceof Error ? e.message : "未知錯誤");
      setRS(month, { status: "error", progress: 100, message: msg });
      return false;
    }
  };

  const onCapture = async (month: string) => {
    const ok = await capture(month);
    await monthsQuery.refetch();
    toast(ok ? `${fmtCcMonth(month)} 已更新` : `${fmtCcMonth(month)} 更新失敗`, ok ? undefined : "error");
  };

  // Bulk: oldest → newest, sequential (one at a time) so we don't fan
  // out heavy FB pulls in parallel.
  const onBulk = async () => {
    if (bulkRunning) return;
    setBulkRunning(true);
    try {
      let done = 0;
      let fail = 0;
      for (const m of data?.months ?? []) {
        const ok = await capture(m.month);
        if (ok) done += 1;
        else fail += 1;
      }
      await monthsQuery.refetch();
      toast(`全部完成:成功 ${done}、失敗 ${fail}`, fail ? "error" : undefined);
    } finally {
      setBulkRunning(false);
    }
  };

  return (
    <Card
      title="費用中心歷史回填"
      subtitle="逐月把費用中心資料從 FB 撈下來存進資料庫(過往月份存一次即可,lurefin 之後直接讀 DB)。可重抓覆蓋。"
      frameless
      action={
        <Button size="sm" onClick={() => void onBulk()} disabled={bulkRunning || monthsQuery.isLoading}>
          {bulkRunning ? "全部更新中…" : "全部更新(舊→新)"}
        </Button>
      }
    >
      {monthsQuery.isLoading ? (
        <div className="text-sm text-gray-400">載入中…</div>
      ) : !data ? (
        <div className="text-sm text-gray-400">無資料</div>
      ) : (
        <>
          <div className="mb-3 text-[11px] text-gray-400">
            帳號:{accounts.join("、")} · 當月({fmtCcMonth(data.current)})為即時抓取,可不必存。
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-[12px]">
              <thead className="bg-bg text-left text-gray-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">月份</th>
                  <th className="px-3 py-2 font-semibold">狀態 / 進度</th>
                  <th className="px-3 py-2 text-right font-semibold">資料筆數</th>
                  <th className="px-3 py-2 font-semibold whitespace-nowrap">更新時間</th>
                  <th className="px-3 py-2 text-right font-semibold">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const rs = rowState[m.month];
                  const running = rs?.status === "running";
                  return (
                    <tr key={m.month} className="border-t border-border align-middle">
                      <td className="whitespace-nowrap px-3 py-2 font-semibold text-ink">
                        {fmtCcMonth(m.month)}
                        {m.is_current ? (
                          <span className="ml-1.5 rounded-full bg-orange-bg px-1.5 py-0.5 text-[10px] font-semibold text-orange">
                            當月
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        {running || rs?.status === "done" ? (
                          <div className="flex items-center gap-2">
                            <ProgressBar
                              value={rs.progress}
                              size="sm"
                              tone={rs.status === "done" ? "ok" : "warm"}
                              className="min-w-[90px] flex-1"
                            />
                            <span
                              className={cn(
                                "shrink-0 text-[11px]",
                                rs.status === "done" ? "font-semibold text-emerald-600" : "text-gray-500",
                              )}
                            >
                              {running ? "撈取中…" : rs.message}
                            </span>
                          </div>
                        ) : rs?.status === "error" ? (
                          <span className="text-[11px] text-red-600" title={rs.message}>
                            失敗 · {rs.message}
                          </span>
                        ) : m.stored ? (
                          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                            已存
                          </span>
                        ) : (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                            未存
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">
                        {m.rows ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-[11px] text-gray-500">
                        {fmtCcTime(m.captured_at)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant={m.stored ? "ghost" : "primary"}
                          onClick={() => void onCapture(m.month)}
                          disabled={running || bulkRunning}
                        >
                          {running ? "撈取中…" : m.stored ? "重抓" : "更新"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

// ── Identity (fb_user_id copy) ───────────────────────────────
//
// Surfaces the logged-in user's fb_user_id with a 1-tap copy
// button. Used to hand admins the id they need for support
// tickets and DB lookups — saves digging through DevTools /
// network tabs to extract it from /api/auth/me responses.

function IdentityPanel() {
  const { user } = useFbAuth();
  const id = user?.id ?? "";

  const onCopy = async () => {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      toast("已複製 fb_user_id");
    } catch {
      toast("複製失敗,請手動選取", "error");
    }
  };

  return (
    <Card title="登入身分" subtitle="目前登入的 Facebook 使用者 id">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
        <Row label="名稱" value={user?.name ?? "(未登入)"} />
        <Row label="fb_user_id" value={id || "(未登入)"} mono />
      </dl>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={onCopy} disabled={!id}>
          複製 fb_user_id
        </Button>
      </div>
    </Card>
  );
}

// ── Card ─────────────────────────────────────────────────────

function Card({
  title,
  subtitle,
  action,
  children,
  collapsible = false,
  defaultOpen = true,
  frameless = false,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  /** When true, the header becomes a toggle and content can be hidden.
   * Used by the two heavy panels (FB API 節流狀態 / 最近 FB 呼叫)
   * which the operator usually doesn't need open by default. */
  collapsible?: boolean;
  /** Initial open state when ``collapsible``. Ignored otherwise. */
  defaultOpen?: boolean;
  /** Remove the outer card chrome while keeping the title/action layout. */
  frameless?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const headerClass = "mb-3 flex items-start justify-between gap-3";
  return (
    <section
      className={cn(
        frameless ? "bg-transparent p-0" : "rounded-2xl border border-border bg-white p-4 md:p-5",
      )}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            headerClass,
            "-m-1 w-[calc(100%+0.5rem)] cursor-pointer rounded-lg p-1 text-left hover:bg-bg/60",
            open ? "" : "mb-0",
          )}
          aria-expanded={open}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn(
                  "shrink-0 text-gray-400 transition-transform",
                  open ? "rotate-90" : "rotate-0",
                )}
                aria-hidden="true"
              >
                <title>{open ? "收合" : "展開"}</title>
                <polyline points="9 18 15 12 9 6" />
              </svg>
              <h2 className="text-[15px] font-bold text-ink">{title}</h2>
            </div>
            {open && subtitle ? (
              <p className="mt-0.5 pl-[18px] text-xs text-gray-400">{subtitle}</p>
            ) : null}
          </div>
          {action && open ? (
            // Stop propagation so clicking the action button doesn't
            // also toggle the section open/close.
            <div
              className="shrink-0"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {action}
            </div>
          ) : null}
        </button>
      ) : (
        <header className={headerClass}>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-bold text-ink">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>
      )}
      {(!collapsible || open) && children}
    </section>
  );
}

// ── Server memory ────────────────────────────────────────────
//
// Process RSS vs host total. Pulled from /proc/self/status and
// /proc/meminfo on the backend; the panel here is a thin reactive
// strip matching the design: large number + percent + progress bar
// + a caption explaining the source. 10s refetch so it tracks live
// during AI 幕僚 / dashboard fan-out spikes.

function MemoryPanel() {
  const visible = useTabVisible();
  const query = useQuery({
    queryKey: ["engineering-memory"],
    queryFn: () => api.engineering.memory(),
    refetchInterval: visible ? 10_000 : false,
    staleTime: 0,
  });
  const data = query.data;
  const rss = data?.rss_mb ?? null;
  const total = data?.total_mb ?? null;
  const pct = data?.percent ?? null;
  const source = data?.source ?? "unavailable";

  const fmt = (v: number | null): string =>
    v === null ? "—" : `${v.toLocaleString("zh-TW")} MB`;
  const fmtPct = (v: number | null): string => (v === null ? "—" : `${v.toFixed(1)}%`);
  // Cap visual bar at 100% even if the backend somehow reports > 100.
  const barValue = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  // Colour by pressure: <50% warm(orange 漸層)/ 50-80% amber / >80% danger.
  const barTone = pct === null ? "warm" : pct >= 80 ? "danger" : pct >= 50 ? "amber" : "warm";

  return (
    <section className="rounded-2xl border border-border bg-white p-4 md:p-5">
      <div className="text-[13px] font-semibold text-gray-500">伺服器記憶體</div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[22px] font-bold tabular-nums text-ink md:text-[24px]">
          {fmt(rss)} <span className="text-gray-300">/</span> {fmt(total)}
        </div>
        <div className="text-[13px] font-semibold tabular-nums text-gray-500">{fmtPct(pct)}</div>
      </div>
      <div className="mt-2">
        <ProgressBar value={barValue} size="md" tone={barTone} ariaLabel="記憶體使用率" />
      </div>
      <div className="mt-2 text-[11px] text-gray-300">
        來源:{source === "proc" ? "主機" : "無法取得(非 Linux 環境)"}
        {rss !== null && (
          <>
            {"  ·  "}本服務 (RSS): {fmt(rss)}
          </>
        )}
      </div>
    </section>
  );
}

// ── FB rate-limit usage ──────────────────────────────────────

function FbUsagePanel() {
  const visible = useTabVisible();
  const usageQuery = useQuery({
    queryKey: ["fb-usage"],
    queryFn: () => api.engineering.fbUsage(),
    refetchInterval: visible ? 10_000 : false,
    staleTime: 0,
  });
  const accountsQuery = useAccounts();
  const [showBucuInHeader, setShowBucuInHeader] = useShowBucuInHeader();
  const peak = usageQuery.data?.peak_regain_minutes ?? 0;
  // Sort by total_time desc so the busiest rate-limit pool floats to
  // the top. Falls back to call_count then cputime when total_time
  // ties (typically 0/0/0 at startup).
  const entries = useMemo(() => {
    const e = Object.entries(usageQuery.data?.data ?? {});
    e.sort(([, a], [, b]) => {
      if (b.total_time !== a.total_time) return b.total_time - a.total_time;
      if (b.call_count !== a.call_count) return b.call_count - a.call_count;
      return b.total_cputime - a.total_cputime;
    });
    return e;
  }, [usageQuery.data]);

  // Build a map<bare numeric id, account/business name>. FB's
  // X-Business-Use-Case-Usage header keys entries by the bare numeric
  // id of either a Business Manager OR (for accounts not under a BM)
  // the ad account itself — we used to assume always-BM and labeled
  // every row "BM <id>", which was wrong for the majority of cases
  // where the id is actually an ad account.
  //
  // Lookup strategy: prefer the ad account name (most BUC entries are
  // ad account ids), fall back to the BM name. The same map handles
  // both since FB ids are globally unique across the two namespaces.
  const nameByBareId = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accountsQuery.data ?? []) {
      // Account id is "act_<digits>" — strip the prefix to match the
      // bare numeric key FB uses in the BUC header.
      if (a.id && a.name) {
        const bare = a.id.startsWith("act_") ? a.id.slice(4) : a.id;
        if (!m.has(bare)) m.set(bare, a.name);
      }
      const b = a.business;
      if (b?.id && b.name && !m.has(b.id)) m.set(b.id, b.name);
    }
    return m;
  }, [accountsQuery.data]);

  // Dev hint: when nothing matches, the IDs are coming from accounts
  // outside the user's `me/adaccounts` view (typically shared
  // accounts). Log once so the operator can confirm.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!usageQuery.data || !accountsQuery.data) return;
    const bucIds = Object.keys(usageQuery.data.data ?? {});
    const knownIds = new Set<string>();
    for (const a of accountsQuery.data) {
      if (a.id) {
        knownIds.add(a.id.startsWith("act_") ? a.id.slice(4) : a.id);
      }
      if (a.business?.id) knownIds.add(a.business.id);
    }
    const unmatched = bucIds.filter((id) => !knownIds.has(id));
    if (unmatched.length > 0) {
      console.log(
        "[fb-usage] BUC ids without matching account/BM:",
        unmatched,
      );
    }
  }, [usageQuery.data, accountsQuery.data]);

  return (
    <Card
      title="各帳戶 FB 限流"
      subtitle="FB API 節流狀態"
      frameless
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void usageQuery.refetch()}
          disabled={usageQuery.isFetching}
        >
          {usageQuery.isFetching ? "更新中…" : "立即更新"}
        </Button>
      }
    >
      {peak > 0 && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          ⚠ 部分業務已達節流閾值,Facebook 預估約 <b>{peak}</b> 分鐘後可恢復呼叫(此為 FB 的估算值,非精確倒數)
        </div>
      )}
      <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg/40 p-2.5 text-[12px]">
        <input
          type="checkbox"
          className="custom-cb mt-0.5"
          checked={showBucuInHeader}
          onChange={(e) => setShowBucuInHeader(e.currentTarget.checked)}
        />
        <div className="flex-1">
          <div className="font-semibold text-ink">在 header 顯示 BUCU%</div>
        </div>
      </label>
      {usageQuery.isLoading ? (
        <div className="text-sm text-gray-400">載入中…</div>
      ) : entries.length === 0 ? (
        <div className="text-sm text-gray-400">尚無資料——任何 FB API 呼叫之後會更新</div>
      ) : (
        <>
          {/* Mobile (<md): one card per row — table columns squeeze
              into characters-stacked-vertically at 390px wide. */}
          <div className="flex flex-col gap-2 md:hidden">
            {entries.map(([bareId, u]) => (
              <UsageMobileCard
                key={bareId}
                bareId={bareId}
                name={nameByBareId.get(bareId) ?? ""}
                usage={u}
              />
            ))}
          </div>
          {/* Desktop: full comparison table */}
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
          <table className="w-full text-[12px]">
            <thead className="bg-bg text-left text-gray-500">
              <tr>
                <th className="px-3 py-2 font-semibold">帳戶</th>
                <th className="px-3 py-2 font-semibold">呼叫次數</th>
                <th className="px-3 py-2 font-semibold">CPU 用量</th>
                <th className="px-3 py-2 font-semibold">處理時間</th>
                <th className="px-3 py-2 font-semibold whitespace-nowrap">更新</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([bareId, u]) => (
                <UsageRow
                  key={bareId}
                  bareId={bareId}
                  name={nameByBareId.get(bareId) ?? ""}
                  usage={u}
                />
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}
    </Card>
  );
}

function UsageMobileCard({
  bareId,
  name,
  usage,
}: {
  bareId: string;
  name: string;
  usage: {
    call_count: number;
    total_cputime: number;
    total_time: number;
    estimated_time_to_regain_access: number;
    type: string;
    observed_at: number;
  };
}) {
  const observedAgoSec = Math.max(0, Math.floor(Date.now() / 1000 - usage.observed_at));
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        {name ? (
          <span className="font-semibold text-ink">{name}</span>
        ) : (
          <span className="font-mono text-[12px] text-ink">{bareId}</span>
        )}
        {name ? (
          <span className="font-mono text-[10px] text-gray-400">{bareId}</span>
        ) : null}
        {usage.type ? (
          <span className="rounded-full bg-orange-bg px-1.5 py-0.5 text-[10px] font-semibold text-orange">
            {usage.type}
          </span>
        ) : null}
        {usage.estimated_time_to_regain_access > 0 ? (
          <span
            className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700"
            title="Facebook 估算約多久後可恢復呼叫,非精確倒數"
          >
            冷卻 {usage.estimated_time_to_regain_access}分
          </span>
        ) : null}
        <span className="ml-auto text-[10px] text-gray-400">{observedAgoSec}s 前</span>
      </div>
      <div className="flex flex-col gap-1.5">
        <MobileMetricRow label="呼叫次數" value={usage.call_count} />
        <MobileMetricRow label="CPU 用量" value={usage.total_cputime} />
        <MobileMetricRow label="處理時間" value={usage.total_time} />
      </div>
    </div>
  );
}

function MobileMetricRow({ label, value }: { label: string; value: number }) {
  const tone = value >= 80 ? "danger" : value >= 50 ? "amber" : "ok";
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-[52px] shrink-0 text-gray-500">{label}</span>
      <ProgressBar value={value} size="sm" tone={tone} className="flex-1" />
      <span className="w-[34px] shrink-0 text-right font-mono text-gray-600">{value}%</span>
    </div>
  );
}

function UsageRow({
  bareId,
  name,
  usage,
}: {
  bareId: string;
  name: string;
  usage: {
    call_count: number;
    total_cputime: number;
    total_time: number;
    estimated_time_to_regain_access: number;
    type: string;
    observed_at: number;
  };
}) {
  const observedAgoSec = Math.max(0, Math.floor(Date.now() / 1000 - usage.observed_at));
  return (
    <tr className="border-t border-border">
      <td className="px-3 py-2 align-middle">
        <div className="flex flex-col gap-0.5">
          {name ? (
            <span className="font-semibold text-ink">{name}</span>
          ) : (
            <span className="font-mono text-[12px] text-ink">{bareId}</span>
          )}
          {name ? (
            <span
              className="font-mono text-[10px] text-gray-400"
              title="Facebook 在 X-Business-Use-Case-Usage header 用的 ID"
            >
              {bareId}
            </span>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            {usage.type ? (
              <span className="rounded-full bg-orange-bg px-1.5 py-0.5 font-semibold text-orange">
                {usage.type}
              </span>
            ) : null}
            {usage.estimated_time_to_regain_access > 0 ? (
              <span
                className="rounded-full bg-red-100 px-1.5 py-0.5 font-semibold text-red-700"
                title="Facebook 估算約多久後可恢復呼叫,非精確倒數"
              >
                冷卻 約 {usage.estimated_time_to_regain_access} 分鐘
              </span>
            ) : null}
          </div>
        </div>
      </td>
      <td className="px-3 py-2 align-middle">
        <UsageCell value={usage.call_count} />
      </td>
      <td className="px-3 py-2 align-middle">
        <UsageCell value={usage.total_cputime} />
      </td>
      <td className="px-3 py-2 align-middle">
        <UsageCell value={usage.total_time} />
      </td>
      <td className="px-3 py-2 align-middle whitespace-nowrap text-[11px] text-gray-400">
        {observedAgoSec}s 前
      </td>
    </tr>
  );
}

function UsageCell({ value }: { value: number }) {
  const tone = value >= 80 ? "danger" : value >= 50 ? "amber" : "ok";
  return (
    <div className="flex items-center gap-2">
      <ProgressBar value={value} size="sm" tone={tone} className="min-w-[80px] flex-1" />
      <span className="w-[36px] shrink-0 text-right font-mono text-gray-600">{value}%</span>
    </div>
  );
}

// ── FB API call log (debug for rate-limit spikes) ────────────
//
// Surfaces the ring buffer + 5-min aggregates the backend keeps on
// every FB Graph API call. The point is to answer "what was the app
// doing right before FB 80004'd us?" without grepping prod logs.
//
// Three sections:
// 1. Aggregate cards — call count / cache hit rate / error count
//    over the last 5 minutes, plus a list of accounts currently in
//    cooldown.
// 2. Top paths + top accounts — which FB endpoints and which
//    ad accounts received the most calls in the last 5 minutes. This
//    is where the actual culprit shows up.
// 3. Recent calls — newest-first table of individual calls so we can
//    see the exact ordering / cache-hit pattern leading up to a
//    throttle event.

function FbCallsPanel() {
  const visible = useTabVisible();
  const query = useQuery({
    queryKey: ["fb-calls"],
    queryFn: () => api.engineering.fbCalls(),
    refetchInterval: visible ? 10_000 : false,
    staleTime: 0,
  });
  const data = query.data;

  // act_xxx → 中文帳戶名稱 lookup. useAccounts is already cached at
  // app-level (5min staleTime) — pulling it here adds no FB calls.
  const accountsQuery = useAccounts();
  const nameByActId = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accountsQuery.data ?? []) {
      if (a.id && a.name) m.set(a.id, a.name);
    }
    return m;
  }, [accountsQuery.data]);
  const nameFor = (aid: string | null | undefined): string | null => {
    if (!aid) return null;
    return nameByActId.get(aid) ?? null;
  };

  // Default ON — cache hits are noise(同帳戶連看 3 筆綠色「快取」),
  // operator 大部分時候想看的是「真的打 FB 的」。
  const [hideCacheHits, setHideCacheHits] = useState(true);
  const recent = useMemo(() => {
    const r = data?.recent ?? [];
    // Newest first for the table — backend returns oldest-first.
    const reversed = [...r].reverse();
    const filtered = hideCacheHits ? reversed.filter((e) => !e.cache_hit) : reversed;
    return filtered.slice(0, 50);
  }, [data?.recent, hideCacheHits]);

  const cooldowns = useMemo(() => {
    const ent = Object.entries(data?.account_throttle_until ?? {});
    return ent
      .map(([aid, deadlineSec]) => ({
        accountId: aid,
        remainingSec: Math.max(0, Math.floor(deadlineSec - Date.now() / 1000)),
      }))
      .filter((c) => c.remainingSec > 0)
      .sort((a, b) => b.remainingSec - a.remainingSec);
  }, [data?.account_throttle_until]);
  const globalCooldownRemainingSec = data?.global_throttle_until
    ? Math.max(0, Math.floor(data.global_throttle_until - Date.now() / 1000))
    : 0;

  const formatTs = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString("zh-TW", { hour12: false });
  };
  const formatStatusBadge = (e: NonNullable<typeof recent>[number]) => {
    if (e.cache_hit) {
      return (
        <span
          className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700"
          title="本機快取命中 — 沒打 FB,免費"
        >
          快取
        </span>
      );
    }
    if (e.error_code === 80004 && e.status === 429 && e.ms === 0) {
      return (
        <span
          className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700"
          title="該帳戶在 80004 冷卻中,被前端 gate 擋下沒打 FB"
        >
          已擋
        </span>
      );
    }
    if (e.status === 200) {
      return (
        <span
          className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700"
          title="HTTP 200:FB 回應成功"
        >
          成功
        </span>
      );
    }
    if (e.status === 429) {
      return (
        <span
          className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700"
          title="HTTP 429:FB 節流(被 rate limit)"
        >
          節流
        </span>
      );
    }
    if (e.status === 504) {
      return (
        <span
          className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700"
          title="HTTP 504:後端等 FB 等超過 20s 逾時"
        >
          逾時
        </span>
      );
    }
    if (e.status >= 500) {
      return (
        <span
          className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700"
          title={`HTTP ${e.status}:FB 或我們的伺服器出錯`}
        >
          伺服器錯
        </span>
      );
    }
    if (e.status >= 400) {
      return (
        <span
          className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700"
          title={`HTTP ${e.status}:請求參數被 FB 拒絕(看路徑欄的 fb=<code>)`}
        >
          參數錯
        </span>
      );
    }
    return (
      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-700">
        {e.status}
      </span>
    );
  };
  // 觸發來源中文化 + 配色,讓 operator 一眼分辨「背景在跑什麼」
  // vs「我自己剛點了什麼」。Source 由後端透過 contextvar 傳上來。
  const formatSourceBadge = (source: string) => {
    const meta: Record<string, { label: string; cls: string }> = {
      warm: { label: "Cache 預熱", cls: "bg-blue-100 text-blue-700" },
      "line-push": { label: "LINE 推播", cls: "bg-purple-100 text-purple-700" },
      "security-push": { label: "安全防護自動掃", cls: "bg-orange-100 text-orange-700" },
      "security-probe": { label: "安全防護 probe", cls: "bg-amber-50 text-amber-700" },
      "security-test": { label: "安全防護測試", cls: "bg-amber-100 text-amber-700" },
      "security-scan": { label: "安全防護掃描", cls: "bg-orange-100 text-orange-700" },
      dashboard: { label: "儀表板", cls: "bg-emerald-50 text-emerald-700" },
      alerts: { label: "警示列表", cls: "bg-emerald-50 text-emerald-700" },
      finance: { label: "費用中心", cls: "bg-emerald-50 text-emerald-700" },
      analytics: { label: "數據圖表", cls: "bg-emerald-50 text-emerald-700" },
      history: { label: "歷史花費", cls: "bg-emerald-50 text-emerald-700" },
      preload: { label: "登入預載", cls: "bg-cyan-50 text-cyan-700" },
      auth: { label: "登入驗證", cls: "bg-cyan-50 text-cyan-700" },
      "store-expenses": { label: "店家花費", cls: "bg-emerald-50 text-emerald-700" },
      "ai-staff": { label: "優化中心", cls: "bg-emerald-50 text-emerald-700" },
      view: { label: "瀏覽畫面", cls: "bg-gray-100 text-gray-700" },
      report: { label: "報告頁", cls: "bg-gray-100 text-gray-700" },
      // ── 各種 drill-down / 單次 fetch — 共用灰色 ──
      "accounts-list": { label: "帳戶清單", cls: "bg-gray-100 text-gray-700" },
      "account-insights": { label: "帳戶數據", cls: "bg-gray-100 text-gray-700" },
      "campaigns-list": { label: "活動清單", cls: "bg-gray-100 text-gray-700" },
      activities: { label: "編輯紀錄", cls: "bg-gray-100 text-gray-700" },
      "security-drill-campaign": { label: "安全防護成效", cls: "bg-gray-100 text-gray-700" },
      "security-drill-adsets": { label: "安全防護預算", cls: "bg-gray-100 text-gray-700" },
      "drill-adsets": { label: "點開廣告組合", cls: "bg-gray-100 text-gray-700" },
      "drill-ads": { label: "點開廣告", cls: "bg-gray-100 text-gray-700" },
      breakdown: { label: "分眾分析", cls: "bg-gray-100 text-gray-700" },
      media: { label: "媒體載入", cls: "bg-gray-100 text-gray-700" },
      mutation: { label: "修改操作", cls: "bg-pink-50 text-pink-700" },
      unknown: { label: "未標記", cls: "bg-gray-50 text-gray-500" },
    };
    const m = meta[source] ?? { label: source || "未標記", cls: "bg-gray-50 text-gray-500" };
    return (
      <span
        className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]", m.cls)}
        title={`原始 source tag: ${source || "(empty)"}`}
      >
        {m.label}
      </span>
    );
  };
  const sourceReason = (source: string) => {
    const reasons: Record<string, string> = {
      warm: "背景 cache 預熱",
      "line-push": "活動推播排程",
      "security-push": "安全防護自動檢查",
      "security-probe": "安全防護輕量探測",
      "security-test": "安全防護推播測試",
      "security-scan": "安全防護手動檢查",
      dashboard: "儀表板資料載入",
      alerts: "警示列表載入",
      finance: "費用中心資料載入",
      analytics: "數據圖表載入",
      history: "歷史花費查詢",
      preload: "登入後預載",
      auth: "登入驗證",
      "store-expenses": "店家花費查詢",
      "ai-staff": "優化中心查詢",
      view: "一般畫面載入",
      report: "報告頁載入",
      "accounts-list": "帳戶清單查詢",
      "account-insights": "帳戶成效查詢",
      "campaigns-list": "活動清單查詢",
      activities: "編輯紀錄查詢",
      "security-drill-campaign": "安全防護展開單筆補查已花費",
      "security-drill-adsets": "安全防護展開單筆補查廣告組合預算",
      "drill-adsets": "展開廣告組合",
      "drill-ads": "展開廣告",
      breakdown: "分眾分析查詢",
      media: "素材媒體載入",
      mutation: "修改 FB 物件",
      unknown: "未標記呼叫來源",
    };
    return reasons[source] ?? "自訂或尚未歸類來源";
  };

  return (
    <Card
      title="FB 限流戰情室"
      subtitle="只看真正 matter 的訊號:誰觸發、為什麼打、狀態如何、是否被我們擋下。此頁本身不打 FB。"
      frameless
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? "更新中…" : "立即更新"}
        </Button>
      }
    >
      {query.isLoading ? (
        <div className="text-sm text-gray-400">載入中…</div>
      ) : !data ? (
        <div className="text-sm text-gray-400">無資料</div>
      ) : (
        <>
          {/* Aggregate cards */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6">
            <Stat
              label="真實 FB 呼叫"
              value={data.live_total_5m}
              tone={data.live_total_5m > 30 ? "warn" : "default"}
            />
            <Stat label="全部事件" value={data.total_5m} />
            <Stat
              label="Cache 命中率"
              value={Math.round(data.cache_hit_rate_5m * 100)}
              tone={data.cache_hit_rate_5m >= 0.5 ? "ok" : "warn"}
            />
            <Stat
              label="5 分鐘錯誤"
              value={data.error_count_5m}
              tone={data.error_count_5m > 0 ? "err" : "default"}
            />
            <Stat
              label="主動擋下"
              value={data.blocked_total_5m}
              tone={data.blocked_total_5m > 0 ? "warn" : "default"}
            />
            <Stat
              label="Retry"
              value={data.retried_total_5m}
              tone={data.retried_total_5m > 0 ? "warn" : "default"}
            />
          </div>
          {data.status_counts_5m.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
              <span className="font-semibold text-gray-400">狀態分布</span>
              {data.status_counts_5m.map((s) => (
                <span
                  key={s.status}
                  className={cn(
                    "rounded px-1.5 py-0.5 font-mono",
                    Number(s.status) >= 400
                      ? "bg-red-50 text-red-700"
                      : "bg-gray-100 text-gray-600",
                  )}
                >
                  {s.status}:{s.count}
                </span>
              ))}
            </div>
          ) : null}

          {globalCooldownRemainingSec > 0 && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              <div className="font-semibold">全域 FB API 冷卻中</div>
              <div className="mt-0.5">
                code 4/17/32/613 這類 app/user/page bucket 已觸發，剩餘約{" "}
                {Math.floor(globalCooldownRemainingSec / 60)}分{globalCooldownRemainingSec % 60}秒。
                期間所有 FB 呼叫會 fail-fast，不會繼續打 FB。
              </div>
            </div>
          )}

          {/* Per-account cooldowns */}
          {cooldowns.length > 0 && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px]">
              <div className="mb-1 font-semibold text-red-700">節流冷卻中</div>
              <ul className="flex flex-col gap-0.5 text-red-700">
                {cooldowns.map((c) => {
                  const nm = nameFor(c.accountId);
                  return (
                    <li key={c.accountId} className="flex flex-wrap items-baseline gap-1.5">
                      {nm ? <span className="font-semibold">{nm}</span> : null}
                      <span className="font-mono text-[10px] opacity-60">{c.accountId}</span>
                      <span>
                        — 剩餘 {Math.floor(c.remainingSec / 60)}分{c.remainingSec % 60}秒
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Source root-cause table */}
          <div className="mt-3">
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.6px] text-gray-400">
              5 分鐘來源 / 原因 / 狀態
            </h3>
            {data.top_sources_5m.length === 0 ? (
              <div className="text-[12px] text-gray-400">尚無資料</div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-bg text-left text-gray-500">
                    <tr>
                      <th className="px-2 py-1 font-semibold">來源</th>
                      <th className="px-2 py-1 font-semibold">原因</th>
                      <th className="px-2 py-1 text-right font-semibold">真打</th>
                      <th className="px-2 py-1 text-right font-semibold">Cache</th>
                      <th className="px-2 py-1 text-right font-semibold">已擋</th>
                      <th className="px-2 py-1 text-right font-semibold">錯誤</th>
                      <th className="px-2 py-1 text-right font-semibold">Retry</th>
                      <th className="px-2 py-1 font-semibold">最後狀態</th>
                      <th className="px-2 py-1 font-semibold">最後路徑</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.top_sources_5m.map((s) => (
                      <tr key={s.source} className="border-t border-border">
                        <td className="px-2 py-1">{formatSourceBadge(s.source)}</td>
                        <td className="px-2 py-1 text-gray-600">{sourceReason(s.source)}</td>
                        <td className="px-2 py-1 text-right font-mono text-ink">{s.live}</td>
                        <td className="px-2 py-1 text-right font-mono text-emerald-700">{s.cache_hits}</td>
                        <td className="px-2 py-1 text-right font-mono text-amber-700">{s.blocked}</td>
                        <td
                          className={cn(
                            "px-2 py-1 text-right font-mono",
                            s.errors > 0 ? "text-red-600" : "text-gray-500",
                          )}
                        >
                          {s.errors}
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-gray-500">{s.retried}</td>
                        <td className="px-2 py-1 font-mono text-gray-600">{s.last_status || "—"}</td>
                        <td className="max-w-[320px] truncate px-2 py-1 font-mono text-gray-500" title={s.last_path}>
                          {s.last_path || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent throttle events */}
          {data.throttle_events.length > 0 && (
            <div className="mt-3">
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.6px] text-gray-400">
                最近節流事件
              </h3>
              <ul className="flex flex-col gap-0.5 text-[12px]">
                {data.throttle_events.slice(0, 8).map((ev, idx) => {
                  const nm = nameFor(ev.account_id);
                  return (
                    <li
                      key={`${ev.ts}-${ev.account_id}-${idx}`}
                      className="flex items-center gap-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-red-700"
                    >
                      <span className="font-mono">{formatTs(ev.ts)}</span>
                      <span className="rounded bg-red-100 px-1 font-mono text-[10px]">
                        code={ev.code}
                      </span>
                      <span className="truncate font-mono" title={ev.path}>
                        {nm ? <span className="not-italic">{nm} · </span> : null}
                        {nm ? (
                          <span className="text-[10px] opacity-60">{ev.account_id}</span>
                        ) : (
                          ev.account_id || "?"
                        )}{" "}
                        · {ev.path}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Recent calls table */}
          <div className="mt-3">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.6px] text-gray-400">
                最近 50 筆呼叫(新到舊)
              </h3>
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-500">
                <input
                  type="checkbox"
                  className="custom-cb"
                  checked={hideCacheHits}
                  onChange={(e) => setHideCacheHits(e.currentTarget.checked)}
                />
                只看真實 FB 呼叫(隱藏 cache)
              </label>
            </div>
            {recent.length === 0 ? (
              <div className="text-[12px] text-gray-400">尚無呼叫紀錄</div>
            ) : (
              <>
                {/* Mobile (<md): 卡片列,避免 6 欄擠在窄畫面變不可讀 */}
                <div className="flex flex-col gap-1.5 md:hidden">
                  {recent.map((e, idx) => {
                    const nm = nameFor(e.account_id);
                    return (
                      <div
                        key={`${e.ts}-${idx}-m`}
                        className="rounded-lg border border-border bg-bg p-2 text-[11px]"
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[10px] text-gray-500">
                            {formatTs(e.ts)}
                          </span>
                          {formatStatusBadge(e)}
                          {formatSourceBadge(e.source)}
                          <span className="ml-auto font-mono text-[10px] text-gray-500">
                            {e.ms}ms · BUCU {e.bucu_peak_pct}%
                          </span>
                        </div>
                        <div className="flex flex-wrap items-baseline gap-1">
                          {e.method !== "GET" && (
                            <span className="rounded bg-orange-bg px-1 text-[9px] text-orange">
                              {e.method}
                            </span>
                          )}
                          {nm ? (
                            <span className="text-ink">{nm}</span>
                          ) : null}
                          <span
                            className={cn(
                              "font-mono break-all",
                              nm ? "text-[10px] text-gray-400" : "text-ink",
                            )}
                          >
                            {e.path}
                          </span>
                          {e.error_code !== null && !e.cache_hit && (
                            <span
                              className="rounded bg-amber-100 px-1 font-mono text-[9px] text-amber-700"
                              title={`FB error code ${e.error_code}`}
                            >
                              fb={e.error_code}
                            </span>
                          )}
                          {e.retried && (
                            <span className="rounded bg-amber-100 px-1 text-[9px] text-amber-700">
                              retry
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {/* Desktop (≥md): 寬表格 */}
                <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
                <table className="w-full text-[11px]">
                  <thead className="bg-bg text-left text-gray-500">
                    <tr>
                      <th
                        className="px-2 py-1 font-semibold"
                        title="FB 呼叫發生的本機時間"
                      >
                        時間
                      </th>
                      <th
                        className="px-2 py-1 font-semibold"
                        title="cache = 走快取沒打 FB · 200 = 成功 · 4xx/5xx = 出錯"
                      >
                        狀態
                      </th>
                      <th
                        className="px-2 py-1 font-semibold"
                        title="哪個程式碼路徑觸發了這次呼叫(背景任務 / user 動作 / 自動 cache 預熱 etc)"
                      >
                        來源
                      </th>
                      <th
                        className="px-2 py-1 font-semibold"
                        title="本次呼叫耗時(毫秒)。cache hit 為 0"
                      >
                        ms
                      </th>
                      <th
                        className="px-2 py-1 font-semibold"
                        title="打完當下,FB header 回報的所有業務 BUCU 最高值"
                      >
                        BUCU%
                      </th>
                      <th
                        className="px-2 py-1 font-semibold"
                        title="FB Graph API 端點。act_xxx 後面是廣告帳戶 ID"
                      >
                        路徑
                      </th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {recent.map((e, idx) => {
                      const nm = nameFor(e.account_id);
                      return (
                        <tr key={`${e.ts}-${idx}`} className="border-t border-border">
                          <td className="px-2 py-1 text-gray-500">{formatTs(e.ts)}</td>
                          <td className="px-2 py-1">{formatStatusBadge(e)}</td>
                          <td className="px-2 py-1">{formatSourceBadge(e.source)}</td>
                          <td className="px-2 py-1 text-right text-gray-600">{e.ms}</td>
                          <td className="px-2 py-1 text-right text-gray-600">{e.bucu_peak_pct}</td>
                          <td className="truncate px-2 py-1 text-ink" title={e.path}>
                            {e.method !== "GET" && (
                              <span className="mr-1 rounded bg-orange-bg px-1 text-[9px] text-orange">
                                {e.method}
                              </span>
                            )}
                            {nm ? (
                              <span className="mr-1 font-sans text-ink">{nm}</span>
                            ) : null}
                            <span className={nm ? "text-[10px] text-gray-400" : ""}>
                              {e.path}
                            </span>
                            {e.error_code !== null && !e.cache_hit && (
                              <span
                                className="ml-1 rounded bg-amber-100 px-1 font-mono text-[9px] text-amber-700"
                                title={`FB error code ${e.error_code}`}
                              >
                                fb={e.error_code}
                              </span>
                            )}
                            {e.retried && (
                              <span className="ml-1 rounded bg-amber-100 px-1 text-[9px] text-amber-700">
                                retry
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

// ── React Query cache ────────────────────────────────────────

/**
 * Subscribe to the query cache so the panel re-renders on every
 * add / remove / state-change event. `useSyncExternalStore` avoids
 * us having to manually rig up useState + useEffect for every event.
 *
 * IMPORTANT: `getSnapshot` MUST return a stable reference when the
 * underlying values haven't changed, otherwise every render re-runs
 * the external store subscription and React bails with the
 * "Maximum update depth exceeded" error (#185). We cache the last
 * snapshot in a module-level ref and only allocate a new object when
 * one of the six counters actually moves.
 */
interface QueryStats {
  total: number;
  fetching: number;
  success: number;
  error: number;
  pending: number;
  stale: number;
}
const EMPTY_STATS: QueryStats = {
  total: 0,
  fetching: 0,
  success: 0,
  error: 0,
  pending: 0,
  stale: 0,
};
let lastStatsSnapshot: QueryStats = EMPTY_STATS;
function computeQueryStats(): QueryStats {
  const qs = queryClient.getQueryCache().getAll();
  let total = qs.length;
  let fetching = 0;
  let success = 0;
  let error = 0;
  let pending = 0;
  let stale = 0;
  for (const q of qs) {
    const s = q.state;
    if (s.fetchStatus === "fetching") fetching += 1;
    if (s.status === "success") success += 1;
    if (s.status === "error") error += 1;
    if (s.status === "pending") pending += 1;
    if (q.isStale()) stale += 1;
  }
  total = qs.length;
  const prev = lastStatsSnapshot;
  if (
    prev.total === total &&
    prev.fetching === fetching &&
    prev.success === success &&
    prev.error === error &&
    prev.pending === pending &&
    prev.stale === stale
  ) {
    return prev;
  }
  const next = { total, fetching, success, error, pending, stale };
  lastStatsSnapshot = next;
  return next;
}
const subscribeQueryCache = (cb: () => void) => queryClient.getQueryCache().subscribe(cb);
const getStatsServer = () => EMPTY_STATS;

function useQueryCacheStats(): QueryStats {
  return useSyncExternalStore(subscribeQueryCache, computeQueryStats, getStatsServer);
}

function ReactQueryPanel() {
  const stats = useQueryCacheStats();
  // Recompute the error list whenever the error counter in the
  // cache stats changes. We read queryClient.getQueryCache().getAll()
  // directly inside render — biome flags this as a missing dep, but
  // the entire point is that `stats` (from useSyncExternalStore) is
  // the subscription that keeps us in sync with the cache.
  const errors: Array<{ key: string; message: string; updatedAt: number }> = [];
  if (stats.error > 0) {
    for (const q of queryClient.getQueryCache().getAll()) {
      const err = q.state.error;
      if (err) {
        errors.push({
          key: JSON.stringify(q.queryKey),
          message: err instanceof Error ? err.message : String(err),
          updatedAt: q.state.errorUpdatedAt,
        });
      }
    }
    errors.sort((a, b) => b.updatedAt - a.updatedAt);
    errors.splice(5);
  }

  return (
    <Card
      title="React Query 快取"
      subtitle="前端查詢快取的即時狀態"
      action={
        <Button size="sm" variant="ghost" onClick={() => queryClient.invalidateQueries()}>
          全部失效
        </Button>
      }
    >
      <div className="grid grid-cols-[repeat(6,minmax(88px,1fr))] gap-1.5 overflow-x-auto pb-1 md:gap-2">
        <Stat label="總數" value={stats.total} />
        <Stat
          label="載入中"
          value={stats.fetching}
          tone={stats.fetching > 0 ? "warn" : "default"}
        />
        <Stat label="成功" value={stats.success} tone="ok" />
        <Stat label="錯誤" value={stats.error} tone={stats.error > 0 ? "err" : "default"} />
        <Stat label="等待中" value={stats.pending} />
        <Stat label="過期" value={stats.stale} />
      </div>
      {errors.length > 0 && (
        <>
          <h3 className="mt-4 mb-2 text-xs font-semibold uppercase tracking-[0.8px] text-gray-400">
            最近錯誤
          </h3>
          <ul className="flex flex-col gap-1.5 text-[12px]">
            {errors.map((e) => (
              <li
                key={e.key + e.updatedAt}
                className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5"
              >
                <div className="font-mono text-red-700">{e.key}</div>
                <div className="text-red-600">{e.message}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "ok" | "warn" | "err";
}) {
  const toneClass =
    tone === "err"
      ? "text-red-600"
      : tone === "warn"
        ? "text-amber-500"
        : tone === "ok"
          ? "text-emerald-600"
          : "text-ink";
  return (
    <div className="min-w-[88px] rounded-lg border border-border bg-bg px-2.5 py-2 md:p-2.5">
      <div className="whitespace-nowrap text-[10px] font-semibold leading-tight text-gray-400 md:uppercase md:tracking-[0.6px]">
        {label}
      </div>
      <div className={cn("mt-1 font-mono text-[17px] font-bold leading-none md:text-lg", toneClass)}>
        {value}
      </div>
    </div>
  );
}

// ── Browser / runtime ────────────────────────────────────────

// Hoisted so useSyncExternalStore doesn't re-subscribe on every
// render (stable function identity is part of its contract).
const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};
const getOnlineSnapshot = () => navigator.onLine;
const getOnlineSnapshotServer = () => true;

function useOnlineStatus() {
  return useSyncExternalStore(subscribeOnline, getOnlineSnapshot, getOnlineSnapshotServer);
}

function BrowserPanel() {
  const online = useOnlineStatus();
  // navigator.connection is non-standard but widely supported on
  // Chrome / Edge. Guard for unavailability — Safari/Firefox desktop
  // return undefined and we just hide the row.
  const conn = (
    navigator as unknown as {
      connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    }
  ).connection;
  const mem = (
    performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }
  ).memory;
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <Card title="瀏覽器 / 執行環境" subtitle="本機狀態與網路資訊">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
        <Row label="連線" value={online ? "線上" : "離線"} tone={online ? "ok" : "err"} />
        {conn?.effectiveType ? <Row label="網路類型" value={conn.effectiveType} /> : null}
        {typeof conn?.downlink === "number" ? (
          <Row label="下行頻寬" value={`${conn.downlink} Mbps`} />
        ) : null}
        {typeof conn?.rtt === "number" ? <Row label="RTT" value={`${conn.rtt} ms`} /> : null}
        {conn?.saveData ? <Row label="省流量模式" value="開啟" tone="warn" /> : null}
        <Row label="視窗大小" value={`${viewport.w} × ${viewport.h}`} />
        <Row label="DPR" value={String(window.devicePixelRatio)} />
        <Row label="語言" value={navigator.language} />
        <Row
          label="PWA 獨立模式"
          value={window.matchMedia("(display-mode: standalone)").matches ? "是" : "否"}
        />
        {mem ? (
          <Row
            label="JS Heap"
            value={`${(mem.usedJSHeapSize / 1_048_576).toFixed(1)} MB / ${(mem.jsHeapSizeLimit / 1_048_576).toFixed(0)} MB`}
          />
        ) : null}
        <Row label="UA" value={navigator.userAgent} mono wrap />
      </dl>
    </Card>
  );
}

function Row({
  label,
  value,
  tone = "default",
  mono = false,
  wrap = false,
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn" | "err";
  mono?: boolean;
  wrap?: boolean;
}) {
  const toneClass =
    tone === "err"
      ? "text-red-600"
      : tone === "warn"
        ? "text-amber-500"
        : tone === "ok"
          ? "text-emerald-600"
          : "text-ink";
  return (
    <>
      <dt className="text-gray-400">{label}</dt>
      <dd
        className={cn(toneClass, mono && "font-mono text-[11px]", wrap ? "break-all" : "truncate")}
      >
        {value}
      </dd>
    </>
  );
}

// ── API health pings ────────────────────────────────────────

interface PingResult {
  path: string;
  ms: number;
  status: number | "err";
  detail?: string;
}

async function pingPath(path: string): Promise<PingResult> {
  const started = performance.now();
  try {
    // Raw fetch (we want raw latency, not request()'s retry/refresh
    // machinery) — but protected /api paths still need the session
    // Bearer header or the ping just measures the 401 short-circuit.
    const r = await fetch(path, { method: "GET", headers: apiAuthHeaders() });
    const ms = Math.round(performance.now() - started);
    let detail: string | undefined;
    if (!r.ok) {
      try {
        const body = (await r.json()) as { detail?: string };
        detail = body.detail;
      } catch {
        /* ignore non-JSON */
      }
    }
    return { path, ms, status: r.status, detail };
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    return { path, ms, status: "err", detail: e instanceof Error ? e.message : String(e) };
  }
}

function ApiHealthPanel() {
  const [results, setResults] = useState<PingResult[]>([]);
  const [running, setRunning] = useState(false);
  const targets = ["/api/auth/me", "/api/accounts", "/api/fb-usage"];

  const run = async () => {
    setRunning(true);
    try {
      const out = await Promise.all(targets.map(pingPath));
      setResults(out);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card
      title="API 健康檢查"
      subtitle="依序 ping 後端關鍵端點並量測延遲"
      action={
        <Button size="sm" onClick={() => void run()} disabled={running}>
          {running ? "檢查中…" : "執行"}
        </Button>
      }
    >
      {results.length === 0 ? (
        <div className="text-sm text-gray-400">點擊「執行」開始檢查</div>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[12px]">
          {results.map((r) => (
            <li
              key={r.path}
              className="flex items-center gap-3 rounded-md border border-border bg-bg px-3 py-1.5"
            >
              <span
                className={cn(
                  "inline-block h-2 w-2 shrink-0 rounded-full",
                  r.status === "err" || (typeof r.status === "number" && r.status >= 500)
                    ? "bg-red-500"
                    : typeof r.status === "number" && r.status >= 400
                      ? "bg-amber-400"
                      : "bg-emerald-500",
                )}
              />
              <span className="font-mono text-ink">{r.path}</span>
              <span className="ml-auto font-mono text-gray-500">
                {r.status} · {r.ms}ms
              </span>
            </li>
          ))}
        </ul>
      )}
      {results.some((r) => r.detail) && (
        <ul className="mt-2 flex flex-col gap-1 text-[11px] text-red-600">
          {results
            .filter((r) => r.detail)
            .map((r) => (
              <li key={`${r.path}-detail`}>
                <span className="font-mono">{r.path}</span>: {r.detail}
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}

// ── Local storage ────────────────────────────────────────────

function StoragePanel() {
  const [tick, setTick] = useState(0);
  const entries = useMemo(() => {
    void tick;
    const out: Array<{ key: string; bytes: number; preview: string }> = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      const v = localStorage.getItem(k) ?? "";
      out.push({
        key: k,
        bytes: new Blob([v]).size,
        preview: v.length > 60 ? `${v.slice(0, 60)}…` : v,
      });
    }
    return out.sort((a, b) => b.bytes - a.bytes);
  }, [tick]);
  const total = entries.reduce((s, e) => s + e.bytes, 0);

  return (
    <Card
      title="Local Storage"
      subtitle={`${entries.length} 筆 · ${fmtBytes(total)}`}
      action={
        <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)}>
          重新整理
        </Button>
      }
    >
      {entries.length === 0 ? (
        <div className="text-sm text-gray-400">無項目</div>
      ) : (
        <ul className="flex max-h-[320px] flex-col gap-1 overflow-y-auto text-[11px]">
          {entries.map((e) => (
            <li
              key={e.key}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate font-mono font-semibold text-ink">{e.key}</div>
                <div className="truncate text-gray-400">{e.preview || "(空)"}</div>
              </div>
              <span className="shrink-0 font-mono text-gray-500">{fmtBytes(e.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
