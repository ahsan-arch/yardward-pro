import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin vehicle detail", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/vehicles/TRK-07");
  });

  test("renders profile, Geotab card, maintenance + fuel logs", async ({ page }) => {
    await expect(page.locator("text=/Profile/").first()).toBeVisible();
    await expect(page.locator("text=/Geotab telematics/i")).toBeVisible();
    await expect(page.locator("text=/Maintenance log/i")).toBeVisible();
    await expect(page.locator("text=/Fuel log/i")).toBeVisible();
  });

  test("Refresh location button works", async ({ page }) => {
    const refresh = page.getByRole("button", { name: /refresh location/i });
    await expect(refresh).toBeVisible({ timeout: 10_000 });
    await refresh.click();
    await expect(page.locator("text=/refreshed from geotab/i")).toBeVisible({ timeout: 8_000 });
  });

  test("non-existent vehicle id shows not-found state", async ({ page }) => {
    await page.goto("/admin/vehicles/NOPE-999", { waitUntil: "networkidle" });
    await expect(page.locator("text=/vehicle not found/i")).toBeVisible({ timeout: 10_000 });
  });
});
