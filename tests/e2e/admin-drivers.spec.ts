import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin drivers", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/drivers");
  });

  test("driver cards render with names + license", async ({ page }) => {
    await expect(page.locator("text=/Tom Morrison/")).toBeVisible();
    await expect(page.locator("text=/Raja Singh/")).toBeVisible();
    // After the Phase 2 refactor the subtitle reads "License DL-01" (no
    // colon) — matches either pattern so future copy tweaks don't break this.
    await expect(page.locator("text=/license[: ]/i").first()).toBeVisible();
  });

  test("Add driver button is present", async ({ page }) => {
    await expect(page.getByRole("button", { name: /add driver/i })).toBeVisible();
  });
});
