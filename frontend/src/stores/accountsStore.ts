import { api } from "@/api/client";
import { toast } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import type { FbAccount } from "@/types/fb";
import { create } from "zustand";

/**
 * Accounts store — selected account ids, dashboard-active account ids,
 * user-defined drag-sort order.
 *
 * Persistence split (after the 2026-04-17 PG cutover):
 *   - selectedIds  → per-user setting `selected_accounts` (PostgreSQL)
 *   - order        → per-user setting `account_order`     (PostgreSQL)
 *   - activeIds    → localStorage `fb_active_accounts` (ephemeral,
 *                    session-scoped, intentionally NOT synced across
 *                    tabs / devices)
 *
 * SettingsProvider seeds selectedIds + order from the server once at
 * startup. After that, any store mutation fires a (debounced) POST to
 * persist. Calls route through the React Query cache so any other
 * component reading useUserSettings() sees the latest value.
 */

export interface AccountsState {
  selectedIds: string[];
  activeIds: string[];
  order: string[];

  /** Set by SettingsProvider when it receives the server response.
   * Separate from setSelectedIds so the seed doesn't trigger a POST
   * back (echo loop). */
  hydrateFromServer: (input: { selectedIds: string[]; order: string[] }) => void;

  setSelectedIds: (ids: string[]) => void;
  setActiveIds: (ids: string[]) => void;
  setOrder: (order: string[]) => void;

  visibleAccounts: (all: FbAccount[]) => FbAccount[];
}

// Module-level user id — set by SettingsProvider, read by sync writer.
// Null before login; mutations silently no-op until a user id lands.
let _currentUserId: string | null = null;
export function setAccountsUserId(id: string | null) {
  _currentUserId = id;
}
/** The fb user id currently registered for per-user setting writes.
 *  Exposed so other stores (e.g. financeStore's 重點關注) can reuse the
 *  SAME proven id — account-selection persistence uses it and works, so
 *  it's a reliable fallback if a store's own registration ever lags. */
export function getAccountsUserId(): string | null {
  return _currentUserId;
}

// Dev-only logger — production builds tree-shake these calls away.
const devLog = import.meta.env.DEV ? console.log.bind(console) : () => {};
const devWarn = import.meta.env.DEV ? console.warn.bind(console) : () => {};
const devError = import.meta.env.DEV ? console.error.bind(console) : () => {};

// selectedIds + order are discrete click actions (checkbox toggle,
// drag-end). Fire the POST immediately so a quick refresh doesn't
// drop the write. No debounce.
async function postSelected(ids: string[]): Promise<void> {
  if (!_currentUserId) {
    devWarn("[settings] postSelected skipped — no fb user id");
    toast("儲存失敗：無 FB 使用者 id", "error", 4000);
    return;
  }
  const uid = _currentUserId;
  devLog("[settings] POST selected_accounts uid=", uid, "ids=", ids);
  try {
    await api.settings.setUser(uid, "selected_accounts", ids);
    devLog("[settings] POST selected_accounts OK");
    // Invalidate the useUserSettings query so any UI reading from it
    // (avatar debug modal etc.) refetches instead of showing stale data.
    queryClient.invalidateQueries({ queryKey: ["settings", "user", uid] });
  } catch (e) {
    devError("[settings] POST selected_accounts FAILED:", e);
    toast(`儲存帳戶失敗：${(e as Error).message ?? "unknown"}`, "error", 5000);
  }
}
async function postOrder(order: string[]): Promise<void> {
  if (!_currentUserId) {
    devWarn("[settings] postOrder skipped — no fb user id");
    return;
  }
  const uid = _currentUserId;
  devLog("[settings] POST account_order uid=", uid, "order=", order);
  try {
    await api.settings.setUser(uid, "account_order", order);
    devLog("[settings] POST account_order OK");
    queryClient.invalidateQueries({ queryKey: ["settings", "user", uid] });
  } catch (e) {
    devError("[settings] POST account_order FAILED:", e);
    toast(`儲存排序失敗：${(e as Error).message ?? "unknown"}`, "error", 5000);
  }
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  selectedIds: [],
  activeIds: [],
  order: [],

  hydrateFromServer: ({ selectedIds, order }) => set({ selectedIds, order }),

  setSelectedIds: (ids) => {
    set({ selectedIds: ids });
    void postSelected(ids);
  },
  setActiveIds: (ids) => set({ activeIds: ids }),
  setOrder: (order) => {
    set({ order });
    void postOrder(order);
  },

  visibleAccounts: (all) => {
    const { selectedIds, order } = get();
    if (selectedIds.length === 0) return [];
    const list = all.filter((a) => selectedIds.includes(a.id));
    return list.sort((a, b) => {
      const ia = order.indexOf(a.id);
      const ib = order.indexOf(b.id);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.name.localeCompare(b.name, "zh-TW");
    });
  },
}));

// ── activeIds localStorage bridge (ephemeral UI state) ──────────
const K_ACTIVE = "fb_active_accounts";

function readArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function writeArray(key: string, value: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota */
  }
}

/** Hydrate only the ephemeral activeIds slice from localStorage.
 *  Called once at app startup BEFORE SettingsProvider runs. */
export function hydrateAccountsFromStorage(): void {
  useAccountsStore.setState({ activeIds: readArray(K_ACTIVE) });
}

/** Subscribe store changes → write activeIds to localStorage. */
export function installAccountsStorageSync(): () => void {
  return useAccountsStore.subscribe((state, prev) => {
    if (state.activeIds !== prev.activeIds) writeArray(K_ACTIVE, state.activeIds);
  });
}
