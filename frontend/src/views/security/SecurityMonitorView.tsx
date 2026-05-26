import { api, type SecurityPushTestCard } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { queryClient } from "@/lib/queryClient";
import { ScanHistoryPanel } from "./ScanHistoryPanel";
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
import { useQuery } from "@tanstack/react-query";
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

const topbarActionBase =
  "inline-flex h-9 select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl border-[1.5px] px-3.5 text-[13px] font-medium font-sans leading-none transition-all duration-150 cursor-pointer active:scale-95";
const topbarSecondaryAction = cn(
  topbarActionBase,
  "border-border bg-white text-ink hover:border-orange-border hover:bg-orange-bg",
);

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
  const { user } = useFbAuth();

  const settingsReady = useUiStore((s) => s.settingsReady);

  const safeIds = useSecurityStore((s) => s.safeIds);
  const [tab, setTab] = useState<SecurityTab>("pending");
  const [pushModalOpen, setPushModalOpen] = useState(false);
  const historyPanelRef = useRef<HTMLDivElement | null>(null);

  // 「立即掃描」 gate — flipping this to true triggers the
  // useMultiAccountOverview query below. Default false so just
  // navigating into the view costs ZERO FB calls.
  //
  // Do NOT hydrate this from sessionStorage / lastScanQuery. React Query
  // cache is memory-only, so a browser refresh with "scan requested"
  // persisted would silently re-hit FB. Security is now strictly
  // click-to-scan.
  const [scanRequested, setScanRequested] = useState(false);
  const [scanStartAt, setScanStartAt] = useState<number | null>(null);

  // 「上次掃描時間」改從 DB 拉。security_scan_records 最新一筆的
  // scanned_at 就是答案。30s staleTime 足以讓 UI 看起來即時但不
  // 每次 mount 都打 backend。
  const lastScanQuery = useQuery({
    queryKey: ["security-scan-last", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const resp = await api.securityScan.listRecords(user.id, 1);
      const row = resp.data?.[0];
      return row?.scanned_at ?? null;
    },
    enabled: !!user?.id,
    staleTime: 30_000,
  });
  const lastScanAt = lastScanQuery.data ? new Date(lastScanQuery.data) : null;

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
  // Pass `[]` until the user explicitly clicks「立即掃描」. This is the
  // key rate-limit guarantee for the page: DB history is shown via the
  // scan-record endpoints, never by auto-replaying a FB scan.
  const scanAccounts = scanRequested ? visibleAll : [];

  // Keep manual scans metadata-only. The adsets nesting used for ABO
  // budget aggregation is the most common source of FB `code=100`
  // invalid-parameter errors and costs extra BUCU; campaign-level budget
  // is enough for the default safety pass.
  const overview = useMultiAccountOverview(scanAccounts, fetchDate, {
    includeArchived: true,
    includeAdsets: false,
    source: "security-scan",
    liteOnly: true,
    // Cached results stay visible across mounts / hours of inactivity
    // until user clicks 重新掃描(which invalidates → forces refetch).
    // Without Infinity gcTime, React Query would GC after 30 min and
    // the next mount would silently re-fetch, violating the「user 按
    // 才打」principle.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });

  // 「上次掃描:N 分鐘前」 label 來自 lastScanQuery,scan 結束後在
  // POST record 那一段 invalidate 就會自動更新。這裡只需要追 isScanning
  // 用來 disable 按鈕 + edge-detect 完成的 transition。
  const isScanning = scanRequested && overview.isFetching;

  // Edge-detect the "scanning → done" transition. Without the ref,
  // the history append runs on every render where !isScanning (even
  // before scanRequested is set), which would log a phantom entry on
  // first mount. Ref guarantees we only fire ONCE per scan when the
  // boolean actually flips.
  const wasScanning = useRef(false);
  const spendByCampaignId = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of overview.campaigns) {
      const s = c.insights?.data?.[0]?.spend;
      if (s !== undefined) map.set(c.id, s);
    }
    return map;
  }, [overview.campaigns]);

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

  // 「立即掃描」完成時:POST 一筆到 backend security_scan_records
  // (跨裝置同步)+ invalidate「上次掃描時間」query 讓 label 立即
  // 反映剛剛這次。用 ref 偵測「scanning → done」transition 確保每
  // 個 scan 只記一次。
  useEffect(() => {
    if (wasScanning.current && !isScanning && scanStartAt !== null) {
      const durationMs = Date.now() - scanStartAt;
      const uid = user?.id ?? "";
      if (uid) {
        const matches = visibleAll.length
          ? allDays.flatMap((day) =>
              day.rows
                .filter((r) => !safeIds.has(r.campaign.id))
                .map((r) => ({
                  campaign_id: r.campaign.id,
                  name: r.campaign.name ?? null,
                  objective: r.campaign.objective ?? null,
                  status: r.campaign.status ?? null,
                  created_time: r.campaign.created_time ?? null,
                  daily_budget: effectiveDailyBudget(r.campaign),
                  lifetime_budget: r.campaign.lifetime_budget
                    ? Number(r.campaign.lifetime_budget)
                    : null,
                  account_id: r.campaign._accountId ?? null,
                  account_name: r.campaign._accountName ?? null,
                  anomalies: r.anomalies ?? [],
                  // creator name 沒有 eager prefetch 了(BUCU 優化),
                  // 卡片展開時才會拉。記錄時填 null,future query 可
                  // 由 activity log join 補上。
                  creator: null,
                })),
            )
          : [];
        void api.securityScan
          .postRecord(uid, {
            account_ids: visibleAll.map((a) => a.id),
            duration_ms: durationMs,
            matches,
          })
          .then(() => {
            // 拉新的「上次掃描時間」+ 掃描紀錄,讓 UI 即時反映
            void queryClient.invalidateQueries({ queryKey: ["security-scan-last"] });
            void queryClient.invalidateQueries({ queryKey: ["security-scan-records"] });
          })
          .catch((e) => {
            console.warn("[security-scan] post record failed:", e);
          });
      }
      setScanStartAt(null);
    }
    wasScanning.current = isScanning;
  }, [
    isScanning,
    scanStartAt,
    user?.id,
    visibleAll,
    allDays,
    safeIds,
  ]);

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
  const spendRangeLabel = useMemo(() => toShortLabel(fetchDate), [fetchDate]);
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
      <Topbar title="安全防護">
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
              topbarActionBase,
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
            onClick={() => {
              historyPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }}
            className={topbarSecondaryAction}
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
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <path d="M3 3v6h6" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span>掃描紀錄</span>
          </button>
          <button
            type="button"
            onClick={() => setPushModalOpen(true)}
            className={topbarSecondaryAction}
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

      <div className="flex min-w-0 flex-col items-stretch xl:flex-row">
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
                  insightsPending={overview.insightsPending}
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
                  detailDate={fetchDate}
                />
              )}
            </div>
          )}
        </div>
        <div
          ref={historyPanelRef}
          className="min-h-[360px] shrink-0 scroll-mt-20 xl:h-[calc(100vh-57px)] xl:w-[340px]"
        >
          <ScanHistoryPanel />
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
  detailDate: DateConfig;
}

function SecurityDayList({
  days,
  creatorByCampaignId,
  spendByCampaignId,
  insightsPending,
  defaultExpanded,
  activitiesSince,
  activitiesUntil,
  detailDate,
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
                detailDate={detailDate}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
