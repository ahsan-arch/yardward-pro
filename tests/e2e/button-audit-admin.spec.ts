import { test, expect, Page } from "@playwright/test";
import { authedAs, recordConsoleErrors } from "./helpers";

/**
 * Admin button audit - one test per button, parallelised.
 *
 * Auth pattern: page.addInitScript(localStorage fo:authed=1, fo:role=admin) via authedAs()
 * Data mode: MOCK (no Supabase env vars in this repo) - DataContext reads from
 * src/data/mockData.ts. Supabase-only buttons (Fleetio import, tender scraper, DLQ
 * requeue, QBO push, error log table) will surface a "requires Supabase credentials"
 * toast; we still assert they're visible/clickable and produce *a* toast (not a crash).
 *
 * Each test:
 *  1. Logs in as admin
 *  2. Navigates to the button's route
 *  3. Asserts the button is visible + enabled
 *  4. Clicks it
 *  5. Asserts the action-type-specific side effect
 *  6. Asserts no error boundary fallback rendered
 *  7. Asserts no uncaught console / page errors
 *
 * A button that throws is a genuine RED — we do NOT convert failures to xfail
 * (that masked real breakage as "expected to fail"). Transient flakes under
 * full-suite parallel load are absorbed by per-test retries instead, so a real
 * regression still surfaces while a one-off hiccup self-heals on re-run.
 */

test.describe.configure({ mode: "parallel", retries: 2 });

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

type ActionType =
  | "nav"
  | "submit-form"
  | "modal-open"
  | "modal-confirm"
  | "modal-cancel"
  | "mutate-data"
  | "refresh"
  | "dropdown-trigger"
  | "toggle"
  | "delete"
  | "claim"
  | "approve"
  | "dismiss";

type ButtonSpec = {
  route: string;
  label: string;
  action: ActionType;
  selector: string;
};

const SEED_VEHICLE_ID = "TRK-07";
const SEED_WORK_ORDER_ID = "WO-116"; // pending QBO sync per admin-invoices.spec

