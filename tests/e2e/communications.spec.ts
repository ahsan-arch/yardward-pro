// Phase 1 (in-app messaging only) coverage for the Communications surface.
//
// We exercise the three routes (admin/driver/mechanic), the new-conversation
// dialog flow on each, the nav entries, and the empty-state rendering. Cross-
// browser-context RLS isolation tests (driver A can't see driver B) are
// deferred to Phase 2 once we wire the test harness to real Supabase auth —
// in mock mode each browser context has its own local store so a cross-
// context test would always pass for the wrong reason.
import { test, expect } from "@playwright/test";
import { authedAs, recordConsoleErrors } from "./helpers";

test.describe("Communications — Phase 1 in-app messaging", () => {
  test("/admin/communications renders + nav entry present + empty state", async ({ page }) => {
    const errors = recordConsoleErrors(page);
    await authedAs(page, "admin");
    await page.goto("/admin/communications");
    await expect(
      page.getByRole("heading", { name: /Communications/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Filter chips visible (default selection is "Tagged me").
    await expect(page.getByTestId("filter-tagged")).toBeVisible();
    await expect(page.getByTestId("filter-joined")).toBeVisible();
    await expect(page.getByTestId("filter-all")).toBeVisible();
    // Empty state when no conversations.
    await expect(page.getByTestId("conversation-list")).toBeVisible();
    // New-conversation button opens dialog.
    await page.getByTestId("open-new-conversation").click();
    await expect(page.getByTestId("new-conv-subject")).toBeVisible();
    expect(errors.filter((e) => !/realtime/i.test(e))).toEqual([]);
  });

  test("admin can switch between filter chips without console error", async ({ page }) => {
    const errors = recordConsoleErrors(page);
    await authedAs(page, "admin");
    await page.goto("/admin/communications");
    await page.getByTestId("filter-joined").click();
    await page.getByTestId("filter-all").click();
    await page.getByTestId("filter-tagged").click();
    expect(errors.filter((e) => !/realtime/i.test(e))).toEqual([]);
  });

  test("/driver/messages renders + empty state + new-conv dialog", async ({ page }) => {
    const errors = recordConsoleErrors(page);
    await authedAs(page, "driver");
    await page.goto("/driver/messages");
    await expect(page.getByRole("heading", { name: /Messages/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("driver-conversation-list")).toBeVisible();
    await page.getByTestId("driver-new-conversation").click();
    await expect(page.getByTestId("driver-new-conv-subject")).toBeVisible();
    expect(errors.filter((e) => !/realtime/i.test(e))).toEqual([]);
  });

  test("/mechanic/messages renders + empty state + new-conv dialog", async ({ page }) => {
    const errors = recordConsoleErrors(page);
    await authedAs(page, "mechanic");
    await page.goto("/mechanic/messages");
    await expect(page.getByRole("heading", { name: /Messages/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("mechanic-conversation-list")).toBeVisible();
    await page.getByTestId("mechanic-new-conversation").click();
    await expect(page.getByTestId("mechanic-new-conv-subject")).toBeVisible();
    expect(errors.filter((e) => !/realtime/i.test(e))).toEqual([]);
  });

  test("driver nav shows Messages tab in bottom bar", async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver");
    // The Messages tab is the 5th of 6 in the bottom nav grid (Home, Jobs,
    // Forms, Tickets, Messages, Profile). Match by label since the button
    // has no explicit testid.
    await expect(page.getByRole("link", { name: /Messages/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("admin sidebar shows Communications nav entry", async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin");
    await expect(page.getByRole("link", { name: /Communications/i }).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("mechanic sidebar shows Messages nav entry", async ({ page }) => {
    await authedAs(page, "mechanic");
    await page.goto("/mechanic");
    await expect(page.getByRole("link", { name: /Messages/i }).first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test("admin role guard: driver bounced from /admin/communications to /driver", async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/admin/communications");
    // Strict role isolation redirects driver away.
    await expect(page).toHaveURL(/\/driver/);
  });

  test("mechanic role guard: driver bounced from /mechanic/messages to /driver", async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/mechanic/messages");
    await expect(page).toHaveURL(/\/driver/);
  });

  test("driver role guard: admin bounced from /driver/messages to /admin", async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/driver/messages");
    await expect(page).toHaveURL(/\/admin/);
  });
});
