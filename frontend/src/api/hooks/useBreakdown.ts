import { api } from "@/api/client";
import type { DateConfig } from "@/lib/datePicker";
import { limitFb } from "@/lib/fbConcurrency";
import { useQuery } from "@tanstack/react-query";

export type BreakdownLevel = "adset" | "ad";
export type BreakdownDim = "publisher_platform" | "gender" | "age" | "region";

export const BREAKDOWN_DIM_LABELS: Record<BreakdownDim, string> = {
  publisher_platform: "版位",
  gender: "性別",
  age: "年齡層",
  region: "地區",
};

/**
 * Fetch insights for one entity (adset or ad), broken down by a
 * single dimension. Used by the report's expanded panels — same
 * shared `_runtime_token` as the rest of the share-page hooks, so
 * unauthenticated viewers can read it.
 */
export function useBreakdown(
  level: BreakdownLevel,
  id: string | null | undefined,
  dim: BreakdownDim,
  date: DateConfig,
  enabled = true,
) {
  return useQuery({
    queryKey: ["breakdown", level, id, dim, date] as const,
    queryFn: async () => {
      if (!id)
        return [] as Array<{
          key: string;
          spend: string | number | null;
          impressions: string | number | null;
          clicks: string | number | null;
          ctr: string | number | null;
          cpc: string | number | null;
          cpm: string | number | null;
          msgs: number;
        }>;
      // Funnel through the shared limiter so a report open (N adsets ×
      // this strip) staggers instead of firing an N-wide /insights burst.
      return (await limitFb(() => api.breakdown.list(level, id, dim, date))).data;
    },
    enabled: enabled && !!id,
    // 5 min cache window. Breakdown data updates with the rest of FB
    // insights (~hourly server-side); a longer window cuts repeat
    // share-page opens to zero FB calls and keeps us well under the
    // 80004 per-account throttle.
    staleTime: 5 * 60_000,
  });
}
