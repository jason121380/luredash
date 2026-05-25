import { api } from "@/api/client";
import type { DateConfig } from "@/lib/datePicker";
import type { FbAdset, FbCampaign, FbCreativeEntity } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";

/** Lazy fetch of ads inside a single adset for the report's 3rd-level
 *  expansion. Same shared-token pattern as `useReportCampaign`. */
export function useReportAds(adsetId: string | null, date: DateConfig, enabled: boolean) {
  return useQuery({
    queryKey: ["report-ads", adsetId, date] as const,
    queryFn: async (): Promise<FbCreativeEntity[]> => {
      if (!adsetId) return [];
      return (await api.adsets.creatives(adsetId, date)).data ?? [];
    },
    enabled: enabled && !!adsetId,
    staleTime: 5 * 60_000,
  });
}

/**
 * Fetch a single campaign + its adsets for the public share page.
 *
 * Auth: these endpoints use the backend's shared `_runtime_token`, so
 * they work without the viewer being logged into Facebook. If the
 * team admin's token expires / server restarts with no re-login,
 * every request here returns 401 and the page shows an error state.
 *
 * Cold-load cost: previously this hit `/api/accounts/{id}/campaigns`
 * (whole account) then filtered to one — wasteful for heavy accounts
 * like 吸引力 LURE where FB had to compute insights for 100+ campaigns
 * to surface one. Now uses the single-campaign endpoint:
 * `/api/campaigns/{id}?date_preset=X` → 1 cheap FB call. `accountId`
 * is still accepted in the signature for back-compat but no longer
 * required (kept so callers don't break).
 */
export function useReportCampaign(
  campaignId: string | null,
  _accountId: string | null,
  date: DateConfig,
) {
  const enabled = !!campaignId;

  const campaignQuery = useQuery({
    queryKey: ["report-campaign", campaignId, date],
    queryFn: async (): Promise<FbCampaign | null> => {
      if (!campaignId) return null;
      const resp = await api.campaigns.get(campaignId, date);
      return resp.data ?? null;
    },
    enabled,
    staleTime: 5 * 60_000,
  });

  const adsetsQuery = useQuery({
    queryKey: ["report-adsets", campaignId, date],
    queryFn: async (): Promise<FbAdset[]> => {
      if (!campaignId) return [];
      const resp = await api.campaigns.adsets(campaignId, date);
      return resp.data ?? [];
    },
    enabled,
    staleTime: 5 * 60_000,
  });

  return { campaignQuery, adsetsQuery };
}
