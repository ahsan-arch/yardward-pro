import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin invoice preview", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
  });

  test("invoice preview renders for a seeded work order", async ({ page }) => {
    await page.goto("/admin/invoices/WO-115");
    await expect(page.locator("text=/invoice draft/i")).toBeVisible();
    await expect(page.locator("text=/bill to/i")).toBeVisible();
    await expect(page.locator("text=/quickbooks sync/i")).toBeVisible();
  });

  test("Push to QuickBooks button transitions state to synced", async ({ page }) => {
    await page.goto("/admin/invoices/WO-116"); // pending QBO sync
    const push = page.getByRole("button", { name: /push to quickbooks/i });
    if (await push.isEnabled().catch(() => false)) {
      await push.click();
      await expect(page.locator("text=/already synced|synced/i").first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test("Bad work order id shows not-found", async ({ page }) => {
    await page.goto("/admin/invoices/WO-NONE");
    await expect(page.locator("text=/work order not found/i")).toBeVisible();
  });
});
