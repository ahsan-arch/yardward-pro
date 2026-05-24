import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin purchase requests", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/purchase-requests");
  });

  test("tabs + table render with PR rows", async ({ page }) => {
    await expect(page.getByRole("tab", { name: /pending/i })).toBeVisible();
    await expect(page.locator("text=/PR-/").first()).toBeVisible();
  });

  test("clicking a row opens detail sheet with inventory check + actions", async ({
    page,
  }) => {
    await page.locator("tbody tr").first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("text=/inventory check/i")).toBeVisible({ timeout: 5_000 });
    await expect(dialog.locator("text=/urgency/i")).toBeVisible({ timeout: 5_000 });
  });

  test("approve action on pending PR shows toast", async ({ page }) => {
    await page.getByRole("tab", { name: /pending/i }).click();
    const approve = page.locator('button:has(svg.lucide-check)').first();
    if (await approve.count()) {
      await approve.click();
      await expect(page.locator("text=/approved/i").first()).toBeVisible({ timeout: 5_000 });
    }
  });
});
