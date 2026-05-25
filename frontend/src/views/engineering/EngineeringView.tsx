import { api } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/cn";
import { queryClient } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

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
function EngineeringPanels() {
  return (
    <div className="flex flex-col gap-4">
      <IdentityPanel />
      <MemoryPanel />
      <FbUsagePanel />
      <FbCallsPanel />
      <div className="grid gap-4 md:grid-cols-2">
        <ReactQueryPanel />
        <BrowserPanel />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <ApiHealthPanel />
        <StoragePanel />
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
    <Modal open={open} onOpenChange={onOpenChange} title="工程模式" width={1100}>
      <EngineeringPanels />
    </Modal>
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
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-white p-4 md:p-5">
      <header className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-bold text-ink">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-gray-400">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
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
  const barWidth = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  // Colour the bar by pressure: green-ish under 50, orange 50-80, red >80.
  const barTone =
    pct === null ? "bg-gray-200" : pct >= 80 ? "bg-red" : pct >= 50 ? "bg-orange" : "bg-indigo-400";

  return (
    <section className="rounded-2xl border border-border bg-white p-4 md:p-5">
      <div className="text-[13px] font-semibold text-gray-500">伺服器記憶體</div>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[22px] font-bold tabular-nums text-ink md:text-[24px]">
          {fmt(rss)} <span className="text-gray-300">/</span> {fmt(total)}
        </div>
        <div className="text-[13px] font-semibold tabular-nums text-gray-500">{fmtPct(pct)}</div>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-bg">
        <div
          className={cn("h-full rounded-full transition-all duration-500", barTone)}
          style={{ width: `${barWidth}%` }}
        />
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
  const data = usageQuery.data?.data ?? {};
  const peak = usageQuery.data?.peak_regain_minutes ?? 0;
  const entries = Object.entries(data);

  // Build a map<business_id, business_name> from the user's accounts.
  // FB's X-Business-Use-Case-Usage header keys entries by BM id, so
  // matching the numeric id back to the BM display name makes the
  // panel readable instead of just digits.
  //
  // Caveat — IDs may not always align. A BUC entry can come from
  // calling a *shared* ad account whose owner BM isn't yours, and
  // `me/adaccounts` may not surface that owner BM. We still show
  // the mismatch row so the operator knows usage exists for that
  // BM even without a name.
  const bizNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accountsQuery.data ?? []) {
      const b = a.business;
      if (b?.id && b.name && !m.has(b.id)) m.set(b.id, b.name);
    }
    return m;
  }, [accountsQuery.data]);

  // Dev hint: when nothing matches, the IDs are coming from BMs
  // outside the user's `me/adaccounts` view (typically shared
  // accounts). Log once so the operator can confirm.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!usageQuery.data || !accountsQuery.data) return;
    const bucIds = Object.keys(usageQuery.data.data ?? {});
    const myBmIds = new Set<string>();
    for (const a of accountsQuery.data) {
      if (a.business?.id) myBmIds.add(a.business.id);
    }
    const unmatched = bucIds.filter((id) => !myBmIds.has(id));
    if (unmatched.length > 0) {
      console.log(
        "[fb-usage] BUC BM ids without matching me/adaccounts business.id:",
        unmatched,
        "your BM ids:",
        [...myBmIds],
      );
    }
  }, [usageQuery.data, accountsQuery.data]);

  return (
    <Card
      title="FB API 節流狀態"
      subtitle="X-Business-Use-Case-Usage 即時快照,每 10 秒更新。FB 是按 Business Manager(BM)計算 rate limit,不是按廣告帳戶;一個 BM 底下的所有廣告帳戶共用同一個額度。冷卻時間由 Facebook 估算,僅供參考。"
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
      {usageQuery.isLoading ? (
        <div className="text-sm text-gray-400">載入中…</div>
      ) : entries.length === 0 ? (
        <div className="text-sm text-gray-400">尚無資料——任何 FB API 呼叫之後會更新</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[12px]">
            <thead className="bg-bg text-left text-gray-500">
              <tr>
                <th className="px-3 py-2 font-semibold">BM</th>
                <th className="px-3 py-2 font-semibold">呼叫次數</th>
                <th className="px-3 py-2 font-semibold">CPU 用量</th>
                <th className="px-3 py-2 font-semibold">處理時間</th>
                <th className="px-3 py-2 font-semibold whitespace-nowrap">更新</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([bizId, u]) => (
                <UsageRow
                  key={bizId}
                  bizId={bizId}
                  bizName={bizNameById.get(bizId) ?? ""}
                  usage={u}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function UsageRow({
  bizId,
  bizName,
  usage,
}: {
  bizId: string;
  bizName: string;
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
          {bizName ? <span className="font-semibold text-ink">{bizName}</span> : null}
          <span
            className="font-mono text-[11px] text-gray-500"
            title="Business Manager ID(非廣告帳戶 ID)。FB rate limit 按 BM 計算。"
          >
            BM {bizId}
          </span>
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
  const pct = Math.max(0, Math.min(100, value));
  const color = pct >= 80 ? "bg-red-500" : pct >= 50 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-gray-200">
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
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

  const recent = useMemo(() => {
    const r = data?.recent ?? [];
    // Newest first for the table — backend returns oldest-first.
    return [...r].reverse().slice(0, 50);
  }, [data?.recent]);

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

  const formatTs = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString("zh-TW", { hour12: false });
  };
  const formatStatusBadge = (e: NonNullable<typeof recent>[number]) => {
    if (e.cache_hit) {
      return <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700">cache</span>;
    }
    if (e.error_code === 80004 && e.status === 429 && e.ms === 0) {
      return <span className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-[10px] text-red-700">gated</span>;
    }
    const tone =
      e.status >= 500
        ? "bg-red-100 text-red-700"
        : e.status >= 400
          ? "bg-amber-100 text-amber-700"
          : "bg-gray-100 text-gray-700";
    return (
      <span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px]", tone)}>{e.status}</span>
    );
  };

  return (
    <Card
      title="最近 FB 呼叫 / 節流事件"
      subtitle="後端 ring buffer:每一次 FB Graph API 呼叫(含 cache hit 與 gated)都在這裡。用來追「80004 發生前我們在打誰」。"
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
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="5 分鐘總呼叫" value={data.total_5m} />
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
            <Stat label="冷卻中帳戶" value={cooldowns.length} tone={cooldowns.length > 0 ? "err" : "default"} />
          </div>

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

          {/* Top paths + Top accounts */}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.6px] text-gray-400">
                5 分鐘熱門路徑
              </h3>
              {data.top_paths_5m.length === 0 ? (
                <div className="text-[12px] text-gray-400">尚無資料</div>
              ) : (
                <ul className="flex flex-col gap-0.5 text-[12px]">
                  {data.top_paths_5m.slice(0, 10).map((p) => (
                    <li
                      key={p.path}
                      className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-1"
                    >
                      <span className="truncate font-mono text-ink" title={p.path}>
                        {p.path}
                      </span>
                      <span className="shrink-0 font-mono text-gray-500">{p.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.6px] text-gray-400">
                5 分鐘熱門帳戶
              </h3>
              {data.top_accounts_5m.length === 0 ? (
                <div className="text-[12px] text-gray-400">尚無資料</div>
              ) : (
                <ul className="flex flex-col gap-0.5 text-[12px]">
                  {data.top_accounts_5m.slice(0, 10).map((a) => {
                    const nm = nameFor(a.account_id);
                    return (
                      <li
                        key={a.account_id}
                        className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-1"
                      >
                        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                          {nm ? (
                            <span className="truncate text-ink">{nm}</span>
                          ) : (
                            <span className="truncate font-mono text-ink">{a.account_id}</span>
                          )}
                          {nm ? (
                            <span className="shrink-0 font-mono text-[10px] text-gray-400">
                              {a.account_id}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 font-mono text-gray-500">{a.count}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
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
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.6px] text-gray-400">
              最近 50 筆呼叫(新到舊)
            </h3>
            {recent.length === 0 ? (
              <div className="text-[12px] text-gray-400">尚無呼叫紀錄</div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-[11px]">
                  <thead className="bg-bg text-left text-gray-500">
                    <tr>
                      <th className="px-2 py-1 font-semibold">時間</th>
                      <th className="px-2 py-1 font-semibold">狀態</th>
                      <th className="px-2 py-1 font-semibold">ms</th>
                      <th className="px-2 py-1 font-semibold">BUCU%</th>
                      <th className="px-2 py-1 font-semibold">路徑</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {recent.map((e, idx) => {
                      const nm = nameFor(e.account_id);
                      return (
                        <tr key={`${e.ts}-${idx}`} className="border-t border-border">
                          <td className="px-2 py-1 text-gray-500">{formatTs(e.ts)}</td>
                          <td className="px-2 py-1">{formatStatusBadge(e)}</td>
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
      <div className="grid grid-cols-3 gap-2 md:grid-cols-6">
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
    <div className="rounded-lg border border-border bg-bg p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.6px] text-gray-400">
        {label}
      </div>
      <div className={cn("mt-1 font-mono text-lg font-bold", toneClass)}>{value}</div>
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
    const r = await fetch(path, { method: "GET" });
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
