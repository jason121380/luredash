import type { SecurityPushTestCard } from "@/api/client";
import { queryClient } from "@/lib/queryClient";
import { ScanHistoryModal, appendScanHistory } from "./ScanHistoryModal";
import { useAccounts } from "@/api/hooks/useAccounts";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { Topbar, TopbarSeparator } from "@/layout/Topbar";
import { cn } from "@/lib/cn";
import { type DateConfig, toShortLabel } from "@/lib/datePicker";
import { useAccountsStore } from "@/stores/accountsStore";
import { useSecurityStore } from "@/stores/securityStore";
import { useUiStore } from "@/stores/uiStore";
import { useEffect, useMemo, useRef, useState } from "react";
import { SecurityCampaignRow } from "./SecurityCampaignRow";
import { SecurityPushSettingsModal } from "./SecurityPushSettingsModal";
import {
  buildSecurityDays,
  effectiveDailyBudget,
  formatDayLabel,
  resolveBounds,
} from "./securityData";

type SecurityTab = "pending" | "safe";

function formatRelativeScanTime(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return "剛剛";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分鐘前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小時前`;
  return d.toLocaleDateString("zh-TW");
}

/**
 * 安全監控 — surfaces newly-created campaigns grouped by day so the
 * operator can scan for unusual creations (deep-night / weekend /
 * burst). Reuses the 240px account panel from Alerts and the standard
 * Topbar + DatePicker.
 *
 * The DatePicker state is LOCAL (not the shared `filtersStore.date`)
 * because this view interprets the range as "campaigns created in this
 * window", not "insights for this window" — and defaults to 本月
 * (this_month) so the operator sees the full review surface for the
 * current month. Keeping it local avoids mutating the shared preset
 * for other views when the user opens 安全監控.
 *
 * Operators triage by tab:
 *   - 待查看: campaigns not yet marked safe
 *   - 已標記安全: campaigns the team has cleared via the per-row button
 */
export function SecurityMonitorView() {
  const accountsQuery = useAccounts();
  const allAccounts = accountsQuery.data ?? [];
  const visibleAll = useAccountsStore((s) => s.visibleAccounts)(allAccounts);

  const settingsReady = useUiStore((s) => s.settingsReady);

  const safeIds = useSecurityStore((s) => s.safeIds);
  const [tab, setTab] = useState<SecurityTab>("pending");
  const [pushModalOpen, setPushModalOpen] = useState(false);

  // 「立即掃描」 gate — flipping this to true triggers the two
  // useMultiAccountOverview queries below. Default false so just
  // navigating into the view costs ZERO FB calls (the auto-fetch
  // on mount was burning BUCU even when the user didn't actually
  // want to look at anything). User clicks 立即掃描 → scan fires.
  //
  // Persistence: scanRequested → sessionStorage(survives tab navigation
  // but not tab close); lastScanAt → localStorage(survives across tabs
  // / browser sessions for the「上次掃描:N 分鐘前」label).
  //
  // 重新進入安全監控時:若 sessionStorage 仍有 scanRequested=1 → 直接
  // 啟用 queries。React Query 的 staleTime 5min + useMultiAccountOverview
  // 的 localStorage placeholderData 接住了快取顯示,5min 內**不會打 FB**
  // (cache hit),5min 外才會背景 refetch。這就是「上次掃描結果 cache」
  // 的體感。
  const [scanRequested, setScanRequested] = useState(() => {
    try {
      return sessionStorage.getItem("security_scan_requested") === "1";
    } catch {
      return false;
    }
  });
  const [lastScanAt, setLastScanAt] = useState<Date | null>(() => {
    try {
      const raw = localStorage.getItem("security_last_scan_at");
      if (!raw) return null;
      const ts = Number(raw);
      if (!Number.isFinite(ts)) return null;
      return new Date(ts);
    } catch {
      return null;
    }
  });
  const [scanStartAt, setScanStartAt] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Persist state on change so navigating away / coming back restores.
  useEffect(() => {
    try {
      if (scanRequested) sessionStorage.setItem("security_scan_requested", "1");
      else sessionStorage.removeItem("security_scan_requested");
    } catch {
      /* private mode / quota — ignore */
    }
  }, [scanRequested]);
  useEffect(() => {
    try {
      if (lastScanAt) localStorage.setItem("security_last_scan_at", String(lastScanAt.getTime()));
    } catch {
      /* private mode / quota — ignore */
    }
  }, [lastScanAt]);

  const [date, setDate] = useState<DateConfig>({
    preset: "this_month",
    from: null,
    to: null,
  });

  // Decouple the FB fetch range from the user's display range. We
  // always pull campaigns with a fixed `last_90d` window so:
  //   1. Switching the date picker doesn't re-fetch (different
  //      `date_preset` was producing different campaign lists when
  //      FB throttled the larger range and the backend fell back to
  //      `minimal` fields without `created_time`, silently dropping
  //      campaigns from the security view).
  //   2. The user's date config feeds `buildSecurityDays` only as a
  //      client-side filter on `created_time`, which matches the
  //      view's actual semantics ("campaigns CREATED in this window").
  const fetchDate = useMemo<DateConfig>(() => ({ preset: "last_90d", from: null, to: null }), []);
  // Pass `[]` when scan hasn't been requested → useMultiAccountOverview
  // sees accounts.length === 0 → query.enabled = false → no fetch.
  // The moment user clicks 立即掃描, `scanRequested` flips and the
  // queries fire against the full visible account set.
  const scanAccounts = scanRequested ? visibleAll : [];

  // includeAdsets:true here only — `effectiveDailyBudget` reads
  // `campaign.adsets.data` to aggregate ABO budgets. Dashboard / Alerts /
  // Finance never read that nested field so they opt out (default false,
  // ~20-30% lighter FB BUCU per call).
  const overview = useMultiAccountOverview(scanAccounts, fetchDate, {
    includeArchived: true,
    includeAdsets: true,
    source: "security-scan",
  });

  // SECOND overview query at the user's chosen date — only used to
  // surface spend numbers that match the date-picker label (儀表板
  // 也是這樣)。campaigns from this query may be a subset (FB throttle
  // / fallback); we look up insights by id and fall back to "$0" /
  // "—" when missing.
  const spendOverview = useMultiAccountOverview(scanAccounts, date, {
    includeArchived: true,
    source: "security-scan",
  });

  // Track when the most-recent scan finishes so we can show
  // 「上次掃描:N 分鐘前」 next to the rescan button.
  const isScanning =
    scanRequested && (overview.isFetching || spendOverview.isFetching);
  useEffect(() => {
    if (scanRequested && !isScanning) {
      setLastScanAt(new Date());
    }
  }, [scanRequested, isScanning]);

  // Edge-detect the "scanning → done" transition. Without the ref,
  // the history append runs on every render where !isScanning (even
  // before scanRequested is set), which would log a phantom entry on
  // first mount. Ref guarantees we only fire ONCE per scan when the
  // boolean actually flips.
  const wasScanning = useRef(false);
  const spendByCampaignId = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of spendOverview.campaigns) {
      const s = c.insights?.data?.[0]?.spend;
      if (s !== undefined) map.set(c.id, s);
    }
    return map;
  }, [spendOverview.campaigns]);

  const allDays = useMemo(
    () => buildSecurityDays(overview.campaigns, date),
    [overview.campaigns, date],
  );

  // Per-tab counts (drive the tab labels) — computed once from `allDays`
  // so both numbers always sum to the unfiltered total.
  const pendingCount = useMemo(
    () => allDays.reduce((n, d) => n + d.rows.filter((r) => !safeIds.has(r.campaign.id)).length, 0),
    [allDays, safeIds],
  );
  const safeCount = useMemo(
    () => allDays.reduce((n, d) => n + d.rows.filter((r) => safeIds.has(r.campaign.id)).length, 0),
    [allDays, safeIds],
  );

  // 「立即掃描」完成時把這筆掃描 append 進本地歷史(localStorage).
  // 一個 scan 一筆紀錄,包含耗時 + 掃到 / 待查看 / 是否錯誤. 用 ref
  // 偵測「scanning → done」transition 確保每個 scan 只記一次.
  useEffect(() => {
    if (wasScanning.current && !isScanning && scanStartAt !== null) {
      appendScanHistory({
        ts: Date.now(),
        durationMs: Date.now() - scanStartAt,
        totalCampaigns: overview.campaigns.length,
        pendingCount,
        hasError: Object.keys(overview.errors).length > 0,
      });
      setScanStartAt(null);
    }
    wasScanning.current = isScanning;
  }, [isScanning, scanStartAt, overview.campaigns.length, overview.errors, pendingCount]);

  // Filter days by tab. We drop a day group entirely when none of its
  // rows match — avoids showing empty headers.
  const visibleDays = useMemo(() => {
    return allDays
      .map((d) => ({
        ...d,
        rows: d.rows.filter((r) =>
          tab === "safe" ? safeIds.has(r.campaign.id) : !safeIds.has(r.campaign.id),
        ),
      }))
      .filter((d) => d.rows.length > 0);
  }, [allDays, tab, safeIds]);

  // Activities use the SAME fixed wide window as the campaign fetch
  // (last_90d), NOT the user-selected `date`. Reason: tying activities
  // to the date picker meant every preset switch fired 14 parallel
  // FB Activity Log requests with new bounds → frequent failures
  // (FB Activity Log has its own per-account budget separate from
  // the campaigns edge, easier to trip). With a fixed window the
  // queries hit cache and date switching is purely a client-side
  // filter on `created_time` — no re-fetch.
  const activitiesBounds = useMemo(() => {
    const { from, to } = resolveBounds(fetchDate);
    return { since: Math.floor(from / 1000), until: Math.floor(to / 1000) };
  }, [fetchDate]);

  // Creator-name eager prefetch removed (was a BUCU sinkhole — 30+
  // /activities calls fired on every view mount, each 5-20s on heavy
  // accounts like !B 新城區). Cards now show「建立者:—」on first
  // render; when user expands a row, SecurityCampaignRow's
  // `useAccountActivities` lazily pulls the full activity log for
  // that ONE account and surfaces the creator on demand.
  const creatorByCampaignId = useMemo(() => new Map<string, string>(), []);

  // Snapshot of the 待查看 cards — passed into the push-settings modal
  // so the「測試」button can echo exactly what the user sees on screen
  // without backend re-scanning FB. Spend + range label travel along
  // so the LINE card shows「已花費 $X(本月)」exactly like the table.
  const spendRangeLabel = useMemo(() => toShortLabel(date), [date]);
  const pendingCardsSnapshot = useMemo<SecurityPushTestCard[]>(() => {
    const out: SecurityPushTestCard[] = [];
    for (const day of allDays) {
      for (const r of day.rows) {
        if (safeIds.has(r.campaign.id)) continue;
        const c = r.campaign;
        out.push({
          id: c.id,
          name: c.name,
          created_time: c.created_time ?? r.createdAt.toISOString(),
          daily_budget: effectiveDailyBudget(c),
          spend: spendByCampaignId.get(c.id) ?? null,
          spend_range_label: spendRangeLabel,
          account_name: c._accountName ?? "",
          anomalies: r.anomalies,
          creator: creatorByCampaignId.get(c.id) ?? null,
        });
      }
    }
    return out;
  }, [allDays, safeIds, creatorByCampaignId, spendByCampaignId, spendRangeLabel]);

  // Show the loading state whenever:
  //   1. Settings are still hydrating (no idea which accounts to show), or
  //   2. The hook is in the loading phase, or
  //   3. Campaigns are empty but a fetch is still in flight (placeholder
  //      flipped isLoading false but real data hasn't arrived).
  // The third condition catches the "I see empty state but it's actually
  // still loading" UX bug from the previous build.
  const showLoading =
    !settingsReady ||
    overview.isLoading ||
    (overview.campaigns.length === 0 && overview.isFetching);

  return (
    <>
      <Topbar title="安全監控">
        <div className="flex items-center gap-2 md:gap-3">
          {/* 安全監控限定到「上個月」為止 — 立即掃描 fetch 固定
              last_90d,選 last_90d 或更久的自訂區間會看不到資料。
              拿掉 custom 日曆,只留 6 個 preset。 */}
          <DatePicker
            value={date}
            onChange={setDate}
            allowedPresets={["today", "yesterday", "last_7d", "last_30d", "this_month", "last_month"]}
          />
          <TopbarSeparator />
          {lastScanAt && (
            <span className="hidden whitespace-nowrap text-[11px] text-gray-400 md:inline">
              上次掃描:{formatRelativeScanTime(lastScanAt)}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              if (lastScanAt) {
                // Subsequent click — invalidate the overview queries
                // so React Query refetches even within the 5min stale
                // window. First click just flips scanRequested and
                // the queries fire on their own.
                void queryClient.invalidateQueries({ queryKey: ["overview"] });
                void queryClient.invalidateQueries({ queryKey: ["overview-lite"] });
              }
              setScanStartAt(Date.now());
              setScanRequested(true);
            }}
            disabled={isScanning}
            className={cn(
              "flex h-10 select-none items-center gap-2 whitespace-nowrap rounded-xl border-[1.5px] px-3.5 md:h-9",
              "text-[13px] font-medium font-sans",
              "transition-all duration-150 cursor-pointer active:scale-95",
              isScanning
                ? "border-border bg-bg text-gray-400 cursor-wait"
                : "border-orange bg-orange text-white hover:bg-orange-600 hover:border-orange-600",
            )}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0"
              aria-hidden="true"
            >
              <title>scan</title>
              <path d="M3 7V5a2 2 0 0 1 2-2h2" />
              <path d="M17 3h2a2 2 0 0 1 2 2v2" />
              <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
              <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
              <path d="M7 12h10" />
            </svg>
            <span>{isScanning ? "掃描中…" : lastScanAt ? "重新掃描" : "立即掃描"}</span>
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className={cn(
              "flex h-10 select-none items-center gap-2 whitespace-nowrap rounded-xl border-[1.5px] px-3.5 md:h-9",
              "text-[13px] font-medium text-ink font-sans",
              "transition-all duration-150 cursor-pointer active:scale-95",
              "border-border bg-white hover:border-orange-border hover:bg-orange-bg",
            )}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-orange"
              aria-hidden="true"
            >
              <title>history</title>
              <path d="M3 3v5h5" />
              <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
              <path d="M12 7v5l4 2" />
            </svg>
            <span>掃描紀錄</span>
          </button>
          <button
            type="button"
            onClick={() => setPushModalOpen(true)}
            className={cn(
              "flex h-10 select-none items-center gap-2 whitespace-nowrap rounded-xl border-[1.5px] px-3.5 md:h-9",
              "text-[13px] font-medium text-ink font-sans",
              "transition-all duration-150 cursor-pointer active:scale-95",
              "border-border bg-white hover:border-orange-border hover:bg-orange-bg",
            )}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-orange"
              aria-hidden="true"
            >
              <title>bell</title>
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span>推播設定</span>
          </button>
        </div>
      </Topbar>
      <SecurityPushSettingsModal
        open={pushModalOpen}
        onOpenChange={setPushModalOpen}
        pendingCards={pendingCardsSnapshot}
      />
      <ScanHistoryModal open={historyOpen} onOpenChange={setHistoryOpen} />

      <div className="flex min-w-0 items-start md:flex-row">
        {/* 帳戶清單面板已移除 — 安全監控是 review 用,只關心
            「跨帳戶有哪些新建立的可疑活動」。要看單一帳戶細節
            (insights / 廣告組合 / 廣告) 請回儀表板。 */}

        <div className="min-w-0 flex-1 p-3 md:p-5">
          {!scanRequested ? (
            <EmptyState>
              <div className="flex flex-col items-center gap-2">
                <div className="text-[15px] font-semibold text-ink">尚未掃描</div>
                <div className="max-w-[420px] text-[13px] text-gray-500">
                  進入此頁面不會自動拉取資料(避免無謂消耗 FB API 額度)。
                  點右上「立即掃描」開始檢查新建立的廣告活動。
                </div>
              </div>
            </EmptyState>
          ) : showLoading || isScanning ? (
            // Don't pass loaded/total — once `isLoading` flips false
            // (lite returned with empty data) the hook reports
            // loadedCount=accounts.length, which the LoadingState
            // treats as "honest mode 100%". The fake time-based
            // curve is more honest here since we don't have real
            // per-account progress to surface.
            <LoadingState title="掃描中..." subtitle="正在從 Facebook 拉取活動清單" />
          ) : visibleAll.length === 0 ? (
            <EmptyState>請先在設定中啟用廣告帳戶</EmptyState>
          ) : (
            <div className="flex flex-col gap-3">
              <SecurityTabs
                tab={tab}
                onChange={setTab}
                pendingCount={pendingCount}
                safeCount={safeCount}
              />
              {visibleDays.length === 0 ? (
                <EmptyState>
                  {tab === "pending"
                    ? "✓ 所選日期區間內所有新建立活動皆已查看"
                    : "目前沒有已標記為安全的活動"}
                </EmptyState>
              ) : (
                <SecurityDayList
                  days={visibleDays}
                  creatorByCampaignId={creatorByCampaignId}
                  spendByCampaignId={spendByCampaignId}
                  insightsPending={spendOverview.insightsPending}
                  // Default collapsed for BOTH tabs — old default
                  // (待查看 auto-expanded) fired an /activities call
                  // for every visible account on view mount, which was
                  // the second biggest contributor to BUCU 處理時間
                  // climb after the eager prefetch we just removed.
                  // User clicks「編輯紀錄」on a row when they actually
                  // want the history; lazy fetch only that row's
                  // account at that point.
                  defaultExpanded={false}
                  activitiesSince={activitiesBounds.since}
                  activitiesUntil={activitiesBounds.until}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

interface SecurityTabsProps {
  tab: SecurityTab;
  onChange: (t: SecurityTab) => void;
  pendingCount: number;
  safeCount: number;
}

function SecurityTabs({ tab, onChange, pendingCount, safeCount }: SecurityTabsProps) {
  return (
    <div className="flex items-center gap-1 border-b border-border" role="tablist">
      <TabButton
        active={tab === "pending"}
        label="待查看"
        count={pendingCount}
        onClick={() => onChange("pending")}
      />
      <TabButton
        active={tab === "safe"}
        label="已標記安全"
        count={safeCount}
        onClick={() => onChange("safe")}
      />
    </div>
  );
}

function TabButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold transition-colors",
        active ? "text-orange" : "text-gray-500 hover:text-ink",
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "rounded-full px-1.5 py-[1px] text-[10px] font-semibold tabular-nums",
          active ? "bg-orange-bg text-orange" : "bg-gray-100 text-gray-500",
        )}
      >
        {count}
      </span>
      {active && <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-orange" />}
    </button>
  );
}

interface SecurityDayListProps {
  days: ReturnType<typeof buildSecurityDays>;
  creatorByCampaignId: Map<string, string>;
  spendByCampaignId: Map<string, string>;
  insightsPending: boolean;
  defaultExpanded: boolean;
  activitiesSince: number;
  activitiesUntil: number;
}

function SecurityDayList({
  days,
  creatorByCampaignId,
  spendByCampaignId,
  insightsPending,
  defaultExpanded,
  activitiesSince,
  activitiesUntil,
}: SecurityDayListProps) {
  return (
    <div className="flex flex-col gap-4">
      {days.map((day) => (
        <section key={day.dateKey} className="flex flex-col gap-2">
          <header className="flex items-baseline gap-2 px-1">
            <h2 className="text-[14px] font-semibold text-ink">{formatDayLabel(day.dateKey)}</h2>
            <span className="text-[11px] text-gray-500">共 {day.rows.length} 個新活動</span>
          </header>
          <div className="flex flex-col gap-2">
            {day.rows.map((row) => (
              <SecurityCampaignRow
                key={row.campaign.id}
                row={row}
                creator={creatorByCampaignId.get(row.campaign.id)}
                spend={spendByCampaignId.get(row.campaign.id)}
                insightsPending={insightsPending}
                defaultExpanded={defaultExpanded}
                activitiesSince={activitiesSince}
                activitiesUntil={activitiesUntil}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
