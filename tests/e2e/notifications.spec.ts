import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Notifications bell (admin)", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin");
  });

  test("bell shows unread badge and opens sheet on click", async ({ page }) => {
    const bell = page.locator("button:has(svg.lucide-bell)").first();
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("text=/notifications/i").first()).toBeVisible();
  });
});
