import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import type { DateConfig } from "@/lib/datePicker";
import type { FbAccount, FbCampaign, FbInsights } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

// ── localStorage snapshot ─────────────────────────────────────
//
// Persists the most recent successful overview response so a hard
// refresh (or first paint after navigating back to the app) shows
// last-seen numbers immediately, while a live refetch runs in the
// background. This is what lets the dashboard / analytics / alerts
// / finance / store-expenses views render without a 5-15s spinner
// after a browser reload.
//
// Bounded storage: ONE entry total, keyed on (idsKey, date,
// includeArchived). Switching to a different account-set or date
// preset overwrites the previous snapshot — historical entries are
// not retained (would risk blowing the localStorage quota with 50+
// KB campaign blobs each).

const SNAPSHOT_KEY = "fb-overview-snapshot";
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000; // ignore anything older than 24h

interface OverviewSnapshot {
  hash: string;
  savedAt: number;
  // Stored verbatim — same shape the React Query cache holds.
  data: Awaited<ReturnType<typeof api.overview.batch>>;
}

function snapshotHash(idsKey: string, date: DateConfig, includeArchived: boolean): string {
  return `${idsKey}|${date.preset}|${date.from ?? ""}|${date.to ?? ""}|${includeArchived ? 1 : 0}`;
}

function readOverviewSnapshot(
  hash: string,
): Awaited<ReturnType<typeof api.overview.batch>> | undefined {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as OverviewSnapshot;
    if (parsed.hash !== hash) return undefined;
    if (Date.now() - parsed.savedAt > SNAPSHOT_MAX_AGE_MS) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

function writeOverviewSnapshot(
  hash: string,
  data: Awaited<ReturnType<typeof api.overview.batch>>,
): void {
  try {
    const entry: OverviewSnapshot = { hash, savedAt: Date.now(), data };
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(entry));
  } catch {
    // QuotaExceeded / private mode — silently skip. Live data is
    // still in the React Query memory cache for this session.
  }
}

/**
 * Two-phase batch multi-account overview hook.
 *
 * Phase 1 ("lite"): fetches campaign metadata WITHOUT insights
 * (~1-2s). The tree table renders rows immediately — campaign
 * names, statuses, and budget badges appear while numbers show "—".
 *
 * Phase 2 ("full"): fetches campaigns WITH inline insights + account
 * insights (~5-15s). Once this resolves the tree table fills in
 * spend, CTR, CPC, and all numeric columns.
 *
 * Both requests fly in parallel. The lite result populates the UI
 * first; the full result replaces it when ready. TanStack Query
 * caches both independently — on subsequent loads within 5 minutes,
 * the full data is served instantly from cache.
 *
 * Return shape is the same as the previous single-phase hook so all
 * consumers (Dashboard, Alerts, Finance, Analytics) work unchanged.
 */

export interface MultiAccountOverviewResult {
  /** Flattened campaigns across all requested accounts. */
  campaigns: FbCampaign[];
  /** Per-account insights keyed by account id (flat first entry). */
  insights: Record<string, FbInsights | null>;
  /** Per-account error messages keyed by account id. */
  errors: Record<string, string>;
  /** True while BOTH lite and full are still loading (nothing to show). */
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  /** True while full data (with insights) has not yet resolved. When
   * lite data is available but insights are still pending, StatsGrid
   * should show shimmer placeholders instead of "$0" values. */
  insightsPending: boolean;
  loadedCount: number;
  totalCount: number;
}

