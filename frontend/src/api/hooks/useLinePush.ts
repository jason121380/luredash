import { type LinePushConfigInput, api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * React Query hooks for the LINE push feature.
 *
 * Scope:
 *   - useLineGroups()                 — all groups the bot is in
 *   - useLineGroupPushConfigs(gid)    — configs for one group
 *   - useSaveLinePushConfig()         — create / update
 *   - useDeleteLinePushConfig()       — delete
 *   - useTestLinePush()               — fire a push immediately
 *
 * Note: per-campaign listing was removed when the dashboard's per-row
 * LINE push button was retired (2026-04-29). The group-nickname
 * (`label`) feature was removed (2026-04-29) — group display name now
 * comes solely from LINE's `/v2/bot/group/{id}/summary`. All push
 * configuration happens via the Settings → LINE 推播設定 page.
 */

const CHANNELS_KEY = ["lineChannels"] as const;
const GROUPS_KEY = ["lineGroups"] as const;
const GROUP_CONFIGS_PREFIX = ["lineGroupConfigs"] as const;

// ── Channels (multi-OA, per-user) ─────────────────────────────
//
// All channel ops require the current FB user id (server-side
// ownership gate). The hooks pull it from FbAuthProvider so callers
// don't have to thread it manually.

export function useLineChannels() {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useQuery({
    queryKey: ["lineChannels", uid] as const,
    queryFn: async () => (await api.lineChannels.list(uid)).data,
    enabled: !!uid,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useCreateLineChannel() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.lineChannels.create>[1]) =>
      api.lineChannels.create(user?.id ?? "", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
  });
}

export function useUpdateLineChannel() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: ({
      id,
      body,
    }: { id: string; body: Parameters<typeof api.lineChannels.update>[2] }) =>
      api.lineChannels.update(user?.id ?? "", id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CHANNELS_KEY });
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
    },
  });
}

export function useDeleteLineChannel() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: (id: string) => api.lineChannels.delete(user?.id ?? "", id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
  });
}

export function useClaimLineChannel() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: (id: string) => api.lineChannels.claim(user?.id ?? "", id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CHANNELS_KEY });
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
      qc.invalidateQueries({ queryKey: GROUP_CONFIGS_PREFIX });
    },
  });
}

/** Real-time quota / consumption query for one channel. Disabled by
 *  default so we don't burn LINE API calls on every page load —
 *  callers `refetch()` on click. 2 min staleTime so a quick second
 *  click within the window gets the cached value. */
export function useLineChannelQuota(channelId: string) {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useQuery({
    queryKey: ["lineChannelQuota", uid, channelId] as const,
    queryFn: () => api.lineChannels.quota(uid, channelId),
    enabled: false,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: false,
  });
}

export function useLineGroups() {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useQuery({
    queryKey: ["lineGroups", uid] as const,
    queryFn: async () => (await api.linePush.listGroups(uid)).data,
    enabled: !!uid,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useRefreshLineGroupName() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => api.linePush.refreshGroupName(groupId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
    },
  });
}

export function useLineGroupPushConfigs(groupId: string | null | undefined) {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useQuery({
    queryKey: ["lineGroupConfigs", uid, groupId ?? ""] as const,
    queryFn: async () => (await api.linePush.listGroupConfigs(uid, groupId ?? "")).data,
    enabled: !!groupId && !!uid,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}

export function useSaveLinePushConfig() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: (payload: LinePushConfigInput) =>
      api.linePush.upsertConfig(user?.id ?? "", payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUP_CONFIGS_PREFIX });
    },
  });
}

export function useDeleteLinePushConfig() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: (id: string) => api.linePush.deleteConfig(user?.id ?? "", id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUP_CONFIGS_PREFIX });
    },
  });
}

export function useTestLinePush() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: (id: string) => api.linePush.test(user?.id ?? "", id),
    // A successful test clears the config's fail_count / last_error on the
    // server — refetch so the red「上次失敗」line disappears immediately.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUP_CONFIGS_PREFIX });
    },
  });
}

// ── Group folders (per-OA categorisation) ─────────────────────

const FOLDERS_KEY = ["lineFolders"] as const;

export function useLineGroupFolders() {
  const { user } = useFbAuth();
  const uid = user?.id ?? "";
  return useQuery({
    queryKey: ["lineFolders", uid] as const,
    queryFn: async () => (await api.lineFolders.list(uid)).data,
    enabled: !!uid,
    staleTime: 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useCreateLineFolder() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: ({ channelId, name }: { channelId: string; name: string }) =>
      api.lineFolders.create(user?.id ?? "", channelId, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FOLDERS_KEY });
    },
  });
}

export function useUpdateLineFolder() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: ({
      folderId,
      body,
    }: {
      folderId: string;
      body: { name?: string; sort_order?: number };
    }) => api.lineFolders.update(user?.id ?? "", folderId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: FOLDERS_KEY });
    },
  });
}

export function useDeleteLineFolder() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: (folderId: string) => api.lineFolders.delete(user?.id ?? "", folderId),
    onSuccess: () => {
      // Deleting a folder un-categorises its groups → refetch both.
      qc.invalidateQueries({ queryKey: FOLDERS_KEY });
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
    },
  });
}

export function useSetLineGroupFolder() {
  const qc = useQueryClient();
  const { user } = useFbAuth();
  return useMutation({
    mutationFn: ({ groupId, folderId }: { groupId: string; folderId: string | null }) =>
      api.linePush.setGroupFolder(user?.id ?? "", groupId, folderId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GROUPS_KEY });
      qc.invalidateQueries({ queryKey: FOLDERS_KEY });
    },
  });
}
