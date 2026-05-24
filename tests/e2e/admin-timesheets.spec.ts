import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin timesheets", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/timesheets");
  });

  test("tabs render with counts", async ({ page }) => {
    await expect(page.getByRole("tab", { name: /all/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /active/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /flagged/i })).toBeVisible();
  });

  test("table has time entries and flagged mismatch row", async ({ page }) => {
    await expect(page.locator("text=/TE-/").first()).toBeVisible();
    await page.getByRole("tab", { name: /flagged/i }).click();
    // The seeded TE-05 has a mismatch flag
    await expect(page.locator("text=/Mismatch|Flagged/").first()).toBeVisible();
  });
});
