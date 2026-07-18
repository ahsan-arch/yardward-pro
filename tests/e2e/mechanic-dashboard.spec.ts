import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Mechanic dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "mechanic");
    await page.goto("/mechanic");
  });

  test("welcome card + KPI tiles + active work orders render", async ({ page }) => {
    await expect(page.locator("text=/Welcome back, /i")).toBeVisible();
    await expect(page.locator("text=/active work orders/i").first()).toBeVisible();
    await expect(page.getByTestId("stat-my-active-work-orders")).toBeVisible();
    await expect(page.getByTestId("stat-my-pos-pending-approval")).toBeVisible();
    await expect(page.getByTestId("stat-open-work-orders-workshop")).toBeVisible();
    await expect(page.getByTestId("stat-parts-at-below-reorder-point")).toBeVisible();
  });

  test("PO approval status and restock panels render", async ({ page }) => {
    await expect(page.locator("text=/PO approval status/i")).toBeVisible();
    await expect(page.locator("text=/Parts needing restock/i")).toBeVisible();
  });
});

test.describe("Mechanic purchase request form", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "mechanic");
    await page.goto("/mechanic/purchase-requests");
    await page.getByRole("button", { name: /new request/i }).click();
    await expect(page.locator("text=/^New purchase request$/i")).toBeVisible();
  });

  test("PO form submit blocks when required fields empty", async ({ page }) => {
    await page.getByRole("button", { name: /submit for approval/i }).click();
    // Browser native validation OR the toast — either way the form shouldn't submit
    const stillThere = await page.locator("text=/^New purchase request$/i").isVisible();
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
