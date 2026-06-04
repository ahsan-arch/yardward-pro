import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

const REPORTS = [
  /driver hours/i,
  /vehicle utilization/i,
  /job profitability/i,
  /gps mismatches/i,
  /maintenance due/i,
  /tender digest/i,
];

test.describe("Admin reports", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/reports");
  });

  test("all 6 report cards render", async ({ page }) => {
    for (const r of REPORTS) {
      await expect(page.locator("button", { hasText: r }).first()).toBeVisible();
    }
  });

  test("opening a report shows chart or table", async ({ page }) => {
    await page.locator("button", { hasText: /driver hours/i }).first().click();
    // Either a chart container or a table appears
    const chart = page.locator(".recharts-responsive-container, svg, table");
    await expect(chart.first()).toBeVisible({ timeout: 5_000 });
  });

  test("switching between reports works", async ({ page }) => {
    await page.locator("button", { hasText: /maintenance due/i }).first().click();
    // Two "Close" buttons exist (header text-button + dialog X icon). Scope
    // explicitly to the dialog and prefer the first match (the header one).
    const closeBtn = page.getByRole("dialog").getByRole("button", { name: /^close$/i }).first();
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await page.locator("button", { hasText: /tender digest/i }).first().click();
    await expect(
      page.getByRole("dialog").getByRole("button", { name: /^close$/i }).first(),
    ).toBeVisible();
  });
});
