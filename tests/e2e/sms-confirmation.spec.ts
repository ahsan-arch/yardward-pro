import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe("SMS delivery confirmation (Payment 2 critical)", () => {
  test("creating a job dispatches an SMS and toast links to the log", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/schedule");

    // Open the create-job dialog
    await page.getByTestId("open-create-job").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // All three select dropdowns live inside the dialog
    const combos = dialog.locator('[role="combobox"]');

    // Client (1st combobox in dialog)
    await combos.nth(0).click();
    await page.getByRole("option").first().click();

    // Date + time + address
    await dialog.locator('input[type="date"]').fill("2026-06-15");
    await dialog.locator('input[type="time"]').fill("08:00");
    await dialog.locator('input[placeholder*="14 River"]').fill("123 Test Ave");

    // Driver (2nd) + truck (3rd)
    await combos.nth(1).click();
    await page.getByRole("option").first().click();
    await combos.nth(2).click();
    await page.getByRole("option").first().click();

    // Submit
    await page.getByTestId("submit-create-job").click();

    // Toast appears with "View SMS log" action
    const viewLogAction = page.getByRole("button", { name: /view sms log/i });
    await expect(viewLogAction).toBeVisible({ timeout: 10_000 });

    // Click the action
    await viewLogAction.click();
    await page.waitForURL(/\/admin\/sms-log/, { timeout: 5_000 });

    // SMS log table is visible and the most recent row has the Live badge
    await expect(page.getByTestId("sms-log-table")).toBeVisible();
    const firstRow = page.getByTestId("sms-log-row").first();
    await expect(firstRow).toBeVisible();
    await expect(firstRow.getByTestId("sms-live-badge")).toBeVisible();
  });

  test("SMS log is accessible from sidebar nav", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin");
    await page.getByRole("link", { name: /sms log/i }).first().click();
    await page.waitForURL(/\/admin\/sms-log/);
    await expect(page.getByTestId("sms-log-table")).toBeVisible();
  });
});
