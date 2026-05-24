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

  test("Run now button shows toast", async ({ page }) => {
    await page.getByRole("button", { name: /run now/i }).click();
    await expect(page.locator("text=/manual scrape triggered/i")).toBeVisible({ timeout: 5_000 });
  });

  test("Send digest now button shows toast", async ({ page }) => {
    await page.getByRole("button", { name: /send digest now/i }).click();
    await expect(page.locator("text=/digest sent/i")).toBeVisible({ timeout: 5_000 });
  });
});
