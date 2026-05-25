import { ApiError } from "@/api/client";
import { QueryClient } from "@tanstack/react-query";

/**
 * Shared QueryClient instance.
 *
 * Lives in its own module so non-React code (e.g. Zustand stores)
 * can call `queryClient.invalidateQueries(...)` after an imperative
 * mutation, without having to plumb the client through React context.
 * main.tsx imports the same instance for the provider.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Tree data is keyed by (accountId, dateParam). Refetching is
      // user-driven (date change, refresh button). No background poll.
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      // Retry policy:
      //   - Network errors (ApiError status 0 = "Failed to fetch" /
      //     timeout / TCP reset): retry up to 3 times. These are
      //     transient (mobile blip, worker restart, intermediate
      //     proxy drop) and almost always succeed on retry.
      //   - 4xx (client error): NO retry — the request itself is wrong.
      //   - 5xx (server error): retry once.
      //   - Anything else: retry once.
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.status === 0) return failureCount < 3;
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 1;
      },
      // Exponential backoff with jitter so multiple failing queries
      // don't all retry at the same millisecond. Capped at 5s.
      retryDelay: (attemptIndex) =>
        Math.min(800 * 2 ** attemptIndex + Math.random() * 250, 5000),
      // 5 minutes — long enough that tab-switching between dashboard
      // / analytics / finance / alerts stays instant once data has
      // landed once. The backend cache (60s) acts as the freshness
      // backstop, and the refresh button or a date change always
      // forces a new fetch via invalidateQueries.
      staleTime: 5 * 60_000,
      gcTime: 30 * 60_000,
    },
  },
});
