import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin work orders", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/work-orders");
  });

  test("tabs and table render", async ({ page }) => {
    await expect(page.getByRole("tab", { name: /all/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /pending approval/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /approved/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /rejected/i })).toBeVisible();
    await expect(page.locator("text=/WO-/").first()).toBeVisible();
  });

  test("switching to Pending tab filters rows", async ({ page }) => {
    await page.getByRole("tab", { name: /pending approval/i }).click();
    // Only pending should show Approve/Reject buttons
    const approveCount = await page.getByRole("button", { name: /^approve$/i }).count();
    expect(approveCount).toBeGreaterThanOrEqual(1);
  });

  test("approve navigates to invoice preview", async ({ page }) => {
    await page.getByRole("tab", { name: /pending approval/i }).click();
    const approve = page.getByRole("button", { name: /^approve$/i }).first();
    await approve.click();
    await page.waitForURL(/\/admin\/invoices\/WO-/, { timeout: 5_000 });
  });

  test("clicking a row opens the detail sheet", async ({ page }) => {
    await page.locator("tbody tr").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
