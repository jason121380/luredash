import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { useQuery } from "@tanstack/react-query";

/**
 * Fetch the set of FB user ids permitted on this ad account. Used by
 * 安全監控 to mark Activity Log entries whose `actor_id` isn't in this
 * set as 「外部編輯者」. Cached aggressively (15 min) because BM
 * membership changes rarely. The hook returns a `Set<string>` ready
 * for O(1) membership lookups.
 */
export function useAccountAssignedUsers(accountId: string | null | undefined, enabled: boolean) {
  const { status } = useFbAuth();
  return useQuery({
    queryKey: ["assigned-users", accountId],
    queryFn: async (): Promise<Set<string>> => {
      if (!accountId) return new Set();
      const resp = await api.accounts.assignedUsers(accountId);
      return new Set(resp.data ?? []);
    },
    enabled: status === "auth" && !!accountId && enabled,
    staleTime: 15 * 60 * 1000,
  });
}
