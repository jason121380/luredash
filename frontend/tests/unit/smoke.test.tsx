import { App } from "@/App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// <App/> mounts <FbAuthProvider> which uses `useQueryClient()` to
// prime the backend token exchange. Tests have to wrap in a
// QueryClientProvider or the hook throws. We disable retry/gcTime so
// the test environment doesn't keep background promises alive.
function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App scaffold", () => {
  it("renders the LoginView while FB SDK is loading (checking state)", () => {
    renderApp();
    // Both the dark brand panel AND the right login card say luredash,
    // so use getAllByText and assert on the count.
    const headings = screen.getAllByText(/luredash/i);
    expect(headings.length).toBeGreaterThanOrEqual(2);
    // Tagline renders only in the auth-checking state
    expect(screen.getByText(/廣告管理平台/)).toBeInTheDocument();
  });
});
