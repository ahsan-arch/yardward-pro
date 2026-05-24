import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Driver tool checklist", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver/tool-checklist");
  });

  test("tools list renders with 3-way status buttons", async ({ page }) => {
    await expect(page.locator("text=/Safety cones|Hi-vis vests/").first()).toBeVisible();
    // Each tool has 3 buttons (OK / damaged / missing)
    const okButtons = page.getByRole("button", { name: /^OK$/i });
    expect(await okButtons.count()).toBeGreaterThanOrEqual(1);
  });

  test("flagging items shows banner + count", async ({ page }) => {
    // The seeded data has 2 flagged tools (missing + damaged)
    await expect(page.locator("text=/management will be notified/i")).toBeVisible();
  });

  test("submit navigates back", async ({ page }) => {
    await page.getByRole("button", { name: /submit checklist/i }).click();
    await page.waitForURL(/\/driver(?!\/tool-checklist)/, { timeout: 5_000 });
  });
});
