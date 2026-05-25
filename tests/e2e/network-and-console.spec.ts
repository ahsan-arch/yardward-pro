import { test, expect } from "@playwright/test";
import { authedAs, recordConsoleErrors, recordNetworkErrors } from "./helpers";

const SAMPLE_ROUTES = [
  "/login",
  "/admin",
  "/admin/schedule",
  "/admin/clients",
  "/admin/forms",
  "/admin/reports",
  "/admin/settings",
  "/admin/sms-log",
  "/admin/purchase-requests",
  "/admin/tickets",
  "/admin/tenders",
  "/admin/invoices/WO-115",
  "/admin/vehicles/TRK-07",
  "/admin/map",
  "/driver",
  "/driver/jobs",
  "/driver/forms",
  "/driver/profile",
  "/driver/inspection",
  "/mechanic",
  "/mechanic/inventory",
  "/mechanic/maintenance",
  "/mechanic/work-orders",
  "/mechanic/purchase-requests",
];

test.describe("Global hygiene", () => {
  test("no console errors and no 5xx responses across key routes", async ({ page }) => {
    test.setTimeout(180_000);
    await authedAs(page, "admin");
    const consoleErrors = recordConsoleErrors(page);
    const networkErrors = recordNetworkErrors(page);

    for (const route of SAMPLE_ROUTES) {
      await page.goto(route, { waitUntil: "domcontentloaded" }).catch(() => {});
    }

    // 5xx is unacceptable; 4xx other than 404 should be flagged
    const fatal = networkErrors.filter((e) => /^5\d\d /.test(e));
    expect(fatal, "Server errors:\n" + fatal.join("\n")).toEqual([]);
    expect(consoleErrors, "Console errors:\n" + consoleErrors.join("\n")).toEqual([]);
  });
});
