import { test, expect, type Download } from "@playwright/test";
import { loginAs } from "./helpers";

// New admin features (external-app replacement), exercised in mock mode
// (VITE_USE_SUPABASE=false): list fetches return empty sets and mutations
// return instant mock successes. These tests assert rendering, empty states,
// validation, navigation and toasts — never server-persisted data.

test.describe("Admin: hauling records", () => {
  test("Formstack tab renders toolbar; App entries tab shows empty state + internal notifications save", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/hauling-records");

    // Both tabs render
    await expect(page.getByTestId("hauling-tab-formstack")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("hauling-tab-app")).toBeVisible();

    // Formstack tab (default) toolbar
    await expect(page.getByTestId("hauling-search")).toBeVisible();
    await expect(page.getByTestId("hauling-form-filter")).toBeVisible();
    await expect(page.getByTestId("hauling-dry-run")).toBeVisible();
    await expect(page.getByTestId("hauling-sync")).toBeVisible();
    await expect(page.getByTestId("hauling-export-formstack")).toBeVisible();
    // Mock fetch returns no rows -> empty state
    await expect(page.getByText(/no hauling records yet/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Switch to App entries
    await page.getByTestId("hauling-tab-app").click();
    await expect(page.getByText(/no app-submitted hauling records yet/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("hauling-export-app")).toBeVisible();

    // Internal notifications card (textareas appear once settings load)
    await expect(page.getByText(/internal notifications/i).first()).toBeVisible({
      timeout: 10_000,
    });
    const sms = page.getByTestId("internal-notify-sms");
    const emails = page.getByTestId("internal-notify-emails");
    await expect(sms).toBeVisible({ timeout: 10_000 });
    await expect(emails).toBeVisible();
    await sms.fill("+14165550100");
    await emails.fill("yard@example.com");
    await page.getByTestId("internal-notify-save").click();
    await expect(
      page.getByText(/internal notification recipients saved/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Admin: form templates", () => {
  test("new template dialog validates empty name then saves with mock success", async ({
    page,
  }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/form-templates");

    await expect(page.getByTestId("ft-tab-templates")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("ft-tab-submissions")).toBeVisible();

    // Open the editor dialog
    await page.getByTestId("ft-new").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Saving with an empty name -> validation toast
    await page.getByTestId("ft-save").click();
    await expect(page.getByText(/template needs a name/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Fill name + first field label, add a second field and label it too
    // (every field needs a label before save passes validation).
    await page.getByTestId("ft-name").fill("E2E Test Template");
    await page.getByTestId("ft-field-label-0").fill("Notes");
    await page.getByTestId("ft-add-field").click();
    await expect(page.getByTestId("ft-field-label-1")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("ft-field-label-1").fill("Severity");

    await page.getByTestId("ft-save").click();
    await expect(page.getByText(/template saved/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("submissions tab renders an empty table in mock mode", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/form-templates");

    await page.getByTestId("ft-tab-submissions").click();
    // Table headers + mock-mode empty state
    await expect(page.getByRole("columnheader", { name: /form/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/no submissions yet/i).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Admin: settings — QuickBooks employee mapping", () => {
  test("load employees from QuickBooks and map a driver by name", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/settings");
    await page.getByRole("tab", { name: /integrations/i }).click();

    // Mapping card visible
    await expect(page.getByText(/quickbooks employee mapping/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Load the mock employee list
    await page.getByTestId("load-qbo-employees").click();
    await expect(page.getByText(/loaded 2 quickbooks employees/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Driver row now shows a Select — pick Mock Employee A for D-01
    const select = page.getByTestId("qbo-employee-select-D-01");
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.click();
    await page.getByRole("option", { name: "Mock Employee A" }).click();

    // Save mappings — mock upsert succeeds
    const save = page.getByTestId("save-qbo-mappings");
    await expect(save).toBeVisible();
    await save.click();
    await expect(page.getByText(/saved 1 mapping/i).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Admin: settings — invite user dialog", () => {
  test("send-invite-email toggle switches the submit button label", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/settings");
    await page.getByRole("tab", { name: /users & roles/i }).click();

    await page.getByTestId("open-invite-user").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const submit = page.getByTestId("submit-invite-user");
    const toggle = page.getByTestId("invite-send-email-toggle");

    // Default ON -> "Create user & send invite"
    await expect(submit).toContainText(/create user & send invite/i, { timeout: 10_000 });

    // Toggle OFF -> plain "Create user"
    await toggle.click();
    await expect(submit).not.toContainText(/send invite/i);
    await expect(submit).toContainText(/create user/i);

    // Toggle back ON -> label restored. Do NOT submit.
    await toggle.click();
    await expect(submit).toContainText(/create user & send invite/i);
    await page.keyboard.press("Escape");
  });
});

test.describe("Admin: timesheets payroll export", () => {
  test("Payroll CSV downloads a file or reports no completed shifts", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/timesheets");

    const btn = page.getByTestId("export-payroll-csv-btn");
    await expect(btn).toBeVisible({ timeout: 10_000 });

    // Either path emits a toast; the success path also fires a download.
    const downloads: Download[] = [];
    page.on("download", (d) => downloads.push(d));
    await btn.click();

    await expect(
      page.getByText(/payroll export:|no completed shifts to export/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    if (downloads.length > 0) {
      expect(downloads[0].suggestedFilename()).toMatch(/^payroll-.*\.csv$/i);
    }
  });
});

test.describe("Admin: clients — dump-form portal", () => {
  test("portal lists save and a new access code is created", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/admin/clients");

    // Open the first client row -> detail sheet
    await page.locator("tbody tr").first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/dump-form portal/i).first()).toBeVisible({ timeout: 10_000 });

    // Editor textareas appear once the mock lists load
    const driversList = page.getByTestId("portal-drivers-list");
    await expect(driversList).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("portal-trucks-list")).toBeVisible();
    await expect(page.getByTestId("portal-notify-sms")).toBeVisible();
    await expect(page.getByTestId("portal-notify-emails")).toBeVisible();

    await driversList.fill("John Smith\nMike Jones");
    await page.getByTestId("portal-trucks-list").fill("TRK-101");
    await page.getByTestId("portal-notify-sms").fill("+14165550100");
    await page.getByTestId("portal-notify-emails").fill("gate@client.com");
    await page.getByTestId("portal-save-lists").click();
    await expect(page.getByText(/portal settings saved/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Create an access code — mock returns MOCKCODE-1234
    await page.getByTestId("portal-new-code-label").fill("Test Employee");
    await page.getByTestId("portal-create-code").click();
    await expect(page.getByText(/code created/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
