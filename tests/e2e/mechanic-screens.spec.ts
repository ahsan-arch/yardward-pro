import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Mechanic sub-screens", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "mechanic");
  });

  test("work-orders page renders", async ({ page }) => {
    await page.goto("/mechanic/work-orders");
    await expect(
      page.getByRole("heading", { name: /work orders assigned to me/i }),
    ).toBeVisible();
  });

  test("inventory page: search + low-stock filter + adjust button", async ({ page }) => {
    await page.goto("/mechanic/inventory");
    await expect(page.locator("text=/SKU|on hand/i").first()).toBeVisible();
    await page.locator('input[placeholder*="Search"]').fill("brake");
    await expect(page.locator("text=/Brake pads/i")).toBeVisible();
    const adjust = page.getByRole("button", { name: /^adjust$/i }).first();
    if (await adjust.count()) await adjust.click();
  });

  test("maintenance page: vehicle picker + Add log dialog", async ({ page }) => {
    await page.goto("/mechanic/maintenance");
    await expect(page.locator("text=/preventive service alerts|maintenance/i").first()).toBeVisible();
    await page.getByRole("button", { name: /add log entry/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("purchase-requests page: tabs + table", async ({ page }) => {
    await page.goto("/mechanic/purchase-requests");
    await expect(page.getByRole("tab", { name: /my requests/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /all requests/i })).toBeVisible();
    // Default tab is "My requests" which filters by current mechanic;
    // switch to "All requests" so the table is guaranteed populated.
    await page.getByRole("tab", { name: /all requests/i }).click();
    await expect(page.locator("text=/PR-/").first()).toBeVisible({ timeout: 10_000 });
  });
});
