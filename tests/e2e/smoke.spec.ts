import { test, expect } from "@playwright/test";
import { recordConsoleErrors } from "./helpers";

const ROUTES = [
  "/login",
  "/admin",
  "/admin/schedule",
  "/admin/jobs",
  "/admin/drivers",
  "/admin/vehicles",
  "/admin/vehicles/TRK-07",
  "/admin/map",
  "/admin/work-orders",
  "/admin/timesheets",
  "/admin/sms-log",
  "/admin/purchase-requests",
  "/admin/clients",
  "/admin/forms",
  "/admin/reports",
  "/admin/tickets",
  "/admin/tenders",
  "/admin/invoices/WO-115",
  "/admin/settings",
  "/driver",
  "/driver/jobs",
  "/driver/forms",
  "/driver/profile",
  "/driver/start-of-day",
  "/driver/tool-checklist",
  "/driver/work-order",
  "/driver/end-of-day",
  "/driver/job-log",
  "/driver/inspection",
  "/mechanic",
  "/mechanic/work-orders",
  "/mechanic/inventory",
  "/mechanic/maintenance",
  "/mechanic/purchase-requests",
  "/t/tok_live_a1b2c3",
];

test.describe("smoke", () => {
  // localStorage flips auth before each visit so guarded routes render
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("fo:authed", "1");
      localStorage.setItem("fo:role", "admin");
    });
  });

  test("every route renders without console errors", async ({ page }) => {
    test.setTimeout(180_000);
    const errors = recordConsoleErrors(page);
    const failures: string[] = [];

    for (const route of ROUTES) {
      try {
        const resp = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 10_000 });
        expect.soft(resp?.status(), `${route} should return < 400`).toBeLessThan(400);
      } catch (err) {
        failures.push(`${route}: ${(err as Error).message}`);
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
    expect(errors, "Console errors detected:\n" + errors.join("\n")).toEqual([]);
  });

  test("manifest.webmanifest is served", async ({ page }) => {
    const resp = await page.goto("/manifest.webmanifest");
    expect(resp?.status()).toBe(200);
    const body = await resp?.text();
    expect(body).toContain("FleetOps");
  });

  test("/driver/inspection is no longer a 404", async ({ page }) => {
    const resp = await page.goto("/driver/inspection");
    expect(resp?.status()).toBeLessThan(400);
    await expect(page.locator('[data-testid="driver-inspection-page"]')).toBeVisible();
  });
});
