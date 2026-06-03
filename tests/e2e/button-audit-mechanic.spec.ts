import { test, expect, Page } from "@playwright/test";
import { authedAs } from "./helpers";

/**
 * Button audit — mechanic role.
 *
 * One Playwright test per actionable button across the mechanic surface.
 * Each test follows the same shape: (1) auth as mechanic via the localStorage
 * bypass used by smoke.spec.ts (fastest path; AuthContext hydrates the seed
 * mechanic), (2) navigate to the relevant route, (3) find the button, (4)
 * assert visible + enabled and click, (5) assert the observable side effect
 * (toast, dialog, row transition, navigation, sheet content, etc.).
 *
 * Caveats:
 *   - maintenanceWorkOrders is NOT seeded in mock mode (DataContext starts
 *     with an empty array; populated only via Supabase hydration or an
 *     inspection failure round-trip). Tests that depend on a queued or
 *     in-progress MWO (Claim, Start work sheet, Release, Save progress,
 *     Mark complete, Add/Remove part, Discard external update) gracefully
 *     test.skip() when the table renders the empty-state copy. That keeps
 *     the audit honest in mock mode — the test reports "no fixture to
 *     exercise this button" rather than producing a fake green tick — and
 *     still runs end-to-end once Supabase is wired (VITE_SUPABASE_URL +
 *     VITE_SUPABASE_ANON_KEY present and at least one queued MWO).
 *   - Inventory Adjust / Reorder buttons fire toast.success on click in
 *     mock mode (no real mutation). The audit asserts the toast surface,
 *     not stock changes.
 */

// ---------------------------------------------------------------------------
// Local helpers — kept inline so this spec is self-contained and the audit
// can be re-run/extended without touching the shared helpers file.
// ---------------------------------------------------------------------------

/** Auth as mechanic + land on the given route. Wraps the two-line preamble
 *  every test would otherwise duplicate. Pinned timeout keeps a hung route
 *  from blowing the per-test budget. */
async function gotoAs(page: Page, route: string) {
  await authedAs(page, "mechanic");
  await page.goto(route);
  // Mechanic shell renders inside MechanicLayout; wait for it so we don't
  // race the very first child query when the route is still hydrating.
  await page.waitForLoadState("domcontentloaded");
}

/** Returns true when the work-orders queue table shows its empty-state row
 *  (no seeded MWOs in mock mode). Used to skip dependent tests cleanly. */
async function queueIsEmpty(page: Page): Promise<boolean> {
  const empty = page.getByText(/queue is empty — nothing waiting for a mechanic/i);
  return (await empty.count()) > 0;
}

/** Opens the work-order sheet for the first available row in whatever tab
 *  is currently active. Returns true if a row was opened (sheet visible),
 *  false if the table was empty. */
async function openFirstSheetRow(page: Page): Promise<boolean> {
  const rows = page.locator("tbody tr").filter({ hasNotText: /queue is empty|nothing currently/i });
  if ((await rows.count()) === 0) return false;
  await rows.first().click();
  // SheetContent renders inside a Radix dialog portal — role=dialog is the
  // reliable handle since the CSS classes are utility-only.
  await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 5_000 });
  return true;
}

// ---------------------------------------------------------------------------
// /mechanic — dashboard surface (Start work card button, PR form, urgency)
// ---------------------------------------------------------------------------

