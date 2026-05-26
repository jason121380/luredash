import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import type { FbCampaign } from "@/types/fb";
import { useQueries } from "@tanstack/react-query";
import type { MonthCol } from "./historyData";

/**
 * Fire N parallel `/api/overview` requests — one per month column —
 * for a single account. Each query caches independently (keyed on
 * accountId + monthKey) so revisiting the view is instant and
 * switching between accounts only triggers the not-yet-seen months.
 *
 * Stale-time strategy: completed past months are immutable (FB
 * doesn't retroactively edit historical insights), so they get
 * `Infinity` — once fetched in the session they never refetch
 * automatically. The current month is still in flight, so it gets
 * the standard 5 minutes. A manual refresh always invalidates
 * via the global queryClient.
 *
 * `gcTime` is bumped for past months too (24h) so the cache
 * survives long-tab-idle sessions instead of being garbage-
 * collected after the default 30 minutes.
 */
export function useHistoricalSpend(accountId: string | null, months: MonthCol[]) {
  const { status } = useFbAuth();
  const enabled = status === "auth" && !!accountId;

  // "Current month" = the month containing today. We compare on
  // the column's `key` (YYYY-MM string) so the comparison is
  // independent of timezone-shift edge cases inside DateConfig.
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const results = useQueries({
    queries: months.map((col) => {
      const isCurrentMonth = col.key === currentMonthKey;
      return {
        queryKey: ["history-month", accountId, col.key],
        queryFn: async () => {
          if (!accountId) return { campaigns: [] as FbCampaign[] };
          const resp = await api.overview.batch([accountId], col.date, {
            includeArchived: true,
            source: "history",
          });
          const bundle = resp.data[accountId];
          return { campaigns: bundle?.campaigns ?? [] };
        },
        enabled,
        staleTime: isCurrentMonth ? 5 * 60_000 : Number.POSITIVE_INFINITY,
        gcTime: isCurrentMonth ? 30 * 60_000 : 24 * 60 * 60_000,
      };
    }),
  });

  const monthlyCampaigns = results.map((r) => r.data?.campaigns);
  const isLoading = results.some((r) => r.isLoading);
  const isFetching = results.some((r) => r.isFetching);
  const loadedCount = results.filter((r) => r.isSuccess).length;

  return {
    monthlyCampaigns,
    isLoading,
    isFetching,
    loadedCount,
    totalCount: months.length,
  };
}
