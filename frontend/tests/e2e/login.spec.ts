import { test, expect } from "@playwright/test";

/**
 * Login page smoke test.
 *
 * Intercepts the FB SDK script load to prevent outbound network calls
 * to facebook.net during CI, and asserts that the LoginView renders
 * its core elements: the luredash brand title on both panels and
 * either the spinner (auth checking) or the login button (unauth).
 *
 * This is a DETERMINISTIC smoke test — it runs without needing a real
 * FB account, and it cements the expected initial UI for any future
 * visual regression checks.
 */

test.describe("Login view", () => {
  test.beforeEach(async ({ context }) => {
    // Block the FB SDK script so CI never talks to facebook.net.
    // The component has a 6-second fallback that advances to `unauth`
    // state if the SDK never loads, so we don't need to stub anything.
    await context.route("**/connect.facebook.net/**", (route) => route.abort());
  });

  test("renders the split-panel brand layout", async ({ page }) => {
    await page.goto("/");
    // Both panels contain luredash — 2 matches expected
    const luredash = page.getByText(/luredash/);
    await expect(luredash).toHaveCount(2);
    // Tagline on the right card
    await expect(page.getByText("廣告管理平台")).toBeVisible();
  });

  test("advances to the unauth state within the 6s fallback", async ({ page }) => {
    await page.goto("/");
    // Give the 6-second fallback time to fire
    const loginBtn = page.getByRole("button", { name: /Facebook 帳號登入/ });
    await expect(loginBtn).toBeVisible({ timeout: 10_000 });
  });
});
