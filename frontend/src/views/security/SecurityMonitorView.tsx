import { api } from "@/api/client";
import type { SecurityPushTestCard } from "@/api/client";
import { useAccounts } from "@/api/hooks/useAccounts";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { AcctSidebarToggle } from "@/components/AcctSidebarToggle";
import { DatePicker } from "@/components/DatePicker";
import { EmptyState } from "@/components/EmptyState";
import { LoadingState } from "@/components/LoadingState";
import { MobileAccountPicker } from "@/components/MobileAccountPicker";
import { Topbar, TopbarSeparator } from "@/layout/Topbar";
import { cn } from "@/lib/cn";
import { type DateConfig, toShortLabel } from "@/lib/datePicker";
import { Semaphore } from "@/lib/semaphore";
import { useAccountsStore } from "@/stores/accountsStore";
import { useSecurityStore } from "@/stores/securityStore";
import { useUiStore } from "@/stores/uiStore";
import type { FbActivity } from "@/types/fb";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AlertAccountPanel } from "../alerts/AlertAccountPanel";
import { SecurityCampaignRow } from "./SecurityCampaignRow";
import { SecurityPushSettingsModal } from "./SecurityPushSettingsModal";
import {
  buildSecurityDays,
  effectiveDailyBudget,
  formatDayLabel,
  resolveBounds,
} from "./securityData";

type SecurityTab = "pending" | "safe";

// Module-level cap so the gate is shared across re-renders / re-mounts.
// Sized to match the backend's `_collect_security_matches` scan_sem(5).
const activityPrefetchSem = new Semaphore(5);

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

  const selectedAcctId = useUiStore((s) => s.alertSelectedAcctId);
  const setSelectedAcctId = useUiStore((s) => s.setAlertSelectedAcctId);
  const settingsReady = useUiStore((s) => s.settingsReady);

  const safeIds = useSecurityStore((s) => s.safeIds);
  const [tab, setTab] = useState<SecurityTab>("pending");
  const [pushModalOpen, setPushModalOpen] = useState(false);

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
  // includeAdsets:true here only — `effectiveDailyBudget` reads
  // `campaign.adsets.data` to aggregate ABO budgets. Dashboard / Alerts /
  // Finance never read that nested field so they opt out (default false,
  // ~20-30% lighter FB BUCU per call).
  const overview = useMultiAccountOverview(visibleAll, fetchDate, {
    includeArchived: true,
    includeAdsets: true,
  });

  // SECOND overview query at the user's chosen date — only used to
  // surface spend numbers that match the date-picker label (儀表板
  // 也是這樣)。campaigns from this query may be a subset (FB throttle
  // / fallback); we look up insights by id and fall back to "$0" /
  // "—" when missing.
  const spendOverview = useMultiAccountOverview(visibleAll, date, { includeArchived: true });
  const spendByCampaignId = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of spendOverview.campaigns) {
      const s = c.insights?.data?.[0]?.spend;
      if (s !== undefined) map.set(c.id, s);
    }
    return map;
  }, [spendOverview.campaigns]);

  const scopedCampaigns = useMemo(() => {
    if (selectedAcctId === null) return overview.campaigns;
    return overview.campaigns.filter((c) => c._accountId === selectedAcctId);
  }, [overview.campaigns, selectedAcctId]);

  const allDays = useMemo(() => buildSecurityDays(scopedCampaigns, date), [scopedCampaigns, date]);

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

  // Eager activity-log prefetch per visible account so we can show the
  // creator name on every card without waiting for the user to expand.
  //
  // Two-tier strategy to keep BUCU bounded:
  //   1. Prefetch uses `event_types=create_campaign_group` so FB only
  //      returns campaign-create events (rare — usually <50/account/90d
  //      even for very active accounts). Backend caps to 2 pages.
  //   2. Per-row expand keeps using the unfiltered endpoint via
  //      `useAccountActivities` — different cache key — and gets the
  //      full edit history with the backend's 3-page safety cap.
  //
  // Throttled via a module-level Semaphore(5) so a 30-account view
  // doesn't open 30 concurrent /activities sockets the moment the
  // page mounts.
  const { status: authStatus } = useFbAuth();
  const activityQueries = useQueries({
    queries: visibleAll.map((acc) => ({
      queryKey: [
        "activities",
        acc.id,
        activitiesBounds.since,
        activitiesBounds.until,
        "creators",
      ],
      queryFn: (): Promise<FbActivity[]> =>
        activityPrefetchSem.run(async () => {
          const resp = await api.accounts.activities(
            acc.id,
            activitiesBounds.since,
            activitiesBounds.until,
            "create_campaign_group",
          );
          return resp.data ?? [];
        }),
      enabled: authStatus === "auth" && !!acc.id,
      staleTime: 5 * 60 * 1000,
    })),
  });

  // campaign_id → actor_name of the user who created it. Filter is
  // intentionally permissive: FB has emitted multiple event_type
  // shapes over the years ("create_campaign", "create_campaign_group",
  // and locale-prefixed variants), so we match on either the raw
  // event_type containing "create" OR the translated label containing
  // "建立". We don't filter on object_type because that field's casing
  // and naming has also varied (CAMPAIGN vs AD_CAMPAIGN); the
  // object_id → campaign.id lookup at render time gives us the
  // disambiguation we need.
  const creatorByCampaignId = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of activityQueries) {
      if (!q.data) continue;
      for (const a of q.data) {
        const oid = a.object_id;
        if (!oid || map.has(oid)) continue;
        const evt = (a.event_type ?? "").toLowerCase();
        const tEvt = a.translated_event_type ?? "";
        const isCreate = evt.includes("create") || tEvt.includes("建立");
        if (!isCreate) continue;
        const name = a.actor_name?.trim();
        if (name) map.set(oid, name);
      }
    }
    return map;
  }, [activityQueries]);

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
      <Topbar title="安全監控" titleAction={<AcctSidebarToggle />}>
        <div className="flex items-center gap-2 md:gap-3">
          <MobileAccountPicker
            accounts={visibleAll}
            selectedId={selectedAcctId}
            onSelect={setSelectedAcctId}
            className="bg-transparent px-0 py-0"
          />
          <TopbarSeparator />
          <DatePicker value={date} onChange={setDate} />
          <TopbarSeparator />
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

      <div className="flex min-w-0 items-start md:flex-row">
        {/* Desktop sidebar (≥768px) */}
        <div className="hidden md:flex">
          <AlertAccountPanel
            accounts={visibleAll}
            selectedAccountId={selectedAcctId}
            onSelect={setSelectedAcctId}
          />
        </div>

        <div className="min-w-0 flex-1 p-3 md:p-5">
          {showLoading ? (
            // Don't pass loaded/total — once `isLoading` flips false
            // (lite returned with empty data) the hook reports
            // loadedCount=accounts.length, which the LoadingState
            // treats as "honest mode 100%". The fake time-based
            // curve is more honest here since we don't have real
            // per-account progress to surface.
            <LoadingState title="載入廣告資料中..." subtitle="正在從 Facebook 拉取活動清單" />
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
                  defaultExpanded={tab === "pending"}
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
