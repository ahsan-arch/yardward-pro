import { test, expect } from "@playwright/test";
import { authedAs, awaitGpsSettled } from "./helpers";

test.describe("Driver work order form", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver/work-order");
  });

  test("all fields + signature canvas + GPS render", async ({ page }) => {
    await expect(page.getByText("Work performed", { exact: true })).toBeVisible();
    await expect(page.getByText("Load type", { exact: true })).toBeVisible();
    await expect(page.locator("text=/load weight/i")).toBeVisible();
    await expect(page.getByText("Dump site location", { exact: true })).toBeVisible();
    await expect(page.getByText("Foreman signature", { exact: true })).toBeVisible();
    await expect(page.locator("canvas")).toBeVisible();
    await awaitGpsSettled(page);
  });

  test("empty submit shows validation errors", async ({ page }) => {
    await page.getByRole("button", { name: /submit work order/i }).click();
    await expect(page.locator("text=/required|signature required/i").first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("ticket photo upload control is present", async ({ page }) => {
    await expect(page.locator("text=/ticket photo/i")).toBeVisible();
  });
});
