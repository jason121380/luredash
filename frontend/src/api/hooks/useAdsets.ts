import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import type { DateConfig } from "@/lib/datePicker";
import type { FbAdset } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";

/**
 * Shared key builder. ComparisonTable (素材比較) subscribes to the
 * SAME cache entries the tree's AdsetRow populates — when the two
 * sides build keys independently any drift silently breaks the
 * comparison view (it shows the「請先展開」hint forever, which is
 * exactly what happened when source/budgetOnly were appended to the
 * key). Single source of truth prevents a repeat.
 */
export function adsetsQueryKey(
  campaignId: string | null,
  date: DateConfig,
  opts?: { source?: string; budgetOnly?: boolean },
) {
  return [
    "adsets",
    campaignId,
    date,
    opts?.source ?? "drill-adsets",
    opts?.budgetOnly ?? false,
  ] as const;
}

/**
 * Fetch adsets for a campaign. Lazily enabled: only fires when
 * `campaignId` is defined AND the caller toggles `enabled` (usually
 * when the user expands the campaign row).
 */
export function useAdsets(
  campaignId: string | null,
  date: DateConfig,
  enabled: boolean,
  opts?: { source?: string; budgetOnly?: boolean },
) {
  const { status } = useFbAuth();
  return useQuery({
    queryKey: adsetsQueryKey(campaignId, date, opts),
    queryFn: async (): Promise<FbAdset[]> => {
      if (!campaignId) return [];
      const res = await api.campaigns.adsets(campaignId, date, opts);
      return res.data ?? [];
    },
    enabled: status === "auth" && !!campaignId && enabled,
    staleTime: 5 * 60_000,
  });
}
