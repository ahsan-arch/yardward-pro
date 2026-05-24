import { test, expect } from "@playwright/test";
import { authedAs, awaitGpsSettled } from "./helpers";

test.describe("Driver end-of-day", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver/end-of-day");
  });

  test("fields + GPS render", async ({ page }) => {
    await expect(page.locator("text=/final odometer/i")).toBeVisible();
    await expect(page.locator("text=/fuel level at end/i")).toBeVisible();
    await expect(page.locator("text=/shift summary/i")).toBeVisible();
    await awaitGpsSettled(page);
  });

  test("validation requires odometer + summary", async ({ page }) => {
    await page.getByRole("button", { name: /submit end-of-day/i }).click();
    await expect(page.locator("text=/enter a valid odometer/i")).toBeVisible({ timeout: 5_000 });
  });

  test("happy path submits + navigates", async ({ page }) => {
    await page.locator('input[inputmode="numeric"]').fill("84800");
    await page.locator("textarea").fill("All jobs complete. No issues.");
    await page.getByRole("button", { name: /submit end-of-day/i }).click();
    await page.waitForURL(/\/driver(?!\/end-of-day)/, { timeout: 5_000 });
  });
});
