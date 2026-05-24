import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Driver forms hub", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver/forms");
  });

  test("all 5 tiles + recent submissions render", async ({ page }) => {
    for (const tile of [
      /start of day/i,
      /tool checklist/i,
      /vehicle inspection/i,
      /job log/i,
      /dump \/ load/i,
      /end of day/i,
    ]) {
      await expect(page.locator("a", { hasText: tile }).first()).toBeVisible();
    }
    await expect(page.locator("text=/recent submissions/i")).toBeVisible();
  });

  test("tiles route correctly", async ({ page }) => {
    await page.locator("a", { hasText: /vehicle inspection/i }).first().click();
    await page.waitForURL(/\/driver\/inspection/);
  });
});