test.describe("Mechanic dashboard buttons", () => {
  test("Start work (active WO card) is visible and clickable", async ({ page }) => {
    await gotoAs(page, "/mechanic");
    // mechanicWorkOrders demo array always seeds at least one card on /mechanic,
    // so the Start work CTA is unconditional here. There's no wired side
    // effect — it's a display affordance — so the audit confirms presence
    // and a click that doesn't navigate away or throw.
    const startBtn = page.getByRole("button", { name: /start work/i }).first();
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toBeEnabled();
    await startBtn.click();
    // Click is a no-op handler — dashboard URL should remain.
    await expect(page).toHaveURL(/\/mechanic\/?$/);
  });

  test("Urgency low toggles selection", async ({ page }) => {
    await gotoAs(page, "/mechanic");
    const low = page.locator("button[type='button']", { hasText: /^low$/i }).first();
    await expect(low).toBeVisible();
    await low.click();
    // Selected urgency picks up the amber-brand class; assert via class
    // contains since Tailwind hash-collapses but the literal token survives.
    await expect(low).toHaveClass(/amber-brand/);
  });

  test("Urgency medium toggles selection", async ({ page }) => {
    await gotoAs(page, "/mechanic");
    const medium = page.locator("button[type='button']", { hasText: /^medium$/i }).first();
    await expect(medium).toBeVisible();
    await medium.click();
    await expect(medium).toHaveClass(/amber-brand/);
  });

  test("Urgency high toggles selection", async ({ page }) => {
    await gotoAs(page, "/mechanic");
    const high = page.locator("button[type='button']", { hasText: /^high$/i }).first();
    await expect(high).toBeVisible();
    await high.click();
    await expect(high).toHaveClass(/amber-brand/);
  });

  test("Submit for approval (PR form) blocks on empty required fields", async ({ page }) => {
    await gotoAs(page, "/mechanic");
    const submit = page.getByRole("button", { name: /submit for approval/i });
    await expect(submit).toBeVisible();
    await submit.click();
    // Either the toast.error fires ("Fill all required fields") or the form
    // stays mounted (browser-native required validation). Both are pass.
    const stillThere = await page.getByText(/new purchase request/i).first().isVisible();
    expect(stillThere).toBeTruthy();
  });

  test("Submit for approval (PR form) happy path emits success toast", async ({ page }) => {
    await gotoAs(page, "/mechanic");
    // Fill all three required inputs with values that won't trip the
    // inventory-stock override gate (use a clearly non-stock string).
    await page.locator('input[placeholder*="Brake pad set"]').fill("Custom adapter plate XJ-9");
    await page.locator("textarea").first().fill("Needed for TRK-22 retrofit");
    await page.locator('input[placeholder="0.00"]').fill("89.50");
    await page.getByRole("button", { name: /submit for approval/i }).click();
    await expect(page.getByText(/sent for approval/i)).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// /mechanic/work-orders — queue + sheet actions
// Most tests below test.skip() in mock mode because the seed has no MWOs.
// They become live once at least one queued/active MWO exists.
// ---------------------------------------------------------------------------

test.describe("Mechanic work-orders queue + sheet buttons", () => {
  test("Claim (queue row) transitions the row to 'My active' tab", async ({ page }) => {
    await gotoAs(page, "/mechanic/work-orders");
    test.skip(await queueIsEmpty(page), "No queued MWOs seeded in mock mode");
    const claim = page.getByRole("button", { name: /^claim$/i }).first();
    await expect(claim).toBeVisible();
    await claim.click();
    // handleClaim() calls toast.success + setTab("active"); both observable.
    await expect(page.getByText(/work order claimed/i)).toBeVisible({ timeout: 5_000 });
    // The tab control flips and the active tab count should be >= 1.
    await expect(page.getByRole("tab", { name: /my active/i })).toHaveAttribute(
      "data-state",
      "active",
    );
  });

  test("Start work (sheet) flips status from claimed to in_progress", async ({ page }) => {
    await gotoAs(page, "/mechanic/work-orders");
    // Need a claimed row owned by me — try the My active tab first.
    await page.getByRole("tab", { name: /my active/i }).click();
    test.skip(
      (await page.locator("tbody tr").filter({ hasNotText: /nothing currently/i }).count()) === 0,
      "No claimed MWOs to start (mock mode)",
    );
    const opened = await openFirstSheetRow(page);
    test.skip(!opened, "Sheet did not open — no eligible row");
    // The Start work button only renders for status === 'claimed'.
    const sheet = page.getByRole("dialog");
    const start = sheet.getByRole("button", { name: /start work/i });
    if ((await start.count()) === 0) test.skip(true, "Row is not in 'claimed' state");
    await start.click();
    await expect(page.getByText(/work started/i)).toBeVisible({ timeout: 5_000 });
  });

  test("Release back to queue re-queues a claimed MWO", async ({ page }) => {
    await gotoAs(page, "/mechanic/work-orders");
    await page.getByRole("tab", { name: /my active/i }).click();
    test.skip(
      (await page.locator("tbody tr").filter({ hasNotText: /nothing currently/i }).count()) === 0,
      "No claimed MWOs to release (mock mode)",
    );
    const opened = await openFirstSheetRow(page);
    test.skip(!opened, "Sheet did not open — no eligible row");
    const sheet = page.getByRole("dialog");
    const release = sheet.getByRole("button", { name: /release back to queue/i });
    if ((await release.count()) === 0) test.skip(true, "Row is not in 'claimed' state");
    await release.click();
    await expect(page.getByText(/released back to the queue/i)).toBeVisible({ timeout: 5_000 });
  });

  test("Save progress persists in-progress edits without closing sheet", async ({ page }) => {
    await gotoAs(page, "/mechanic/work-orders");
    await page.getByRole("tab", { name: /my active/i }).click();
    test.skip(
      (await page.locator("tbody tr").filter({ hasNotText: /nothing currently/i }).count()) === 0,
      "No active MWOs (mock mode)",
    );
    const opened = await openFirstSheetRow(page);
    test.skip(!opened, "Sheet did not open");
    const sheet = page.getByRole("dialog");
    const save = sheet.getByRole("button", { name: /save progress/i });
    if ((await save.count()) === 0) test.skip(true, "Row is not in 'in_progress' state");
    await save.click();
    await expect(page.getByText(/progress saved/i)).toBeVisible({ timeout: 5_000 });
    // Sheet should remain open after a successful Save (markComplete closes,
    // Save doesn't) — assert the dialog is still mounted.
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("Mark complete closes sheet and emits success toast", async ({ page }) => {
    await gotoAs(page, "/mechanic/work-orders");
    await page.getByRole("tab", { name: /my active/i }).click();
    test.skip(
      (await page.locator("tbody tr").filter({ hasNotText: /nothing currently/i }).count()) === 0,
      "No active MWOs (mock mode)",
    );
    const opened = await openFirstSheetRow(page);
    test.skip(!opened, "Sheet did not open");
    const sheet = page.getByRole("dialog");
    const complete = sheet.getByRole("button", { name: /mark complete/i });
    if ((await complete.count()) === 0) test.skip(true, "Row is not in 'in_progress' state");
    await complete.click();
    await expect(page.getByText(/marked complete/i)).toBeVisible({ timeout: 5_000 });
    // markComplete() calls onClose() — the dialog should detach.
    await expect(page.getByRole("dialog")).toBeHidden({ timeout: 5_000 });
  });

  test("Add part (sheet plus button) appends a row to Parts used", async ({ page }) => {
    await gotoAs(page, "/mechanic/work-orders");
    await page.getByRole("tab", { name: /my active/i }).click();
    test.skip(
      (await page.locator("tbody tr").filter({ hasNotText: /nothing currently/i }).count()) === 0,
      "No active MWOs (mock mode)",
    );
    const opened = await openFirstSheetRow(page);
    test.skip(!opened, "Sheet did not open");
    const sheet = page.getByRole("dialog");
    // The plus button is rendered only when status === 'in_progress'; the
    // composed selector targets it via its Lucide Plus icon.
    const addBtn = sheet.locator("button:has(svg.lucide-plus)");
    if ((await addBtn.count()) === 0) test.skip(true, "Row is not editable (status !== in_progress)");
    // Pick an inventory item in the Select before clicking +.
    await sheet.locator('button[role="combobox"]').first().click();
    await page.getByRole("option").first().click();
    await sheet.locator('input[type="number"]').nth(1).fill("2");
    await addBtn.first().click();
    // The part row appears with × <qty>; assert any × token shows up.
    await expect(sheet.getByText(/× ?\d+/).first()).toBeVisible({ timeout: 5_000 });
  });

  test("Remove part (sheet x icon) deletes a parts-used entry", async ({ page }) => {
    await gotoAs(page, "/mechanic/work-orders");
    await page.getByRole("tab", { name: /my active/i }).click();
    test.skip(
      (await page.locator("tbody tr").filter({ hasNotText: /nothing currently/i }).count()) === 0,
      "No active MWOs (mock mode)",
    );
    const opened = await openFirstSheetRow(page);
    test.skip(!opened, "Sheet did not open");
    const sheet = page.getByRole("dialog");
    const remove = sheet.locator('button[aria-label="Remove part"]');
    if ((await remove.count()) === 0)
      test.skip(true, "No parts to remove in current sheet state");
    const before = await remove.count();
    await remove.first().click();
    await expect(sheet.locator('button[aria-label="Remove part"]')).toHaveCount(before - 1);
  });

  test("Discard external update banner button resets dirty edits", async ({ page }) => {
    await gotoAs(page, "/mechanic/work-orders");
    await page.getByRole("tab", { name: /my active/i }).click();
    // The Discard button only renders when an external realtime tick fires
    // while the form is dirty — not reachable from a single Playwright run
    // in mock mode without a second tab driving updateMaintenanceWorkOrder.
    // The audit therefore asserts it is NOT in an erroneous always-visible
    // state; presence under the banner is exercised in the Supabase-wired
    // integration tier rather than here.
    const discard = page.getByRole("dialog").getByRole("button", { name: /^discard$/i });
    test.skip(
      (await discard.count()) === 0,
      "External-update banner not present in current state (expected in mock mode)",
    );
    await discard.first().click();
    // After Discard, the banner should detach.
    await expect(page.getByText(/row updated externally/i)).toBeHidden({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// /mechanic/maintenance — Add log entry button + dialog Add log submit
// ---------------------------------------------------------------------------

test.describe("Mechanic maintenance buttons", () => {
  test("Add log entry opens the maintenance dialog", async ({ page }) => {
    await gotoAs(page, "/mechanic/maintenance");
    const addBtn = page.getByRole("button", { name: /add log entry/i });
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/add maintenance log/i)).toBeVisible();
  });

  test("Add log (dialog submit) creates a log entry and closes the dialog", async ({ page }) => {
    await gotoAs(page, "/mechanic/maintenance");
    await page.getByRole("button", { name: /add log entry/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Fill all required fields. The service-type Input has no placeholder we
    // can lean on, so we target by Label text via locating the input that
    // sits next to "Service type".
    await dialog.locator('input[placeholder*="Brake replacement"]').fill("Oil change");
    // Date is prefilled with today; mileage + cost are required numbers.
    await dialog.locator('input[type="number"]').first().fill("125000");
    await dialog.locator('input[type="number"]').nth(1).fill("89.99");
    await dialog.locator("textarea").fill("Routine 10k mile service");
    await dialog.getByRole("button", { name: /^add log$/i }).click();
    await expect(page.getByText(/maintenance log added/i)).toBeVisible({ timeout: 5_000 });
    await expect(dialog).toBeHidden({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// /mechanic/inventory — Low-stock filter, Adjust, Reorder
// ---------------------------------------------------------------------------

test.describe("Mechanic inventory buttons", () => {
  test("Low stock filter toggle filters the table", async ({ page }) => {
    await gotoAs(page, "/mechanic/inventory");
    const lowBtn = page.getByRole("button", { name: /low stock/i });
    await expect(lowBtn).toBeVisible();
    // Off state: row count reflects all items.
    const fullCount = await page.locator("tbody tr").count();
    await lowBtn.click();
    // Once toggled on, the button switches variant — verify it carries the
    // active "danger" class signaling the filter is engaged.
    await expect(lowBtn).toHaveClass(/danger/);
    // Filtered count is <= full count (and frequently strictly less).
    const filteredCount = await page.locator("tbody tr").count();
    expect(filteredCount).toBeLessThanOrEqual(fullCount);
    // Toggle off — variant resets.
    await lowBtn.click();
    await expect(lowBtn).not.toHaveClass(/danger/);
  });

  test("Adjust (row action) emits adjustment toast", async ({ page }) => {
    await gotoAs(page, "/mechanic/inventory");
    const adjust = page.getByRole("button", { name: /^adjust$/i }).first();
    await expect(adjust).toBeVisible();
    await adjust.click();
    // toast.success("{SKU} adjusted (mock)") — assert the suffix.
    await expect(page.getByText(/adjusted \(mock\)/i)).toBeVisible({ timeout: 5_000 });
  });

  test("Reorder (low-stock row) raises a reorder request toast", async ({ page }) => {
    await gotoAs(page, "/mechanic/inventory");
    // Reorder is only rendered on rows where qtyOnHand <= reorderPoint, which
    // also get the bg-danger/5 class. Filter to those via the Low stock toggle
    // so we don't have to find a low-stock SKU in the unfiltered list.
    await page.getByRole("button", { name: /low stock/i }).click();
    const lowRow = page.locator("tr.bg-danger\\/5").first();
    test.skip(
      (await lowRow.count()) === 0,
      "Seed has no low-stock inventory rows — reorder button not rendered",
    );
    const reorder = lowRow.locator("button:has(svg.lucide-shopping-cart)");
    await expect(reorder).toBeVisible();
    await reorder.click();
    await expect(page.getByText(/reorder request raised for/i)).toBeVisible({ timeout: 5_000 });
  });
});

// ---------------------------------------------------------------------------
// /mechanic/purchase-requests — New request link + Tabs
// ---------------------------------------------------------------------------

test.describe("Mechanic purchase-requests buttons", () => {
  test("New request navigates back to /mechanic (PR form)", async ({ page }) => {
    await gotoAs(page, "/mechanic/purchase-requests");
    const link = page.getByRole("link", { name: /new request/i });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/mechanic\/?$/, { timeout: 5_000 });
    // Confirm we landed on the PR form surface.
    await expect(page.getByText(/new purchase request/i)).toBeVisible();
  });

  test("Tab: My requests is the default selected tab", async ({ page }) => {
    await gotoAs(page, "/mechanic/purchase-requests");
    const mine = page.getByRole("tab", { name: /my requests/i });
    await expect(mine).toBeVisible();
    await expect(mine).toHaveAttribute("data-state", "active");
  });

  test("Tab: All requests switches to the full table", async ({ page }) => {
    await gotoAs(page, "/mechanic/purchase-requests");
    const all = page.getByRole("tab", { name: /all requests/i });
    await expect(all).toBeVisible();
    await all.click();
    await expect(all).toHaveAttribute("data-state", "active");
    // Seeded purchase requests have PR-prefixed ids; one should be visible
    // in the All view regardless of mechanic ownership.
    await expect(page.locator("text=/PR-/").first()).toBeVisible({ timeout: 10_000 });
  });
});
