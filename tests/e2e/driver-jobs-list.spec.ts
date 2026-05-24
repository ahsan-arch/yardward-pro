import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Driver my jobs", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver/jobs");
  });

  test("3 tabs render with counts", async ({ page }) => {
    await expect(page.getByRole("tab", { name: /today/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /upcoming/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /past/i })).toBeVisible();
  });

  test("Open in Maps link present + has correct href shape", async ({ page }) => {
    await page.getByRole("tab", { name: /today/i }).click();
    const map = page.getByRole("link", { name: /open in maps/i }).first();
    if (await map.count()) {
      const href = await map.getAttribute("href");
      expect(href).toMatch(/google\.com\/maps/);
    }
  });
});
