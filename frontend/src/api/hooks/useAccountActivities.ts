import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import type { FbActivity } from "@/types/fb";
import { useQuery } from "@tanstack/react-query";

/**
 * Fetch the FB Activity Log for one ad account over a unix-time
 * window. Used by 安全監控 to attach per-campaign edit history under
 * each row.
 *
 * `objectId` asks the backend to narrow the FB Activity Log to one
 * campaign/ad object when Meta accepts that filter. We still filter
 * client-side in the row because Meta's activity response shape is not
 * stable across object types.
 *
 * `enabled` is gated on auth + a non-empty account id so we never fire
 * unauthenticated and can be conditionally suspended when the user
 * collapses the expand. Cached for 5 minutes (aligned with the rest
 * of the data layer) — activity log doesn't change fast enough to
 * justify the 2× extra FB calls a 2-minute window costs.
 */
export function useAccountActivities(
  accountId: string | null | undefined,
  since: number,
  until: number,
  objectId: string | null | undefined,
  enabled: boolean,
) {
  const { status } = useFbAuth();
  return useQuery({
    queryKey: ["activities", accountId, since, until, objectId ?? null],
    queryFn: async (): Promise<FbActivity[]> => {
      if (!accountId) return [];
      const resp = await api.accounts.activities(accountId, since, until, objectId ?? undefined);
      return resp.data ?? [];
    },
    enabled: status === "auth" && !!accountId && enabled,
    staleTime: 5 * 60 * 1000,
  });
}
