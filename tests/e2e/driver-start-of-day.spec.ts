import { test, expect } from "@playwright/test";
import { authedAs, awaitGpsSettled } from "./helpers";

test.describe("Driver start-of-day", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    // Bypass the pretrip lockout by pre-stamping all seeded vehicles' last
    // passing inspection time to now. Without this the test page-load hits
    // the lockout banner instead of the form (DataContext rehydrates the
    // stamp from this key on mount).
    await page.addInitScript(() => {
      const now = new Date().toISOString();
      const stamps = {
        "TRK-07": now,
        "TRK-14": now,
        "TRK-22": now,
        "TRA-01": now,
        "TRA-02": now,
        "EQP-03": now,
      };
      localStorage.setItem("fo:vehicle-pretrip:v1", JSON.stringify(stamps));
    });
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
