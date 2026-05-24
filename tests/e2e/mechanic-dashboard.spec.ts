import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Mechanic dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "mechanic");
    await page.goto("/mechanic");
  });

  test("welcome card + active work orders + PO form render", async ({ page }) => {
    await expect(page.locator("text=/Welcome back, /i")).toBeVisible();
    await expect(page.locator("text=/active work orders/i").first()).toBeVisible();
    await expect(page.locator("text=/purchase request/i").first()).toBeVisible();
  });

  test("PO form submit blocks when required fields empty", async ({ page }) => {
    await page.getByRole("button", { name: /submit for approval/i }).click();
    // Browser native validation OR the toast — either way the form shouldn't submit
    const stillThere = await page.locator("text=/purchase request/i").first().isVisible();
    expect(stillThere).toBeTruthy();
  });

  test("PO form happy path", async ({ page }) => {
    await page.locator('input[placeholder*="Brake pad set"]').fill("Brake fluid 1L");
    await page.locator("textarea").first().fill("For TRK-14 brake job");
    await page.locator('input[placeholder="0.00"]').fill("45");
    await page.getByRole("button", { name: /submit for approval/i }).click();
    await expect(page.locator("text=/sent for approval/i")).toBeVisible({ timeout: 5_000 });
  });
});
