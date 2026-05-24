import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe("Tokenized driver link flow (Payment 2 critical)", () => {
  test("admin can generate a token and the dialog shows a copy-able URL", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/settings");
    await page.getByRole("tab", { name: /driver tokens/i }).click();

    // Open generate dialog
    await page.getByTestId("generate-token-btn").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Pick a driver from the scoped select
    await page.getByTestId("token-driver-select").click();
    await page.getByRole("option").first().click();

    // Generate
    await page.getByTestId("token-generate-confirm").click();

    // Result card appears with copy-able URL + actions
    const resultCard = page.getByTestId("token-result-card");
    await expect(resultCard).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("token-copy-btn")).toBeVisible();
    await expect(page.getByTestId("token-open-btn")).toBeVisible();

    const url = await page.getByTestId("token-url-input").inputValue();
    expect(url).toMatch(/\/t\/tok_[a-z0-9]+/);
  });

  test("tokens table lists seeded tokens with their shareable URLs", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/settings");
    await page.getByRole("tab", { name: /driver tokens/i }).click();
    await expect(page.getByText(/\/t\/tok_/).first()).toBeVisible();
  });

  test("driver opens a tokenized URL in fresh context without logging in", async ({
    context,
  }) => {
    // Use a seeded active token (TKN-01: tok_live_a1b2c3, far-future expiry)
    const tokenUrl = "/t/tok_live_a1b2c3";

    // Fresh page with no auth cookies/storage
    const driverPage = await context.newPage();
    await driverPage.addInitScript(() => {
      try {
        localStorage.removeItem("fo:authed");
        localStorage.removeItem("fo:role");
      } catch {
        /* noop */
      }
    });

    await driverPage.goto(tokenUrl);

    // Token landing renders, Continue button visible
    await expect(driverPage.getByRole("button", { name: /continue/i })).toBeVisible({
      timeout: 10_000,
    });

    // Click Continue → routes into /driver without login
    await driverPage.getByRole("button", { name: /continue/i }).click();
    await driverPage.waitForURL(/\/driver/, { timeout: 10_000 });
    await expect(driverPage).toHaveURL(/\/driver/);
  });
});