export function useMultiAccountOverview(
  accounts: FbAccount[],
  date: DateConfig,
  opts: {
    includeArchived?: boolean;
    includeAdsets?: boolean;
    /** Tags the resulting FB calls in the engineering panel's 來源 column.
     * e.g. "security-scan" when fired by 立即掃描. */
    source?: string;
    /** Override default 5min staleTime. Pass Infinity to keep cached
     * data fresh forever; combined with the global refetchOnMount:false
     * this means the view shows cached results until the user
     * explicitly clicks a rescan(which invalidates the query). */
    staleTime?: number;
    /** Override default 30min gcTime. Pass Infinity to prevent the
     * cache entry from ever being garbage-collected — useful for the
     * on-demand security scan where we want「上次結果一直在」即使
     * tab 開了一整天沒動。 */
    gcTime?: number;
    /** Fetch only the lite campaign metadata phase. Use for workflows
     * that do not need insights/account metrics, such as security scan. */
    liteOnly?: boolean;
  } = {},
): MultiAccountOverviewResult {
  const { status } = useFbAuth();

  // Sort ids so cache keys are stable regardless of array order.
  const sortedIds = useMemo(() => {
    return [...accounts.map((a) => a.id)].sort();
  }, [accounts]);
  const idsKey = sortedIds.join(",");

  const enabled = status === "auth" && accounts.length > 0;

  // Phase 2 (rate-limit reduction): when a localStorage snapshot is
  // already on hand for this exact (idsKey, date, archived) tuple,
  // SKIP the lite call entirely. The snapshot already paints the
  // UI; firing lite would only duplicate work the full query is
  // about to redo. Cold-start (no snapshot) still gets the lite +
  // full two-phase progressive render.
  //
  // Saves ~N FB calls per dashboard reload (one per selected account)
  // for the 99% case where the user has visited the same set of
  // accounts within the last 24h.
  const snapHash = snapshotHash(idsKey, date, !!opts.includeArchived);
  const hasSnapshot = useMemo(() => !!readOverviewSnapshot(snapHash), [snapHash]);

  // Phase 1: lite (no insights — fast)
  const liteQuery = useQuery({
    queryKey: ["overview-lite", idsKey, date, !!opts.includeArchived, !!opts.includeAdsets],
    queryFn: async () => {
      if (sortedIds.length === 0) {
        return { data: {} } as Awaited<ReturnType<typeof api.overview.batch>>;
      }
      return api.overview.batch(sortedIds, date, { ...opts, lite: true });
    },
    enabled: enabled && (opts.liteOnly || !hasSnapshot),
    staleTime: opts.staleTime ?? 5 * 60_000,
    gcTime: opts.gcTime,
  });

  // Phase 2: full (with insights — slow). placeholderData seeds the
  // query with the last-seen snapshot from localStorage so the UI
  // renders instantly on hard refresh / app re-open. The live query
  // still fires in the background; once it resolves the cards
  // refresh in place. snapHash is recomputed when accounts or date
  // change so a stale snapshot for a different combo is correctly
  // ignored.
  const fullQuery = useQuery({
    queryKey: ["overview", idsKey, date, !!opts.includeArchived, !!opts.includeAdsets],
    queryFn: async () => {
      if (sortedIds.length === 0) {
        return { data: {} } as Awaited<ReturnType<typeof api.overview.batch>>;
      }
      return api.overview.batch(sortedIds, date, opts);
    },
    enabled: enabled && !opts.liteOnly,
    staleTime: opts.staleTime ?? 5 * 60_000,
    gcTime: opts.gcTime,
    placeholderData: () => readOverviewSnapshot(snapHash),
  });

  // Persist successful responses — placeholder hits feel instant
  // because we wrote here last time. Skip writes when the response
  // came from the placeholder (isFetching means a refetch is in
  // flight — wait for it to land before saving).
  //
  // The write is deferred via setTimeout(0) so JSON.stringify of
  // the (potentially 100KB+ for 60 accounts) blob lands AFTER the
  // success render commits, instead of blocking the main thread on
  // the very paint that's trying to show fresh data.
  useEffect(() => {
    if (fullQuery.isSuccess && !fullQuery.isFetching && fullQuery.data) {
      const data = fullQuery.data;
      const handle = setTimeout(() => writeOverviewSnapshot(snapHash, data), 0);
      return () => clearTimeout(handle);
    }
    return undefined;
  }, [fullQuery.isSuccess, fullQuery.isFetching, fullQuery.data, snapHash]);

  // Prefer full data when available, fall back to lite.
  const activeData = opts.liteOnly ? liteQuery.data : (fullQuery.data ?? liteQuery.data);

  const { campaigns, insights, errors } = useMemo(() => {
    const camps: FbCampaign[] = [];
    const insMap: Record<string, FbInsights | null> = {};
    const errs: Record<string, string> = {};

    for (const acc of accounts) {
      insMap[acc.id] = null;
    }

    const data = activeData?.data ?? {};
    for (const [acctId, bundle] of Object.entries(data)) {
      const acc = accounts.find((a) => a.id === acctId);
      const acctName = acc?.name ?? "";
      if (bundle.error) {
        errs[acctId] = bundle.error;
      }
      for (const c of bundle.campaigns ?? []) {
        camps.push({ ...c, _accountId: acctId, _accountName: acctName });
      }
      insMap[acctId] = bundle.insights ?? null;
    }

    return { campaigns: camps, insights: insMap, errors: errs };
  }, [accounts, activeData]);

  // `fullQuery.data` is populated either by a live success OR by
  // the localStorage placeholder. Either way we have insight numbers
  // to show — UI shouldn't shimmer when cached numbers are in hand.
  const hasFullData = opts.liteOnly ? liteQuery.data !== undefined : fullQuery.data !== undefined;

  // isLoading = nothing to show yet (no live data, no placeholder,
  // and lite is also still in flight).
  const isLoading = opts.liteOnly
    ? liteQuery.isLoading
    : !hasFullData && liteQuery.isLoading && fullQuery.isLoading;

  return {
    campaigns,
    insights,
    errors,
    isLoading,
    isFetching: opts.liteOnly ? liteQuery.isFetching : fullQuery.isFetching,
    isError: opts.liteOnly ? liteQuery.isError : fullQuery.isError && liteQuery.isError,
    // Treat placeholder-from-localStorage as "we have insights" so
    // StatsGrid renders the cached numbers instead of shimmer.
    insightsPending: opts.liteOnly ? false : !hasFullData && !fullQuery.isError,
    loadedCount: isLoading ? 0 : accounts.length,
    totalCount: accounts.length,
  };
}