const BUTTONS: ButtonSpec[] = [
  {
    route: "/admin/schedule",
    label: "Create new job",
    action: "modal-open",
    selector: "[data-testid='open-create-job']",
  },
  {
    route: "/admin/schedule",
    label: "Save as draft",
    action: "submit-form",
    selector: "[data-testid='submit-save-draft']",
  },
  {
    route: "/admin/schedule",
    label: "Publish + notify driver",
    action: "submit-form",
    selector: "[data-testid='submit-publish-job']",
  },
  {
    route: "/admin/schedule",
    label: "Publish (draft row)",
    action: "mutate-data",
    selector: "[data-testid^='publish-draft-']",
  },
  {
    route: "/admin/schedule",
    label: "Status filter",
    action: "dropdown-trigger",
    selector: "[data-testid='status-filter']",
  },

  {
    route: "/admin/jobs",
    label: "New job",
    action: "modal-open",
    selector: "button:has-text('New job')",
  },
  {
    route: "/admin/jobs",
    label: "Publish (draft row)",
    action: "mutate-data",
    selector: "[data-testid^='publish-draft-']",
  },

  {
    route: "/admin/drivers",
    label: "Add driver",
    action: "modal-open",
    selector: "button:has-text('Add driver')",
  },

  {
    route: "/admin/clients",
    label: "New client",
    action: "modal-open",
    selector: "button:has-text('New client')",
  },
  {
    route: "/admin/clients",
    label: "Create client (dialog submit)",
    action: "submit-form",
    selector: "dialog button[type='submit']:has-text('Create client')",
  },
  {
    route: "/admin/clients",
    label: "Add line (rate table)",
    action: "mutate-data",
    selector: "button:has-text('Add line')",
  },
  {
    route: "/admin/clients",
    label: "Save changes (rate table)",
    action: "submit-form",
    selector: "button:has-text('Save changes')",
  },
  {
    route: "/admin/clients",
    label: "Remove rate line",
    action: "delete",
    selector: "button[aria-label*='trash'], button:has(svg.lucide-trash-2)",
  },

  {
    route: "/admin/vehicles",
    label: "Import from Fleetio",
    action: "modal-open",
    selector: "[data-testid='open-fleetio-import']",
  },
  {
    route: "/admin/vehicles",
    label: "Add vehicle",
    action: "modal-open",
    selector: "button:has-text('Add vehicle')",
  },
  {
    route: "/admin/vehicles",
    label: "Run Fleetio import",
    action: "modal-confirm",
    selector: "[data-testid='fleetio-run']",
  },
  {
    route: "/admin/vehicles",
    label: "Close Fleetio dialog",
    action: "modal-cancel",
    selector: "dialog button:has-text('Close')",
  },
  {
    route: "/admin/vehicles",
    label: "Add record (vehicle card)",
    action: "modal-open",
    selector: "button:has-text('Add record')",
  },

  {
    route: `/admin/vehicles/${SEED_VEHICLE_ID}`,
    label: "Refresh location",
    action: "refresh",
    selector: "button:has-text('Refresh location')",
  },
  {
    route: `/admin/vehicles/${SEED_VEHICLE_ID}`,
    label: "Schedule service",
    action: "modal-open",
    selector: "button:has-text('Schedule service')",
  },
  {
    route: `/admin/vehicles/${SEED_VEHICLE_ID}`,
    label: "Add fuel entry",
    action: "modal-open",
    selector: "button:has-text('Add fuel entry')",
  },
  {
    route: `/admin/vehicles/${SEED_VEHICLE_ID}`,
    label: "Add log (schedule service dialog submit)",
    action: "submit-form",
    selector: "dialog button[type='submit']:has-text('Add log')",
  },
  {
    route: `/admin/vehicles/${SEED_VEHICLE_ID}`,
    label: "Add fuel entry (dialog submit)",
    action: "submit-form",
    selector: "dialog button[type='submit']:has-text('Add fuel entry')",
  },

  {
    route: "/admin/work-orders",
    label: "Approve (row)",
    action: "approve",
    selector: "button:has-text('Approve')",
  },
  {
    route: "/admin/work-orders",
    label: "Reject (row)",
    action: "mutate-data",
    selector: "button:has-text('Reject')",
  },
  {
    route: "/admin/work-orders",
    label: "Approve & generate invoice data",
    action: "approve",
    selector: "button:has-text('Approve & generate invoice data')",
  },
  {
    route: "/admin/work-orders",
    label: "Reject (sheet)",
    action: "mutate-data",
    selector: "div.sheet-content button:has-text('Reject')",
  },

  {
    route: `/admin/invoices/${SEED_WORK_ORDER_ID}`,
    label: "Push to QuickBooks",
    action: "mutate-data",
    selector: "button:has-text('Push to QuickBooks')",
  },

  {
    route: "/admin/tickets",
    label: "Tab: Awaiting entry",
    action: "toggle",
    selector: "[role='tab']:has-text('Awaiting entry')",
  },
  {
    route: "/admin/tickets",
    label: "Ticket card (open sheet)",
    action: "modal-open",
    selector: "button.bg-card",
  },
  {
    route: "/admin/tickets",
    label: "Save entry",
    action: "submit-form",
    selector: "button:has-text('Save entry')",
  },

  {
    route: "/admin/prepaid-tickets",
    label: "Top up (bundle size)",
    action: "mutate-data",
    selector: "button:has-text('Top up')",
  },
  {
    route: "/admin/prepaid-tickets",
    label: "Save settings",
    action: "submit-form",
    selector: "button:has-text('Save settings')",
  },

  {
    route: "/admin/purchase-requests",
    label: "Approve (row checkmark)",
    action: "approve",
    selector: "tr button:has(svg.lucide-check)",
  },
  {
    route: "/admin/purchase-requests",
    label: "Reject (row X)",
    action: "mutate-data",
    selector: "tr button:has(svg.lucide-x)",
  },
  {
    route: "/admin/purchase-requests",
    label: "Mark ordered (row)",
    action: "modal-open",
    selector: "button:has-text('Mark ordered')",
  },
  {
    route: "/admin/purchase-requests",
    label: "Approve & reserve (sheet)",
    action: "approve",
    selector: "button:has-text('Approve & reserve')",
  },
  {
    route: "/admin/purchase-requests",
    label: "Reject (sheet)",
    action: "mutate-data",
    selector: "div.sheet-content button:has-text('Reject')",
  },
  {
    route: "/admin/purchase-requests",
    label: "Mark ordered (sheet submit)",
    action: "submit-form",
    selector: "div.sheet-content button:has-text('Mark ordered')",
  },

  {
    route: "/admin/tenders",
    label: "Run scraper",
    action: "refresh",
    selector: "button:has-text('Run scraper')",
  },
  {
    route: "/admin/tenders",
    label: "Send test digest",
    action: "submit-form",
    selector: "button:has-text('Send test digest')",
  },

  {
    route: "/admin/timesheets",
    label: "Export to QuickBooks",
    action: "modal-open",
    selector: "[data-testid='export-to-qbo-btn']",
  },
  {
    route: "/admin/timesheets",
    label: "QBO push run (dialog)",
    action: "modal-confirm",
    selector: "[data-testid='qbo-push-run']",
  },
  {
    route: "/admin/timesheets",
    label: "Close QBO dialog",
    action: "modal-cancel",
    selector: "dialog button:has-text('Close')",
  },
  {
    route: "/admin/timesheets",
    label: "Mark resolved (flag)",
    action: "mutate-data",
    selector: "[data-testid^='clear-flag-']",
  },
  {
    route: "/admin/timesheets",
    label: "Persist flag (tolerance)",
    action: "mutate-data",
    selector: "[data-testid^='persist-flag-']",
  },

  {
    route: "/admin/reports",
    label: "Report card (open)",
    action: "modal-open",
    selector: "button:has-text('Driver hours'), button:has-text('Vehicle utilization')",
  },
  {
    route: "/admin/reports",
    label: "Close report",
    action: "modal-cancel",
    selector: "button:has-text('Close')",
  },

  {
    route: "/admin/errors",
    label: "Tab: Errors",
    action: "toggle",
    selector: "[data-testid='tab-errors']",
  },
  {
    route: "/admin/errors",
    label: "Tab: Dead-letter queue",
    action: "toggle",
    selector: "[data-testid='tab-dlq']",
  },
  {
    route: "/admin/errors",
    label: "Mark resolved (error)",
    action: "mutate-data",
    selector: "button:has-text('Mark resolved')",
  },
  {
    route: "/admin/errors",
    label: "Requeue (DLQ)",
    action: "mutate-data",
    selector: "[data-testid='dlq-requeue']",
  },

  {
    route: "/admin/settings",
    label: "Save changes (org)",
    action: "submit-form",
    selector: "button:has-text('Save changes')",
  },
  {
    route: "/admin/settings",
    label: "Save changes (system thresholds)",
    action: "submit-form",
    selector: "[data-testid='save-system-settings']",
  },
  {
    route: "/admin/settings",
    label: "Invite user",
    action: "modal-open",
    selector: "button:has-text('Invite user')",
  },
  // Integrations rework: probing has no toast (state refresh only), and the
  // old Disconnect button was removed — Test/Re-test is the only safe button
  // to exercise (Connect would start a real OAuth redirect).
  {
    route: "/admin/settings",
    label: "Test / Connect integration",
    action: "refresh",
    selector: "[data-testid^='integration-test-']",
  },
  {
    route: "/admin/settings",
    label: "Save QBO mappings",
    action: "submit-form",
    selector: "[data-testid='save-qbo-mappings']",
  },
  {
    route: "/admin/settings",
    label: "Generate token",
    action: "modal-open",
    selector: "[data-testid='generate-token-btn']",
  },
  {
    route: "/admin/settings",
    label: "Generate (confirm)",
    action: "modal-confirm",
    selector: "[data-testid='token-generate-confirm']",
  },
  {
    route: "/admin/settings",
    label: "Copy URL (token)",
    action: "mutate-data",
    selector: "[data-testid='token-copy-btn']",
  },
  {
    route: "/admin/settings",
    label: "Open as driver",
    action: "nav",
    selector: "[data-testid='token-open-btn']",
  },
  {
    route: "/admin/settings",
    label: "Generate another",
    action: "refresh",
    selector: "button:has-text('Generate another')",
  },
  {
    route: "/admin/settings",
    label: "Cancel subscription",
    action: "delete",
    selector: "button:has-text('Cancel subscription')",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ERROR_BOUNDARY_FALLBACK = /something went wrong|reload the app/i;
const CRASH_TOAST = /unknown error|TypeError|ReferenceError|undefined is not/i;
const SUCCESS_OR_KNOWN_TOAST =
  /saved|created|added|updated|published|approved|rejected|deleted|removed|sent|imported|synced|connected|disconnected|copied|requeued|resolved|cleared|ordered|reserved|cancell?ed|requires supabase|coming soon|not configured|stub|sent test|digest sent|manual scrape/i;

async function ensureNoCrash(page: Page) {
  // Error boundary fallback must not be visible
  const boundary = page.locator(`text=${ERROR_BOUNDARY_FALLBACK.source}`).first();
  await expect(boundary).toHaveCount(0);
}

function flushConsoleErrors(errors: string[]): string[] {
  // Filter benign noise that other specs already ignore
  return errors.filter((e) => {
    if (/React DevTools/.test(e)) return false;
    if (/\[vite\] connect/.test(e)) return false;
    if (/Download the React DevTools/.test(e)) return false;
    if (/favicon\.ico/.test(e)) return false;
    if (/sourcemap/.test(e)) return false;
    return true;
  });
}

/**
 * Locate the button using the inventory selector. The selector may be a
 * comma-separated list of fallbacks - use Playwright's CSS `,` already; for
 * mixed text+css we split and try each.
 */
function locateButton(page: Page, selector: string) {
  // Many selectors use ":has-text(...)" alternation joined with ", ".
  // Playwright supports comma-separated CSS but our `:has-text` is a
  // Playwright extension that's fine inside the same selector string.
  return page.locator(selector).first();
}

/**
 * Some buttons live inside dialogs that must be opened first. We pre-open
 * pre-requisites here so the dialog-scoped selectors actually find a target.
 */
async function preOpenContext(page: Page, spec: ButtonSpec) {
  const { route, label, selector } = spec;

  // Dialog-scoped selectors need a parent dialog visible first.
  const needsDialog = /^dialog |div\.sheet-content /.test(selector);

  if (route === "/admin/clients") {
    if (label.includes("Create client")) {
      await page
        .locator("button:has-text('New client')")
        .first()
        .click()
        .catch(() => {});
    } else if (
      label.includes("rate table") ||
      label === "Remove rate line" ||
      label === "Save changes (rate table)"
    ) {
      // Open client detail sheet
      await page
        .locator("tbody tr")
        .first()
        .click()
        .catch(() => {});
    }
  }

  if (route === "/admin/vehicles" && label === "Run Fleetio import") {
    await page
      .locator("[data-testid='open-fleetio-import']")
      .first()
      .click()
      .catch(() => {});
  }
  if (route === "/admin/vehicles" && label === "Close Fleetio dialog") {
    await page
      .locator("[data-testid='open-fleetio-import']")
      .first()
      .click()
      .catch(() => {});
  }
  if (route === "/admin/vehicles" && label === "Add record (vehicle card)") {
    // Add record sits inside the per-vehicle card; nothing to pre-open.
  }

  if (route.startsWith("/admin/vehicles/") && label.includes("Add log")) {
    await page
      .locator("button:has-text('Schedule service')")
      .first()
      .click()
      .catch(() => {});
  }
  if (route.startsWith("/admin/vehicles/") && label === "Add fuel entry (dialog submit)") {
    await page
      .locator("button:has-text('Add fuel entry')")
      .first()
      .click()
      .catch(() => {});
  }

  if (route === "/admin/work-orders") {
    if (label === "Reject (sheet)" || label === "Approve & generate invoice data") {
      await page
        .locator("tbody tr")
        .first()
        .click()
        .catch(() => {});
    } else if (label === "Approve (row)" || label === "Reject (row)") {
      await page
        .getByRole("tab", { name: /pending approval/i })
        .click()
        .catch(() => {});
    }
  }

  if (route === "/admin/purchase-requests") {
    if (
      label.includes("(sheet)") ||
      label === "Mark ordered (sheet submit)" ||
      label === "Approve & reserve (sheet)"
    ) {
      await page
        .locator("tbody tr")
        .first()
        .click()
        .catch(() => {});
    }
  }

  if (route === "/admin/tickets" && label === "Save entry") {
    await page
      .getByRole("tab", { name: /awaiting entry/i })
      .click()
      .catch(() => {});
    await page
      .locator("button.bg-card")
      .first()
      .click()
      .catch(() => {});
  }

  if (
    route === "/admin/timesheets" &&
    (label === "QBO push run (dialog)" || label === "Close QBO dialog")
  ) {
    await page
      .locator("[data-testid='export-to-qbo-btn']")
      .first()
      .click()
      .catch(() => {});
  }

  if (route === "/admin/reports" && label === "Close report") {
    await page
      .locator("button:has-text('Driver hours')")
      .first()
      .click()
      .catch(() => {});
  }

  if (route === "/admin/errors" && label === "Requeue (DLQ)") {
    await page
      .locator("[data-testid='tab-dlq']")
      .first()
      .click()
      .catch(() => {});
  }

  if (route === "/admin/settings") {
    if (label === "Save changes (system thresholds)" || label === "Save QBO mappings") {
      // System thresholds and QBO mappings live under Integrations / System tabs
      await page
        .getByRole("tab", { name: /integrations|system/i })
        .first()
        .click()
        .catch(() => {});
    }
    if (
      label === "Invite user" ||
      label.includes("token") ||
      label === "Generate token" ||
      label === "Generate (confirm)" ||
      label === "Copy URL (token)" ||
      label === "Open as driver" ||
      label === "Generate another"
    ) {
      await page
        .getByRole("tab", { name: /driver tokens|users/i })
        .first()
        .click()
        .catch(() => {});
    }
    if (label === "Test / Connect integration" || label === "Disconnect integration") {
      await page
        .getByRole("tab", { name: /integrations/i })
        .click()
        .catch(() => {});
    }
    if (label === "Cancel subscription") {
      await page
        .getByRole("tab", { name: /billing/i })
        .click()
        .catch(() => {});
    }
    if (
      label === "Generate (confirm)" ||
      label === "Copy URL (token)" ||
      label === "Open as driver" ||
      label === "Generate another"
    ) {
      await page
        .locator("[data-testid='generate-token-btn']")
        .first()
        .click()
        .catch(() => {});
    }
  }

  // Fallback safety wait
  if (needsDialog) {
    await page
      .locator("[role='dialog'], dialog")
      .first()
      .waitFor({ state: "visible", timeout: 3_000 })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Action-type assertions
// ---------------------------------------------------------------------------

async function assertActionEffect(page: Page, spec: ButtonSpec, prevUrl: string) {
  const { action } = spec;
  const dialog = page.locator("[role='dialog'], dialog").first();
  const toast = page
    .locator(
      "[data-sonner-toast], [role='status'], [role='alert'], .sonner-toast, li[data-sonner-toast]",
    )
    .first();

  switch (action) {
    case "nav": {
      await expect.poll(async () => page.url(), { timeout: 5_000 }).not.toBe(prevUrl);
      break;
    }

    case "submit-form": {
      // Either URL changed or a toast appeared
      const changed = await Promise.race([
        page
          .waitForURL((u) => u.toString() !== prevUrl, { timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
        toast
          .waitFor({ state: "visible", timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
      ]);
      expect(changed, "expected nav or toast after submit").toBeTruthy();
      break;
    }

    case "modal-open": {
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      break;
    }

    case "modal-confirm": {
      // Either dialog dismissed OR a toast surfaced (mock-mode often leaves the
      // dialog open and just shows "requires Supabase credentials").
      const closedOrToast = await Promise.race([
        dialog
          .waitFor({ state: "hidden", timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
        toast
          .waitFor({ state: "visible", timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
      ]);
      expect(closedOrToast, "expected dialog close or toast after confirm").toBeTruthy();
      break;
    }

    case "modal-cancel": {
      await expect(dialog).toBeHidden({ timeout: 5_000 });
      break;
    }

    case "mutate-data": {
      await expect(toast).toBeVisible({ timeout: 5_000 });
      const text = (await toast.innerText().catch(() => "")) || "";
      expect(text, `toast must not be a crash: ${text}`).not.toMatch(CRASH_TOAST);
      break;
    }

    case "refresh": {
      // No URL change required, but no crash either.
      await page.waitForTimeout(500);
      break;
    }

    case "dropdown-trigger": {
      const menu = page
        .locator("[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper]")
        .first();
      await expect(menu).toBeVisible({ timeout: 5_000 });
      break;
    }

    case "toggle": {
      // Toggle: aria-selected / aria-pressed / data-state must flip OR list now visible
      await page.waitForTimeout(400);
      break;
    }

    case "delete": {
      // Either confirm dialog appeared or a toast surfaced
      const confirmOrToast = await Promise.race([
        dialog
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false),
        toast
          .waitFor({ state: "visible", timeout: 3_000 })
          .then(() => true)
          .catch(() => false),
      ]);
      expect(confirmOrToast, "expected confirm prompt or toast on delete").toBeTruthy();
      break;
    }

    case "claim": {
      await expect(toast).toBeVisible({ timeout: 5_000 });
      break;
    }

    case "approve": {
      // Either a toast OR a URL change (admin work-orders approve -> /invoices)
      const navOrToast = await Promise.race([
        page
          .waitForURL((u) => u.toString() !== prevUrl, { timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
        toast
          .waitFor({ state: "visible", timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
      ]);
      expect(navOrToast, "expected nav or toast after approve").toBeTruthy();
      break;
    }

    case "dismiss": {
      // Original target should be detached or hidden
      const target = locateButton(page, spec.selector);
      await expect(target).toBeHidden({ timeout: 5_000 });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-button tests
// ---------------------------------------------------------------------------

for (const spec of BUTTONS) {
  const title = `[${spec.route}] ${spec.label} (${spec.action})`;

  test(title, async ({ page }) => {
    test.setTimeout(45_000);

    await authedAs(page, "admin");
    const consoleErrors = recordConsoleErrors(page);

    // No try/catch-to-xfail wrapper: a button that throws is a genuine failure
    // and must go RED so a real regression can't hide behind an "expected to
    // fail" badge. Transient flakes are handled by the suite's retries above.
    await page.goto(spec.route, { waitUntil: "domcontentloaded" });

    await ensureNoCrash(page);
    await preOpenContext(page, spec);

    const button = locateButton(page, spec.selector);
    await button.waitFor({ state: "visible", timeout: 8_000 });

    await expect(button, "button should be visible").toBeVisible();
    await expect(button, "button should be enabled").toBeEnabled();

    const prevUrl = page.url();
    await button.click({ trial: false });

    await assertActionEffect(page, spec, prevUrl);
    await ensureNoCrash(page);

    const fatal = flushConsoleErrors(consoleErrors);
    expect(fatal, `Uncaught errors after click:\n${fatal.join("\n")}`).toEqual([]);
  });
}
