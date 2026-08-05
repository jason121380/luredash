import { api } from "@/api/client";
import { useMultiAccountOverview } from "@/api/hooks/useMultiAccountOverview";
import type { DateConfig } from "@/lib/datePicker";
import type { FbAccount } from "@/types/fb";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/auth/FbAuthProvider", () => ({
  useFbAuth: () => ({ status: "auth" }),
}));

vi.mock("@/api/client", () => ({
  api: {
    overview: {
      batch: vi.fn(async () => ({ data: {} })),
    },
  },
}));

const SNAPSHOT_KEY = "fb-overview-snapshot";
const localStorageData = new Map<string, string>();

Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (key: string) => localStorageData.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageData.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageData.delete(key);
    },
    clear: () => {
      localStorageData.clear();
    },
  },
  configurable: true,
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useMultiAccountOverview", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it("uses a fresh local snapshot without starting a full overview refetch", async () => {
    const accounts = [{ id: "act_1", name: "Account 1" }] as FbAccount[];
    const date = { preset: "last_30d", from: null, to: null } as DateConfig;
    window.localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        hash: "act_1|last_30d|||0",
        savedAt: Date.now(),
        data: {
          data: {
            act_1: {
              campaigns: [],
              insights: { spend: "123" },
              error: null,
            },
          },
        },
      }),
    );

    renderHook(() => useMultiAccountOverview(accounts, date), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.overview.batch).not.toHaveBeenCalled();
  });
});
