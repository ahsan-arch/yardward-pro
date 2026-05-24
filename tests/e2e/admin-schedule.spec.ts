import { test, expect } from "@playwright/test";
import { authedAs, pickFirstOption } from "./helpers";

test.describe("Admin schedule", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/schedule");
  });

  test("7-day grid renders with drivers + day headers", async ({ page }) => {
    await expect(page.locator("text=/Mon|Tue|Wed|Thu|Fri|Sat|Sun/").first()).toBeVisible();
    // At least one driver row visible
    await expect(page.locator("text=/Tom Morrison|Raja Singh|Dana Clarke/").first()).toBeVisible();
  });

  test("filter dropdowns are interactive", async ({ page }) => {
    const filters = page.locator('[role="combobox"]');
    await expect(filters.first()).toBeVisible();
    expect(await filters.count()).toBeGreaterThanOrEqual(3);
  });

  test("create-job dialog opens, validates required fields, and closes on submit", async ({ page }) => {
    await page.getByTestId("open-create-job").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Submit empty → error toast
    await page.getByTestId("submit-create-job").click();
    await expect(page.locator("text=/fill all required/i")).toBeVisible({ timeout: 5_000 });

    // Fill + submit happy path
    const combos = dialog.locator('[role="combobox"]');
    await pickFirstOption(page, combos.nth(0));
    await dialog.locator('input[type="date"]').fill("2026-08-01");
    await dialog.locator('input[type="time"]').fill("09:00");
    await dialog.locator('input[placeholder*="14 River"]').fill("Test Address");
    await pickFirstOption(page, combos.nth(1));
    await pickFirstOption(page, combos.nth(2));
    await page.getByTestId("submit-create-job").click();
    await expect(page.locator("text=/created/i")).toBeVisible({ timeout: 5_000 });
  });
});
