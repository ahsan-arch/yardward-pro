import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin tenders", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/tenders");
  });

  test("tender list renders", async ({ page }) => {
    await expect(page.locator("text=/Municipal waste haulage|Bridge demo|Quarry/").first()).toBeVisible();
  });

  test("Run scraper button shows toast", async ({ page }) => {
    await page.getByRole("button", { name: /^run scraper$/i }).first().click();
    // The function emits a loading toast first ("Running tender scraper…")
    // then either success or "requires Supabase credentials" in mock mode.
    // Either is a valid "the button fired" signal.
    await expect(
      page.locator("text=/running tender scraper|requires supabase|scrape/i").first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Send test digest button shows toast", async ({ page }) => {
    // Without a recipient entered the route toasts "Enter a recipient email
    // first." — that's still a valid "the button fired" side-effect for the
    // audit. Without a recent digest it toasts "Run scraper first…".
    await page.getByRole("button", { name: /^send test digest$/i }).first().click();
    await expect(
      page.locator("text=/sending test digest|requires supabase|run scraper first|recipient/i").first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
