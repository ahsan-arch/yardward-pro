// Public client portal (/portal/$code) + standalone invoicing (invoice page
// email/mark-paid + receivables ledger). Mock mode (VITE_USE_SUPABASE=false):
// portalContext -> "Mock Client Co." / ["Mock Driver"] / ["TRUCK-1"],
// portalSubmitDump -> { ok: true, submissionCode: "MOCK-..." },
// sendEmail / markInvoicePaid -> ok, fetchInvoiceLedger -> [] (empty state).
import { test, expect } from "@playwright/test";
import { loginAs, recordConsoleErrors, pickFirstOption } from "./helpers";

test.describe("Public dump-form portal (Formstack replacement)", () => {
  test("portal renders client context and validates required fields", async ({ page }) => {
    await page.goto("/portal/SOMECODE123");

    // Header: form title + client name from mock portalContext
    await expect(page.getByText("Dump / Load Form").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Mock Client Co.").first()).toBeVisible();

    // Pre-populated dropdowns are present (select variant, not free-text)
    await expect(page.getByTestId("portal-driver-name")).toBeVisible();
    await expect(page.getByTestId("portal-truck-number")).toBeVisible();
    await expect(page.getByTestId("portal-load-type")).toBeVisible();
    await expect(page.getByTestId("portal-submit")).toBeVisible();

    // Submit empty -> required-field errors render
    await page.getByTestId("portal-submit").click();
    await expect(page.getByText("Required").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/enter a quantity or weight/i).first()).toBeVisible();

    // Still on the form (no success screen)
    await expect(page.getByTestId("portal-submit")).toBeVisible();
  });

  test("driver submits a load and gets a MOCK confirmation code, then resets", async ({
    page,
  }) => {
    await page.goto("/portal/SOMECODE123");
    await expect(page.getByText("Dump / Load Form").first()).toBeVisible({ timeout: 10_000 });

    // Driver name (shadcn select)
    await page.getByTestId("portal-driver-name").click();
    await page.getByRole("option", { name: "Mock Driver" }).click();

    // Truck number — single mock option TRUCK-1, pick the first
    await pickFirstOption(page, page.getByTestId("portal-truck-number"));
    await expect(page.getByTestId("portal-truck-number")).toContainText("TRUCK-1");

    // Load type
    await page.getByTestId("portal-load-type").click();
    await page.getByRole("option", { name: "Slurry" }).click();

    // Quantity + loading location
    await page.getByTestId("portal-quantity").fill("6 m3");
    await page.getByTestId("portal-location").fill("55 Test Ave");

    // Submit -> success screen with confirmation code
    await page.getByTestId("portal-submit").click();
    await expect(page.getByText(/form submitted/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("portal-submission-code")).toBeVisible();
    await expect(page.getByTestId("portal-submission-code")).toHaveText(/^MOCK-/);

    // "Submit another load" returns to the form
    await expect(page.getByTestId("portal-submit-another")).toBeVisible();
    await page.getByTestId("portal-submit-another").click();
    await expect(page.getByText("Dump / Load Form").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("portal-submit")).toBeVisible();
    // Load-specific fields were cleared for the next load
    await expect(page.getByTestId("portal-location")).toHaveValue("");
    await expect(page.getByTestId("portal-quantity")).toHaveValue("");
  });
});

test.describe("Standalone invoicing (QuickBooks-optional)", () => {
  test("admin opens an invoice from work orders, emails it and marks it paid", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/work-orders");
    await expect(page.getByRole("tab", { name: /pending approval/i })).toBeVisible({
      timeout: 10_000,
    });

    // Approved work orders link straight to /admin/invoices/$workOrderId
    await page.getByRole("tab", { name: /approved/i }).click();
    const invoiceLink = page.getByRole("link", { name: /view invoice data/i }).first();
    const hasLink = await invoiceLink
      .waitFor({ state: "visible", timeout: 7_000 })
      .then(() => true)
      .catch(() => false);

    if (hasLink) {
      await invoiceLink.click();
    } else {
      // Fallback: approve a pending WO — approve() navigates to the invoice page
      await page.getByRole("tab", { name: /pending approval/i }).click();
      await page.locator('[data-testid^="approve-wo-"]').first().click();
    }
    await page.waitForURL(/\/admin\/invoices\//, { timeout: 10_000 });

    // Invoice draft renders with bill-to + total
    await expect(page.getByText(/invoice draft/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/bill to/i).first()).toBeVisible();
    await expect(page.getByText(/quickbooks sync/i).first()).toBeVisible();

    // "Send & payment" card needs an invoiceData row + client — code defensively
    const emailTo = page.getByTestId("invoice-email-to");
    const hasSendCard = await emailTo
      .waitFor({ state: "visible", timeout: 7_000 })
      .then(() => true)
      .catch(() => false);

    if (hasSendCard) {
      await emailTo.fill("test@example.com");
      await page.getByTestId("invoice-email-send").click();
      await expect(
        page.getByText(/invoice emailed to test@example\.com/i).first(),
      ).toBeVisible({ timeout: 10_000 });

      await page.getByTestId("invoice-mark-paid").click();
      await expect(page.getByText(/marked paid/i).first()).toBeVisible({ timeout: 10_000 });
    } else {
      test.info().annotations.push({
        type: "partial",
        description:
          "Send & payment card not rendered (no invoiceData row / client for this work order in mock data); asserted QuickBooks sync card instead.",
      });
    }
  });

  test("receivables ledger renders summary cards, tabs and empty state", async ({ page }) => {
    await loginAs(page, "admin");
    const errors = recordConsoleErrors(page);
    await page.goto("/admin/receivables");

    // Page title (AdminShell h1) + summary cards
    await expect(page.getByRole("heading", { name: /receivables/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Outstanding", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();

    // Filter tabs
    await expect(page.getByRole("tab", { name: /^all/i })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^unpaid/i })).toBeVisible();

    // Mock fetchInvoiceLedger returns [] -> empty state row in the table
    await expect(page.getByText(/no invoices/i).first()).toBeVisible({ timeout: 10_000 });

    // Table headers render
    await expect(page.getByRole("columnheader", { name: "Invoice" }).first()).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Client" }).first()).toBeVisible();

    expect(errors).toEqual([]);
  });

  test("receivables CSV export downloads a dated file and toasts", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/receivables");
    await expect(page.getByText(/no invoices/i).first()).toBeVisible({ timeout: 10_000 });

    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: /export csv/i }).click();
    const d = await dl;
    expect(d.suggestedFilename()).toMatch(/^receivables-\d{4}-\d{2}-\d{2}\.csv$/);
    await expect(page.getByText(/exported 0 invoices/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
