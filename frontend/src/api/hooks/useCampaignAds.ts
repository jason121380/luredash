import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { useQuery } from "@tanstack/react-query";

/**
 * Flat list of ads (3rd level) under a campaign — name/status only.
 * Backs the LINE-push「以廣告播報」multi-picker; lazily enabled so the
 * request only fires once the operator actually checks the box.
 */
export function useCampaignAds(campaignId: string | null, enabled: boolean) {
  const { status } = useFbAuth();
  return useQuery({
    queryKey: ["campaign-ads", campaignId],
    queryFn: async () => {
      if (!campaignId) return [];
      const res = await api.campaigns.ads(campaignId);
      return res.data ?? [];
    },
    enabled: status === "auth" && !!campaignId && enabled,
    staleTime: 5 * 60_000,
  });
}
