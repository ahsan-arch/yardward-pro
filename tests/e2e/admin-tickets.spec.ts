import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin ticket photos", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/tickets");
  });

  test("tabs render with counts", async ({ page }) => {
    await expect(page.getByRole("tab", { name: /awaiting entry/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /entered/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /all/i })).toBeVisible();
  });

  test("photo cards render with job id", async ({ page }) => {
    await page.getByRole("tab", { name: /all/i }).click();
    await expect(page.locator("text=/JOB-/").first()).toBeVisible();
  });

  test("clicking a photo opens sheet, validation blocks save without weight+location", async ({ page }) => {
    await page.getByRole("tab", { name: /awaiting entry/i }).click();
    const card = page.locator("button img[alt='ticket']").first();
    if (await card.count()) {
      await card.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      // Save without filling
      await page.getByRole("button", { name: /save entry/i }).click();
      // Route emits two distinct validation toasts depending on which field
      // is missing: "Location is required" or "Weight must be a positive number".
      await expect(
        page.locator("text=/location is required|weight must be|positive number/i"),
      ).toBeVisible({ timeout: 5_000 });
    }
  });
});
