import { test, expect } from "@playwright/test";
import { authedAs, awaitGpsSettled } from "./helpers";

test.describe("Driver start-of-day", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver/start-of-day");
  });

  test("renders all fields", async ({ page }) => {
    await expect(page.locator("text=/odometer reading at start/i")).toBeVisible();
    await expect(page.locator("text=/fuel level/i")).toBeVisible();
    await expect(page.locator("text=/vehicle condition/i")).toBeVisible();
    await awaitGpsSettled(page);
  });

  test("submitting empty form shows validation", async ({ page }) => {
    await page.getByRole("button", { name: /submit start-of-day form/i }).click();
    await expect(page.locator("text=/enter a valid odometer/i")).toBeVisible({ timeout: 5_000 });
  });

  test("happy path submits and navigates back", async ({ page }) => {
    await page.locator('input[inputmode="numeric"]').fill("84500");
    await page.getByRole("button", { name: /submit start-of-day form/i }).click();
    await page.waitForURL(/\/driver(?!\/start-of-day)/, { timeout: 5_000 });
  });
});
