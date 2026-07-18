import { test, expect, type Page } from "@playwright/test";
import { loginAs, recordConsoleErrors } from "./helpers";

// Mechanic nav as declared in src/components/layout/MechanicLayout.tsx.
// MechanicShell renders the title prop as the header <h1>.
const MECHANIC_ROUTES: { path: string; heading: RegExp; hasTable: boolean }[] = [
  { path: "/mechanic", heading: /^workshop dashboard$/i, hasTable: false },
  { path: "/mechanic/work-orders", heading: /^workshop work orders$/i, hasTable: true },
  { path: "/mechanic/messages", heading: /^messages$/i, hasTable: false },
  { path: "/mechanic/purchase-requests", heading: /^purchase requests$/i, hasTable: true },
  { path: "/mechanic/maintenance", heading: /^vehicle maintenance logs$/i, hasTable: true },
  { path: "/mechanic/inventory", heading: /^parts inventory$/i, hasTable: true },
];

const NAV_LABELS = [
  "Dashboard",
  "Work orders assigned to me",
  "Messages",
  "Purchase requests (PO)",
  "Vehicle maintenance logs",
  "Parts inventory",
];

/**
 * Role-isolation helper. Both /admin and /mechanic layout routes use a
 * beforeLoad guard (src/routes/admin.tsx, src/routes/mechanic.tsx) that
 * redirects wrong-role visitors to their OWN home via homeForRole(). If the
 * redirect never happens we fail loudly — that is a security finding, not a
 * flaky test.
 */
async function expectBouncedHome(page: Page, forbidden: string, home: RegExp, who: string) {
  await page.goto(forbidden);
  await expect
    .poll(async () => new URL(page.url()).pathname, {
      timeout: 10_000,
      message: `SECURITY FINDING: ${who} visiting ${forbidden} was NOT redirected to their own dashboard — the route guard (beforeLoad role check) is missing or broken. Current URL: ${page.url()}`,
    })
    .toMatch(home);
  expect(
    new URL(page.url()).pathname.startsWith(forbidden),
    `SECURITY FINDING: ${who} still on ${forbidden} after navigation settled`,
  ).toBe(false);
}

test.describe("Mechanic role + cross-role security sweep", () => {
  test("mechanic dashboard renders with full sidebar nav", async ({ page }) => {
    await loginAs(page, "mechanic");
    await expect(page.getByRole("heading", { name: /dashboard|workshop/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    // Sidebar brand block ("Workshop" sub-label) + every nav item
    await expect(page.getByText(/^workshop$/i).first()).toBeVisible();
    for (const label of NAV_LABELS) {
      await expect(page.getByRole("link", { name: label }).first()).toBeVisible({
        timeout: 10_000,
      });
    }
    // Mechanic persona footer in the sidebar
    await expect(page.locator("aside").getByText(/^mechanic$/i).first()).toBeVisible();
  });

  test("every mechanic nav route renders a heading/table with no uncaught errors", async ({
    page,
  }) => {
    const consoleErrors = recordConsoleErrors(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(`[${page.url()}] ${err.message}`));

    await loginAs(page, "mechanic");

    for (const route of MECHANIC_ROUTES) {
      await page.goto(route.path);
      await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible({
        timeout: 10_000,
      });
      if (route.hasTable) {
        await expect(page.locator("table").first()).toBeVisible({ timeout: 10_000 });
      }
    }
    // Messages route renders a conversation list (or its empty state) instead of a table
    await page.goto("/mechanic/messages");
    await expect(page.getByTestId("mechanic-conversation-list")).toBeVisible({ timeout: 10_000 });

    const uncaught = consoleErrors.filter((e) => /uncaught/i.test(e));
    expect(uncaught, `Uncaught console errors:\n${uncaught.join("\n")}`).toEqual([]);
    expect(pageErrors, `Page errors thrown:\n${pageErrors.join("\n")}`).toEqual([]);
  });

  test("purchase requests page renders tabs + table and New request opens the create sheet", async ({
    page,
  }) => {
    await loginAs(page, "mechanic");
    await page.goto("/mechanic/purchase-requests");

    await expect(page.getByRole("tab", { name: /my requests/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("tab", { name: /all requests/i })).toBeVisible();
    // Table renders with its column headers regardless of row count
    await expect(page.getByRole("columnheader", { name: "PR #" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Urgency" })).toBeVisible();
    // Either real rows or the empty-state row — both are valid in mock mode
    await expect(page.locator("tbody tr").first()).toBeVisible();

    // "New request" opens the create form in a sheet, in place on this page.
    await page.getByRole("button", { name: /new request/i }).click();
    await expect(page).toHaveURL(/\/mechanic\/purchase-requests$/);
    await expect(page.getByRole("heading", { name: /new purchase request/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test("purchase request form blocks submit when required fields are empty", async ({ page }) => {
    await loginAs(page, "mechanic");
    await page.goto("/mechanic/purchase-requests");
    await page.getByRole("button", { name: /new request/i }).click();
    await expect(page.getByRole("heading", { name: /new purchase request/i })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: /submit for approval/i }).click();
    await expect(page.getByText(/fill all required fields/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("mechanic submits a purchase request and gets a success toast", async ({ page }) => {
    await loginAs(page, "mechanic");
    await page.goto("/mechanic/purchase-requests");
    await page.getByRole("button", { name: /new request/i }).click();
    await expect(page.getByRole("heading", { name: /new purchase request/i })).toBeVisible({
      timeout: 10_000,
    });

    const itemInput = page.locator('input[placeholder*="Brake pad"]');
    await itemInput.fill("E2E hydro nozzle seal kit");
    // Reason is the only textarea in the form
    await page.locator("textarea").first().fill("Replacement for WO bench test — e2e");
    await page.locator('input[placeholder="0.00"]').fill("42.50");
    // Urgency segmented control — pick "high"
    await page.getByRole("button", { name: /^high$/i }).click();

    // "Check inventory first" is on by default; wait for the inline inventory
    // feedback to settle (either "No inventory matches" or stock-match rows).
    await expect(
      page.getByText(/no inventory matches|in stock at/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    // If seeded inventory matched with stock on hand, the submit button is
    // gated behind an explicit override checkbox — tick it so the flow proceeds.
    const override = page.getByLabel(/override — submit anyway/i);
    if (await override.isVisible().catch(() => false)) {
      await override.check();
    }

    await page.getByRole("button", { name: /submit for approval/i }).click();
    await expect(page.getByText(/purchase request sent for approval/i).first()).toBeVisible({
      timeout: 10_000,
    });
    // Form resets after a successful mock submit
    await expect(itemInput).toHaveValue("", { timeout: 10_000 });
  });

  test("role isolation: driver visiting /admin is bounced to /driver", async ({ page }) => {
    await loginAs(page, "driver");
    await expectBouncedHome(page, "/admin", /^\/driver/, "driver");
  });

  test("role isolation: mechanic visiting /admin is bounced to /mechanic", async ({ page }) => {
    await loginAs(page, "mechanic");
    await expectBouncedHome(page, "/admin", /^\/mechanic/, "mechanic");
  });

  test("role isolation: driver visiting /mechanic is bounced to /driver", async ({ page }) => {
    await loginAs(page, "driver");
    await expectBouncedHome(page, "/mechanic", /^\/driver/, "driver");
  });

  test("branding: login shows the EHS brand mark and favicon links", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.locator('img[alt="Engage Hydrovac Services"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    // Favicon <link> tags are head-only (never "visible") — assert attributes
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", /favicon/);
  });
});
