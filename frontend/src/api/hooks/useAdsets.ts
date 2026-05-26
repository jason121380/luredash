import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import type { DateConfig } from "@/lib/datePicker";
import type { FbAdset } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";

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
    queryKey: ["adsets", campaignId, date, opts?.source ?? "drill-adsets", opts?.budgetOnly ?? false],
    queryFn: async (): Promise<FbAdset[]> => {
      if (!campaignId) return [];
      const res = await api.campaigns.adsets(campaignId, date, opts);
      return res.data ?? [];
    },
    enabled: status === "auth" && !!campaignId && enabled,
    staleTime: 5 * 60_000,
  });
}
