import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import type { DateConfig } from "@/lib/datePicker";
import type { FbCreativeEntity } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";

/** Shared key builder — see adsetsQueryKey for why this must be the
 *  single source of truth (ComparisonTable subscribes to these same
 *  cache entries read-only). */
export function creativesQueryKey(adsetId: string | null, date: DateConfig) {
  return ["creatives", adsetId, date] as const;
}

/**
 * Fetch creatives (the 3rd tree level) for an adset. Lazily enabled
 * when the user expands an adset row.
 *
 * IMPORTANT: The class used to render these rows is `creative-row`
 * (NOT `ad-row`) — ad blockers match `[class^="ad-"]` and hide any
 * element whose class name starts with `ad-`. See commit d720fa2.
 */
export function useCreatives(adsetId: string | null, date: DateConfig, enabled: boolean) {
  const { status } = useFbAuth();
  return useQuery({
    queryKey: creativesQueryKey(adsetId, date),
    queryFn: async (): Promise<FbCreativeEntity[]> => {
      if (!adsetId) return [];
      const res = await api.adsets.creatives(adsetId, date);
      return res.data ?? [];
    },
    enabled: status === "auth" && !!adsetId && enabled,
    staleTime: 5 * 60_000,
  });
}
