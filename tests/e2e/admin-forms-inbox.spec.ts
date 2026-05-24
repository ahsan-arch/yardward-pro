import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin Forms & Submissions inbox", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/forms");
  });

  test("all 5 tabs render", async ({ page }) => {
    for (const name of [/all/i, /tool checklists/i, /work orders/i, /time entries/i, /ticket photos/i, /inspections/i]) {
      await expect(page.getByRole("tab", { name })).toBeVisible();
    }
  });

  test("inbox shows submissions across types", async ({ page }) => {
    await page.waitForLoadState("networkidle");
    const table = page.getByRole("table");
    await expect(table).toBeVisible({ timeout: 10_000 });
    await expect(table.locator("text=/Work order/").first()).toBeVisible();
    await expect(table.locator("text=/Time entry/").first()).toBeVisible();
    // After switching to Inspections tab, inspection rows show
    await page.getByRole("tab", { name: /inspections/i }).click();
    await expect(table.locator("text=/Vehicle inspection/").first()).toBeVisible({ timeout: 5_000 });
  });

  test("search filters by driver/context", async ({ page }) => {
    await page.waitForLoadState("networkidle");
    await page.locator('input[placeholder*="Search"]').fill("JOB-042");
    // Rows with JOB-042 should remain visible
    await expect(page.locator("text=/JOB-042/").first()).toBeVisible({ timeout: 10_000 });
  });

  test("clicking a row opens the detail sheet", async ({ page }) => {
    await page.locator("tbody tr").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
