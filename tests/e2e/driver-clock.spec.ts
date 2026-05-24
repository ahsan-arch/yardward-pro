import { test, expect } from "@playwright/test";
import { authedAs, awaitGpsSettled } from "./helpers";

test.describe("Driver clock-in / clock-out", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver");
  });

  test("Clock in button opens sheet with GPS badge and odometer input", async ({ page }) => {
    await page.getByRole("button", { name: /clock in|clock out/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await awaitGpsSettled(page);
    const odo = page.locator('input[inputmode="numeric"]');
    await expect(odo.first()).toBeVisible();
  });

  test("Submit without odometer when clocking in shows error", async ({ page }) => {
    const btn = page.getByRole("button", { name: /^clock in$/i }).first();
    // If already clocked out, find clock-in button
    if (await btn.count()) {
      await btn.click();
      await page.getByRole("button", { name: /confirm clock in/i }).click();
      await expect(page.locator("text=/enter odometer/i")).toBeVisible({ timeout: 5_000 });
    }
  });
});
