import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin vehicles", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/vehicles");
  });

  test("vehicle cards render", async ({ page }) => {
    await expect(page.locator("text=/TRK-07|TRK-03|TRK-11/").first()).toBeVisible();
  });

  test("vehicle card View details link goes to /admin/vehicles/$id", async ({ page }) => {
    const firstLink = page.getByRole("link", { name: /view details/i }).first();
    await expect(firstLink).toBeVisible();
    await firstLink.click();
    await expect(page).toHaveURL(/\/admin\/vehicles\/[A-Z]+-\d+/);
  });

  test("Fleetio import button is present", async ({ page }) => {
    await expect(page.getByRole("button", { name: /import from fleetio/i })).toBeVisible();
  });

  test("Add vehicle button is present", async ({ page }) => {
    await expect(page.getByRole("button", { name: /add vehicle/i })).toBeVisible();
  });
});
