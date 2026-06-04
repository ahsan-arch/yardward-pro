import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";

// Geolocation is denied by default in playwright.config.ts (permissions: []).
// All driver forms should still surface a "fallback" GPS chip, never a red error.

test.describe("GPS reliability — auto-fallback when geolocation denied", () => {
  const driverForms = [
    "/driver/start-of-day",
    "/driver/tool-checklist",
    "/driver/work-order",
    "/driver/end-of-day",
    "/driver/job-log",
    "/driver/inspection",
  ];

  for (const path of driverForms) {
    test(`${path} shows GPS badge in fallback state, never red error`, async ({ page }) => {
      await loginAs(page, "driver");
      // Pretrip lockout intercepts /driver/start-of-day on a fresh test page.
      // Stamp last-pretrip for all seeded vehicles so the form renders.
      await page.addInitScript(() => {
        const now = new Date().toISOString();
        localStorage.setItem(
          "fo:vehicle-pretrip:v1",
          JSON.stringify({
            "TRK-07": now,
            "TRK-14": now,
            "TRK-22": now,
            "TRA-01": now,
            "TRA-02": now,
            "EQP-03": now,
          }),
        );
      });
      await page.goto(path);

      // Wait for the badge to appear and finish loading
      const badge = page.locator('[data-testid="gps-badge"]').first();
      await expect(badge).toBeVisible({ timeout: 10_000 });

      // Poll until state is either "real" or "fallback" — never "error"
      await expect
        .poll(async () => await badge.getAttribute("data-gps-state"), {
          message: `GPS badge on ${path} should end up in real or fallback state, not error`,
          timeout: 10_000,
        })
        .toMatch(/^(real|fallback)$/);
    });
  }

  test("inspection page Geotab card renders even without real GPS", async ({ page }) => {
    await loginAs(page, "driver");
    await page.goto("/driver/inspection");
    await expect(page.getByTestId("geotab-card")).toBeVisible();
  });
});
