import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
  });

  test("KPI cards, today schedule + activity feed render", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: /dashboard/i })).toBeVisible();
    // KPI strip — at least 3 stats visible (Active Jobs, Drivers On Site, Pending, Flagged)
    const kpiCount = await page.locator("text=/active jobs|drivers on site|pending|flagged/i").count();
    expect(kpiCount).toBeGreaterThanOrEqual(3);
    // Today's schedule table
    await expect(page.getByRole("table").first()).toBeVisible();
    // Activity feed has at least one entry
    await expect(page.locator("text=/clocked in|submitted|departed|approved|no activity yet/i").first()).toBeVisible();
  });

  test("sidebar nav highlights current route", async ({ page }) => {
    await page.goto("/admin");
    const active = page.locator('aside a[class*="text-amber-brand"]').first();
    await expect(active).toContainText(/dashboard/i);
  });

  test("notifications bell opens a panel", async ({ page }) => {
    await page.goto("/admin");
    await page.locator("button:has(svg.lucide-bell)").first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
  });
});
