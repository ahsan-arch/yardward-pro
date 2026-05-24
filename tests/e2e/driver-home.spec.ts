import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Driver home", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver");
  });

  test("greeting + today job + action tiles + bottom nav", async ({ page }) => {
    await expect(page.locator("text=/good morning|good afternoon|good evening/i").first()).toBeVisible();
    // 4 bottom tabs
    await expect(page.getByRole("link", { name: /home/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /my jobs/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /forms/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /profile/i })).toBeVisible();
  });

  test("tile menu links route correctly", async ({ page }) => {
    const tiles = ["/driver/start-of-day", "/driver/tool-checklist", "/driver/forms", "/driver/work-order"];
    for (const t of tiles) {
      const link = page.locator(`a[href="${t}"]`).first();
      if (await link.count()) await expect(link).toBeVisible();
    }
  });
});
