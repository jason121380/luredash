import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import type { FbCampaign } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";
import type { MonthCol } from "./historyData";

/**
 * Fetch six monthly `/api/overview` snapshots for a single account.
 * This used to issue six React Query requests in parallel. That felt
 * fast, but each overview can hit FB metadata + insights, so one visit
 * to 歷史花費 could burst 12 Graph calls at once. We now run the months
 * sequentially inside one query: slower by a few seconds, much safer
 * for FB app/user buckets.
 */
export function useHistoricalSpend(accountId: string | null, months: MonthCol[]) {
  const { status } = useFbAuth();
  const enabled = status === "auth" && !!accountId;

  const query = useQuery({
    queryKey: ["history-months", accountId, months.map((m) => m.key).join(",")],
    queryFn: async () => {
      if (!accountId) return [] as Array<FbCampaign[]>;
      const out: Array<FbCampaign[]> = [];
      for (const col of months) {
        const resp = await api.overview.batch([accountId], col.date, {
          includeArchived: true,
          source: "history",
        });
        const bundle = resp.data[accountId];
        out.push(bundle?.campaigns ?? []);
      }
      return out;
    },
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 24 * 60 * 60_000,
  });

  const monthlyCampaigns = months.map((_, i) => query.data?.[i]);
  const isLoading = query.isLoading;
  const isFetching = query.isFetching;
  const loadedCount = query.data ? months.length : 0;

  return {
    monthlyCampaigns,
    isLoading,
    isFetching,
    loadedCount,
    totalCount: months.length,
  };
}
