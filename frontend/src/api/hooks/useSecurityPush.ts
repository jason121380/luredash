import { type SecurityPushConfigInput, api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const CONFIGS_KEY = ["securityPushConfigs"] as const;

/**
 * React Query hooks for 安全監控推播.
 *
 * `useSecurityPushConfigs()` reads the current user's alert
 * subscriptions; `useSaveSecurityPushConfig` / `useDeleteSecurityPushConfig`
 * mutate them and invalidate the list on success.
 */

export function useSecurityPushConfigs() {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useQuery({
    queryKey: [...CONFIGS_KEY, uid] as const,
    queryFn: async () => (await api.securityPush.list(uid)).data,
    enabled: !!uid,
    staleTime: 60 * 1000,
  });
}

export function useSaveSecurityPushConfig() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useMutation({
    mutationFn: async (payload: SecurityPushConfigInput) => {
      if (!uid) throw new Error("not signed in");
      return (await api.securityPush.upsert(uid, payload)).data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CONFIGS_KEY });
    },
  });
}

export function useDeleteSecurityPushConfig() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useMutation({
    mutationFn: async (id: string) => {
      if (!uid) throw new Error("not signed in");
      await api.securityPush.delete(uid, id);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CONFIGS_KEY });
    },
  });
}

export function useTestSecurityPushConfig() {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useMutation({
    mutationFn: async (id: string) => {
      if (!uid) throw new Error("not signed in");
      return await api.securityPush.test(uid, id);
    },
  });
}
