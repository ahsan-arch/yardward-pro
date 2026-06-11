import { test, expect } from "@playwright/test";
import { loginAs, recordConsoleErrors } from "./helpers";

test.describe("New driver features (forms hub, hauling record, custom forms, nav, clock gate)", () => {
  test("forms hub lists Hauling record and Work order tiles; Hauling record navigates to dump-log", async ({
    page,
  }) => {
    await loginAs(page, "driver");
    await page.goto("/driver/forms");

    await expect(page.getByRole("heading", { name: /^forms$/i })).toBeVisible({
      timeout: 10_000,
    });

    // Tiles are links whose accessible name includes label + description
    const haulingTile = page.getByRole("link", { name: /hauling record/i }).first();
    const workOrderTile = page.getByRole("link", { name: /work order/i }).first();
    await expect(haulingTile).toBeVisible({ timeout: 10_000 });
    await expect(workOrderTile).toBeVisible({ timeout: 10_000 });

    // Hauling record tile routes to the dump-log form
    await haulingTile.click();
    await page.waitForURL(/\/driver\/dump-log/, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: /hauling record/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("dump-log renders with GPS badge and empty submit shows required-field errors", async ({
    page,
  }) => {
    const errors = recordConsoleErrors(page);
    await loginAs(page, "driver");
    await page.goto("/driver/dump-log");

    await expect(page.getByRole("heading", { name: /hauling record/i })).toBeVisible({
      timeout: 10_000,
    });

    // GPS badge renders and settles — geolocation is denied in tests so we
    // never expect "real"; fallback (job site) or error (no fallback) are fine.
    const badge = page.locator('[data-testid="gps-badge"]').first();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(async () => await badge.getAttribute("data-gps-state"), { timeout: 12_000 })
      .toMatch(/^(real|fallback|error)$/);

    // Submit with nothing filled — all three validation messages appear
    await page.getByTestId("submit-dump-log").click();
    await expect(page.getByText(/pick a load type/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/where was the load picked up\?/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/enter a weight or quantity/i).first()).toBeVisible({
      timeout: 10_000,
    });

    expect(errors).toEqual([]);
  });

  test("dump-log submit succeeds with mock api, shows success toast and returns to /driver", async ({
    page,
  }) => {
    await loginAs(page, "driver");
    await page.goto("/driver/dump-log");
    await expect(page.getByTestId("dump-load-type")).toBeVisible({ timeout: 10_000 });

    // Load type (shadcn Select)
    await page.getByTestId("dump-load-type").click();
    await page.getByRole("option", { name: "Liquid soil" }).click();

    // Quantity + loading location
    await page.getByTestId("dump-quantity").fill("8 m3");
    await page.getByTestId("dump-location").fill("123 Test St");

    await page.getByTestId("submit-dump-log").click();

    // Mock submitDumpLog resolves instantly — success toast then nav home
    await expect(page.getByText(/hauling record saved/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForURL((url) => url.pathname === "/driver" || url.pathname === "/driver/", {
      timeout: 10_000,
    });
  });

  test("custom form with unknown template id shows the not-available message", async ({
    page,
  }) => {
    await loginAs(page, "driver");
    await page.goto("/driver/custom-form/FT-DOES-NOT-EXIST");

    // Mock fetchFormTemplates returns [] so every id resolves to not-found
    await expect(page.getByText(/no longer available/i).first()).toBeVisible({
      timeout: 10_000,
    });
    // Back link returns to the forms hub
    await expect(page.getByRole("link", { name: /back/i }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("driver bottom nav renders all six tabs", async ({ page }) => {
    await loginAs(page, "driver");
    await page.goto("/driver");

    // Scope to the bottom tab bar (the nav element containing "My Jobs")
    const bottomNav = page.locator("nav").filter({ hasText: "My Jobs" }).first();
    await expect(bottomNav).toBeVisible({ timeout: 10_000 });

    for (const label of ["Home", "My Jobs", "Forms", "Tickets", "Messages", "Profile"]) {
      await expect(
        bottomNav.getByRole("link", { name: label, exact: true }),
      ).toBeVisible({ timeout: 10_000 });
    }
  });

  test("clock sheet enforces the tool-checklist gate (or odometer requirement when satisfied)", async ({
    page,
  }) => {
    await loginAs(page, "driver");
    await page.goto("/driver");

    // Header clock pill — label depends on whether the seed has an open shift
    const headerClock = page
      .getByRole("button", { name: /^clock (in|out)$/i })
      .first();
    await expect(headerClock).toBeVisible({ timeout: 10_000 });
    const headerLabel = (await headerClock.innerText()).trim();
    const clockingIn = /clock in/i.test(headerLabel);

    // Open the bottom sheet
    await headerClock.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible({ timeout: 10_000 });

    // Confirm button keeps a stable accessible name even while locked
    const confirm = sheet.getByRole("button", { name: /confirm clock (in|out)/i });
    await expect(confirm).toBeVisible({ timeout: 10_000 });

    const gate = page.getByTestId("clock-gate");
    if (await gate.isVisible()) {
      // Gate path: checklist not yet submitted — alert copy + locked confirm
      await expect(gate).toContainText(/complete the (start|end)-of-shift tool check/i);
      await expect(confirm).toBeDisabled();
      await expect(
        sheet.getByRole("button", { name: /open tool checklist/i }),
      ).toBeVisible({ timeout: 10_000 });
    } else if (clockingIn) {
      // Seed already satisfies the checklist — clock-in still requires odometer
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(page.getByText(/enter odometer reading/i).first()).toBeVisible({
        timeout: 10_000,
      });
    } else {
      // Open shift with a satisfied end-of-shift checklist: do not actually
      // clock out (would mutate shared mock state) — assert the sheet is
      // ready: odometer field present and confirm enabled.
      await expect(confirm).toBeEnabled();
      await expect(sheet.getByText(/odometer reading/i).first()).toBeVisible({
        timeout: 10_000,
      });
    }
  });
});
