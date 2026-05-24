import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin settings", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/settings");
  });

  test("all 6 tabs render and switch", async ({ page }) => {
    for (const name of [
      /organization/i,
      /users & roles/i,
      /integrations/i,
      /driver tokens/i,
      /notifications/i,
      /billing/i,
    ]) {
      const tab = page.getByRole("tab", { name });
      await expect(tab).toBeVisible();
      await tab.click();
    }
  });

  test("Organization tab Save shows toast", async ({ page }) => {
    await page.getByRole("tab", { name: /organization/i }).click();
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page.locator("text=/settings saved/i")).toBeVisible({ timeout: 5_000 });
  });

  test("Integrations tab lists connect/disconnect cards", async ({ page }) => {
    await page.getByRole("tab", { name: /integrations/i }).click();
    await expect(page.locator("text=/Geotab|Twilio|QuickBooks|Fleetio/").first()).toBeVisible();
  });

  test("Notifications tab toggles flip without errors", async ({ page }) => {
    await page.getByRole("tab", { name: /notifications/i }).click();
    const switches = page.getByRole("switch");
    expect(await switches.count()).toBeGreaterThanOrEqual(3);
    await switches.first().click();
  });
});
