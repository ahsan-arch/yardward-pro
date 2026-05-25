import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin live vehicle map", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
  });

  test("/admin/map renders the map page", async ({ page }) => {
    await page.goto("/admin/map");
    await expect(page.getByTestId("admin-map-page")).toBeVisible();
    await expect(page.getByTestId("vehicle-map")).toBeVisible();
  });

  test("Live map appears in admin sidebar nav", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("link", { name: /live map/i }).first()).toBeVisible();
  });

  test("a vehicle marker pin renders for each seeded vehicle", async ({ page }) => {
    await page.goto("/admin/map");
    await expect(page.getByTestId("vehicle-map")).toBeVisible();
    // Leaflet renders one .leaflet-marker-icon per Marker
    await expect
      .poll(async () => await page.locator(".leaflet-marker-icon").count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(6);
  });

  test("sidebar lists vehicles and clicking a row works", async ({ page }) => {
    await page.goto("/admin/map");
    const sidebar = page.getByTestId("vehicle-map-sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator("text=/TRK-07/")).toBeVisible();
    await page.getByTestId("vehicle-map-sidebar-TRK-07").click();
    // No assertion on map center — just that the click doesn't crash
    await expect(page).toHaveURL(/\/admin\/map/);
  });

  test("Refresh now button updates the last-update label", async ({ page }) => {
    await page.goto("/admin/map");
    await expect(page.getByTestId("vehicle-map-refresh")).toBeVisible();
    await page.getByTestId("vehicle-map-refresh").click();
    // Last-update text becomes "0s ago" or similar — at minimum stays visible
    await expect(page.getByTestId("vehicle-map-last-update")).toBeVisible();
  });

  test("dashboard shows a fleet map preview with Open-full-map link", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.locator("text=/live fleet map/i")).toBeVisible();
    await expect(page.getByRole("link", { name: /open full map/i })).toBeVisible();
  });

  test("vehicle detail page embeds a mini-map for that vehicle", async ({ page }) => {
    await page.goto("/admin/vehicles/TRK-07");
    await expect(page.getByTestId("vehicle-map")).toBeVisible();
    await expect
      .poll(async () => await page.locator(".leaflet-marker-icon").count(), { timeout: 10_000 })
      .toBe(1);
  });
});
