import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the api client BEFORE importing the stores so the module-level
// debounced writers capture the mock, not the real network call.
vi.mock("@/api/client", () => ({
  api: {
    settings: {
      setUser: vi.fn().mockResolvedValue({ ok: true }),
      setShared: vi.fn().mockResolvedValue({ ok: true }),
      getUser: vi.fn().mockResolvedValue({ data: {} }),
      getShared: vi.fn().mockResolvedValue({ data: {} }),
    },
  },
  ApiError: class ApiError extends Error {
    status = 0;
    detail = "";
  },
}));

import { api } from "@/api/client";
import {
  hydrateAccountsFromStorage,
  installAccountsStorageSync,
  setAccountsUserId,
  useAccountsStore,
} from "@/stores/accountsStore";
import {
  hydrateFiltersFromStorage,
  installFiltersStorageSync,
  useFiltersStore,
} from "@/stores/filtersStore";
import { useFinanceStore } from "@/stores/financeStore";
import type { FbAccount } from "@/types/fb";

const resetStores = () => {
  useAccountsStore.setState({ selectedIds: [], activeIds: [], order: [] });
  useFiltersStore.setState({
    activeOnly: true,
    date: {
      shared: { preset: "this_month", from: null, to: null },
      optimization: { preset: "this_month", from: null, to: null },
    },
  });
  useFinanceStore.setState({
    rowMarkups: {},
    pinnedIds: [],
    defaultMarkup: 5,
    showNicknames: true,
  });
};

beforeEach(() => {
  localStorage.clear();
  resetStores();
  vi.clearAllMocks();
  setAccountsUserId(null);
});

describe("accountsStore — PG + localStorage hybrid", () => {
  it("hydrateFromServer seeds selectedIds + order without POSTing back", () => {
    setAccountsUserId("fbuser_1");
    useAccountsStore.getState().hydrateFromServer({
      selectedIds: ["act_1", "act_2"],
      order: ["act_2", "act_1"],
    });
    const s = useAccountsStore.getState();
    expect(s.selectedIds).toEqual(["act_1", "act_2"]);
    expect(s.order).toEqual(["act_2", "act_1"]);
    // Seed does NOT POST — only explicit setSelectedIds / setOrder do.
    expect(api.settings.setUser).not.toHaveBeenCalled();
  });

  it("setSelectedIds POSTs immediately with the user id", () => {
    setAccountsUserId("fbuser_2");
    useAccountsStore.getState().setSelectedIds(["act_5"]);
    expect(api.settings.setUser).toHaveBeenCalledWith("fbuser_2", "selected_accounts", ["act_5"]);
  });

  it("activeIds still persists to localStorage (ephemeral UI state)", () => {
    const off = installAccountsStorageSync();
    useAccountsStore.getState().setActiveIds(["act_5"]);
    expect(localStorage.getItem("fb_active_accounts")).toBe('["act_5"]');
    off();
  });

  it("hydrateAccountsFromStorage only populates activeIds, not selectedIds/order", () => {
    localStorage.setItem("fb_active_accounts", JSON.stringify(["act_7"]));
    localStorage.setItem("fb_selected_accounts", JSON.stringify(["act_999"]));
    hydrateAccountsFromStorage();
    const s = useAccountsStore.getState();
    expect(s.activeIds).toEqual(["act_7"]);
    // selectedIds is NOT read from localStorage anymore.
    expect(s.selectedIds).toEqual([]);
  });

  it("visibleAccounts respects custom order then falls back to alpha", () => {
    const all: FbAccount[] = [
      { id: "act_1", name: "Zebra", account_status: 1 },
      { id: "act_2", name: "Apple", account_status: 1 },
      { id: "act_3", name: "Mango", account_status: 1 },
    ];
    useAccountsStore.setState({ selectedIds: ["act_1", "act_2", "act_3"], order: ["act_3"] });
    const visible = useAccountsStore.getState().visibleAccounts(all);
    expect(visible.map((a) => a.id)).toEqual(["act_3", "act_2", "act_1"]);
  });

  it("returns empty visibleAccounts when no ids are selected", () => {
    const all: FbAccount[] = [{ id: "act_1", name: "X", account_status: 1 }];
    expect(useAccountsStore.getState().visibleAccounts(all)).toEqual([]);
  });
});

describe("filtersStore — localStorage bridge", () => {
  it("hydrates activeOnly as true by default", () => {
    hydrateFiltersFromStorage();
    expect(useFiltersStore.getState().activeOnly).toBe(true);
  });
  it("hydrates activeOnly as false when the raw value is 'false'", () => {
    localStorage.setItem("filter_active_only", "false");
    hydrateFiltersFromStorage();
    expect(useFiltersStore.getState().activeOnly).toBe(false);
  });
  it("any other raw value is truthy (matches legacy behavior)", () => {
    localStorage.setItem("filter_active_only", "true");
    hydrateFiltersFromStorage();
    expect(useFiltersStore.getState().activeOnly).toBe(true);
  });
  it("writes back the boolean as a string", () => {
    const off = installFiltersStorageSync();
    useFiltersStore.getState().setActiveOnly(false);
    expect(localStorage.getItem("filter_active_only")).toBe("false");
    off();
  });
});

describe("financeStore — PG-backed shared settings", () => {
  it("hydrateFromServer seeds all fields without POSTing", () => {
    useFinanceStore.getState().hydrateFromServer({
      rowMarkups: { cmp_1: 7.5 },
      pinnedIds: ["cmp_2"],
      defaultMarkup: 10,
      showNicknames: false,
      reportFields: ["spend", "ctr"],
    });
    const s = useFinanceStore.getState();
    expect(s.rowMarkups).toEqual({ cmp_1: 7.5 });
    expect(s.pinnedIds).toEqual(["cmp_2"]);
    expect(s.defaultMarkup).toBe(10);
    expect(s.showNicknames).toBe(false);
    expect(s.reportFields).toEqual(["spend", "ctr"]);
    expect(api.settings.setShared).not.toHaveBeenCalled();
  });

  it("togglePin adds then removes an id and POSTs immediately", () => {
    useFinanceStore.getState().togglePin("cmp_1");
    expect(useFinanceStore.getState().pinnedIds).toEqual(["cmp_1"]);
    expect(api.settings.setShared).toHaveBeenCalledWith("finance_pinned_ids", ["cmp_1"]);
    useFinanceStore.getState().togglePin("cmp_1");
    expect(useFinanceStore.getState().pinnedIds).toEqual([]);
    expect(api.settings.setShared).toHaveBeenLastCalledWith("finance_pinned_ids", []);
  });

  it("setRowMarkup schedules a debounced POST with the merged map", async () => {
    useFinanceStore.getState().setRowMarkup("cmp_9", 12.5);
    expect(useFinanceStore.getState().rowMarkups).toEqual({ cmp_9: 12.5 });
    await new Promise((r) => setTimeout(r, 550));
    expect(api.settings.setShared).toHaveBeenCalledWith("finance_row_markups", { cmp_9: 12.5 });
  });

  it("setReportFields stores + POSTs team-wide (null clears)", () => {
    useFinanceStore.getState().setReportFields(["spend", "msgs"]);
    expect(useFinanceStore.getState().reportFields).toEqual(["spend", "msgs"]);
    expect(api.settings.setShared).toHaveBeenCalledWith("report_selected_fields", [
      "spend",
      "msgs",
    ]);
    useFinanceStore.getState().setReportFields(null);
    expect(useFinanceStore.getState().reportFields).toBeNull();
    expect(api.settings.setShared).toHaveBeenLastCalledWith("report_selected_fields", null);
  });
});
