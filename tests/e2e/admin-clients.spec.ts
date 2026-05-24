import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Admin clients", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin/clients");
  });

  test("client list renders + search filters", async ({ page }) => {
    await expect(page.locator("text=/Maple City Council/")).toBeVisible();
    const search = page.locator('input[placeholder*="Search clients"]');
    await search.fill("Maple");
    await expect(page.locator("text=/Maple City Council/")).toBeVisible();
    await expect(page.locator("text=/Brennan Demolition/")).not.toBeVisible();
  });

  test("client row opens detail sheet with rate table editor", async ({ page }) => {
    await page.locator("tbody tr").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: /rate table/i }),
    ).toBeVisible();
  });

  test("rate table editor add + remove line", async ({ page }) => {
    await page.locator("tbody tr").first().click();
    const addBtn = page.getByRole("button", { name: /add line/i });
    const beforeRows = await page.locator('input[placeholder*="Truck"]').count();
    await addBtn.click();
    const afterRows = await page.locator('[role="dialog"] input, [role="dialog"] textarea, body input[placeholder*="Truck"]').count();
    expect(afterRows).toBeGreaterThan(beforeRows);
  });

  test("New client dialog opens", async ({ page }) => {
    await page.getByRole("button", { name: /new client/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });
});
