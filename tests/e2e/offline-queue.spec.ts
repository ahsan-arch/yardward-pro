import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Offline form queue", () => {
  test("offline banner displays when navigator.onLine becomes false", async ({
    page,
    context,
  }) => {
    await authedAs(page, "driver");
    await page.goto("/driver");
    // Wait for app to be settled
    await page.waitForLoadState("networkidle");
    // Flip to offline
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.locator("text=/offline/i").first()).toBeVisible({ timeout: 5_000 });
    await context.setOffline(false);
  });

  test("submitting a driver form while offline still completes (queues + navigates)", async ({
    page,
    context,
  }) => {
    await authedAs(page, "driver");
    // Bypass the pretrip lockout — same pattern as driver-start-of-day.spec.ts.
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
    await page.goto("/driver/start-of-day");
    await page.locator("text=/odometer reading at start/i").waitFor();
    await page.locator('input[inputmode="numeric"]').fill("84500");

    // Go offline + wait for banner so React state has propagated
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.locator("text=/offline/i").first()).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /submit start-of-day/i }).click();

    // The submit handler should still call nav() even when offline (queued),
    // so the URL changes back to /driver.
    await page.waitForURL((url) => !url.pathname.includes("/start-of-day"), { timeout: 8_000 });

    await context.setOffline(false);
  });
});
