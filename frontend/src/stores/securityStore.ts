import { api } from "@/api/client";
import { queryClient } from "@/lib/queryClient";
import { create } from "zustand";

const invalidateSharedSettings = () => {
  queryClient.invalidateQueries({ queryKey: ["settings", "shared"] });
};

/**
 * Security view store — tracks which campaigns the team has reviewed
 * and explicitly marked as "no issue / safe".
 *
 * Persistence: shared setting `security_safe_campaigns` in PG (team-wide).
 * SettingsProvider hydrates from the server at app boot; toggleSafe writes
 * back immediately (no debounce — toggles are click-driven and rare, and a
 * quick refresh after marking must not lose the write).
 */

export interface SecurityState {
  safeIds: Set<string>;
  /** Seeded from server by SettingsProvider — does NOT POST back. */
  hydrateFromServer: (ids: string[]) => void;
  toggleSafe: (campaignId: string) => void;
}

const persist = (ids: string[]) => {
  api.settings
    .setShared("security_safe_campaigns", ids)
    .then(invalidateSharedSettings)
    .catch(() => {});
};

export const useSecurityStore = create<SecurityState>((set, get) => ({
  safeIds: new Set(),
  hydrateFromServer: (ids) => set({ safeIds: new Set(ids) }),
  toggleSafe: (id) => {
    const next = new Set(get().safeIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ safeIds: next });
    persist([...next]);
  },
}));
