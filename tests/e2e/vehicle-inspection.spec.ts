import { test, expect } from "@playwright/test";
import { loginAs, assertGpsBadgeNeverErrors } from "./helpers";

test.describe("Vehicle inspection (Payment 2 critical)", () => {
  test("/driver/inspection is live and submits with GPS + Geotab cross-reference", async ({
    page,
  }) => {
    await loginAs(page, "driver");
    await page.goto("/driver/inspection");

    // Page renders (was 404 before)
    await expect(page.getByTestId("driver-inspection-page")).toBeVisible();
    await expect(page.getByRole("heading", { name: /vehicle inspection/i })).toBeVisible();

    // GPS badge appears and either captures real GPS or falls back — never the red error
    await assertGpsBadgeNeverErrors(page);

    // Geotab cross-reference card renders
    const geotabCard = page.getByTestId("geotab-card");
    await expect(geotabCard).toBeVisible();

    // Checklist is rendered
    const items = page.getByTestId("inspection-checklist").locator("[data-testid^='inspection-item-']");
    await expect(items.first()).toBeVisible();

    // Submit clean inspection
    await page.getByTestId("inspection-submit").click();

    // Sonner toast appears (or page navigates back to /driver)
    await page.waitForURL(/\/driver(?!\/inspection)/, { timeout: 5_000 });
  });

  test("seeded inspections appear in admin Forms inbox under Inspections tab", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/forms");
    await page.getByRole("tab", { name: /inspections/i }).click();
    // Seeded mockData has at least 3 inspections (INS-001 / INS-002 / INS-003)
    await expect(page.getByText(/vehicle inspection/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("flagging an item requires a note", async ({ page }) => {
    await loginAs(page, "driver");
    await page.goto("/driver/inspection");

    // Click the "issue" button on first checklist item
    const firstItem = page.getByTestId("inspection-item-0");
    await firstItem.getByRole("button", { name: /issue/i }).click();

    // Submit without filling notes
    await page.getByTestId("inspection-submit").click();

    // Should NOT navigate away (validation should block)
    await expect(page).toHaveURL(/\/driver\/inspection/);
  });
});
