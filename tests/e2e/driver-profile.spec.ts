import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Driver profile", () => {
  test.beforeEach(async ({ page }) => {
    await authedAs(page, "driver");
    await page.goto("/driver/profile");
  });

  test("profile card renders with name + license", async ({ page }) => {
    await expect(page.locator("text=/Tom Morrison|HR-A/").first()).toBeVisible();
  });

  test("My shift card present", async ({ page }) => {
    await expect(page.locator("text=/my shift/i")).toBeVisible();
  });

  test("action rows present (password, notifications, help, logout)", async ({ page }) => {
    await expect(page.getByRole("button", { name: /change password/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /notifications/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /help|support/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /logout/i })).toBeVisible();
  });

  test("logout navigates to login", async ({ page }) => {
    await page.getByRole("button", { name: /logout/i }).click();
    await page.waitForURL(/\/login/, { timeout: 5_000 });
  });
});
