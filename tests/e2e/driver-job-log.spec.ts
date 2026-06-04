import { test, expect } from "@playwright/test";
import { authedAs, awaitGpsSettled } from "./helpers";

test.describe("Driver job log", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver/job-log");
  });

  test("job picker + note render", async ({ page }) => {
    // The job-log form is a "quick note" surface — Job picker + Note textarea.
    // Photos are captured on the Vehicle inspection / Work order routes, not
    // here. Test reflects the actual feature scope.
    await expect(page.locator("text=/^job$/i").first()).toBeVisible();
    await expect(page.locator("text=/^note$/i").first()).toBeVisible();
    await awaitGpsSettled(page);
  });

  test("submit without note shows validation", async ({ page }) => {
    await page.getByRole("button", { name: /save job log/i }).click();
    await expect(page.locator("text=/add a note/i")).toBeVisible({ timeout: 5_000 });
  });
});
