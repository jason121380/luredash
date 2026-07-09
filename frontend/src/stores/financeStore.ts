import { api } from "@/api/client";
import { debounce } from "@/lib/debounce";
import { queryClient } from "@/lib/queryClient";
import { create } from "zustand";

const invalidateSharedSettings = () => {
  queryClient.invalidateQueries({ queryKey: ["settings", "shared"] });
};

/**
 * Finance store — row markup overrides, pinned ids, default markup,
 * show-nicknames toggle.
 *
 * Persistence (after the 2026-04-17 PG cutover):
 *   - rowMarkups    → shared setting `finance_row_markups`        (PG)
 *   - pinnedIds     → shared setting `finance_pinned_ids`         (PG)
 *   - defaultMarkup → shared setting `finance_default_markup`     (PG)
 *   - showNicknames → shared setting `finance_show_nicknames`     (PG)
 *
 * SettingsProvider seeds these from the server at startup. After that,
 * any mutation fires a debounced POST to persist team-wide. No more
 * localStorage for these fields.
 */

export interface FinanceState {
  rowMarkups: Record<string, number>;
  pinnedIds: string[];
  defaultMarkup: number;
  showNicknames: boolean;
  /** Dashboard report KPI selection (team-wide). null = each report's
   *  built-in default layout; non-null = only these KPI codes. */
  reportFields: string[] | null;

  /** One-way seed from server — set by SettingsProvider on first load.
   * Does NOT trigger a POST back. */
  hydrateFromServer: (input: {
    rowMarkups: Record<string, number>;
    pinnedIds: string[];
    defaultMarkup: number;
    showNicknames: boolean;
    reportFields: string[] | null;
  }) => void;

  setRowMarkup: (campaignId: string, percent: number) => void;
  togglePin: (campaignId: string) => void;
  setDefaultMarkup: (v: number) => void;
  setShowNicknames: (v: boolean) => void;
  setReportFields: (v: string[] | null) => void;
}

// Typed-input writers (markup %) are debounced so we don't POST on
// every keystroke. Click-driven writers (togglePin, setShowNicknames)
// fire immediately so a quick refresh after a click never loses the
// write.
const postRowMarkups = debounce((m: Record<string, number>) => {
  api.settings
    .setShared("finance_row_markups", m)
    .then(invalidateSharedSettings)
    .catch(() => {});
}, 500);
const postDefaultMarkup = debounce((v: number) => {
  api.settings
    .setShared("finance_default_markup", v)
    .then(invalidateSharedSettings)
    .catch(() => {});
}, 500);

const postPinnedIds = (ids: string[]) => {
  api.settings
    .setShared("finance_pinned_ids", ids)
    .then(invalidateSharedSettings)
    .catch(() => {});
};
const postShowNicknames = (v: boolean) => {
  api.settings
    .setShared("finance_show_nicknames", v)
    .then(invalidateSharedSettings)
    .catch(() => {});
};
const postReportFields = (v: string[] | null) => {
  api.settings
    .setShared("report_selected_fields", v)
    .then(invalidateSharedSettings)
    .catch(() => {});
};

// Belt-and-suspenders for the debounced typed-input writers: if the
// user navigates away mid-debounce, flush the pending write so the
// server sees the latest value. `fetch` keepalive is honored by every
// modern browser for sub-64KB request bodies, which applies to us.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    postRowMarkups.flush();
    postDefaultMarkup.flush();
  });
}

export const useFinanceStore = create<FinanceState>((set) => ({
  rowMarkups: {},
  pinnedIds: [],
  defaultMarkup: 5,
  showNicknames: true,
  reportFields: null,

  hydrateFromServer: ({ rowMarkups, pinnedIds, defaultMarkup, showNicknames, reportFields }) =>
    set({ rowMarkups, pinnedIds, defaultMarkup, showNicknames, reportFields }),

  setRowMarkup: (campaignId, percent) =>
    set((state) => {
      const next = { ...state.rowMarkups, [campaignId]: percent };
      postRowMarkups(next);
      return { rowMarkups: next };
    }),

  togglePin: (campaignId) =>
    set((state) => {
      const idx = state.pinnedIds.indexOf(campaignId);
      const next =
        idx === -1 ? [...state.pinnedIds, campaignId] : state.pinnedIds.filter((_, i) => i !== idx);
      postPinnedIds(next);
      return { pinnedIds: next };
    }),

  setDefaultMarkup: (v) => {
    set({ defaultMarkup: v });
    postDefaultMarkup(v);
  },
  setShowNicknames: (v) => {
    set({ showNicknames: v });
    postShowNicknames(v);
  },
  setReportFields: (v) => {
    set({ reportFields: v });
    postReportFields(v);
  },
}));

// Settings persistence lives in PostgreSQL now. These helpers remain
// as no-ops so the stores/index.ts barrel keeps its old API without
// every caller having to change.
export function hydrateFinanceFromStorage(): void {
  /* PG-backed; SettingsProvider does the real hydrate. */
}

export function installFinanceStorageSync(): () => void {
  return () => {
    /* no localStorage sync */
  };
}
