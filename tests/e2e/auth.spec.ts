import { test, expect } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe("auth", () => {
  test("admin login lands on /admin", async ({ page }) => {
    await loginAs(page, "admin");
    await expect(page).toHaveURL(/\/admin/);
  });

  test("driver login lands on /driver", async ({ page }) => {
    await loginAs(page, "driver");
    await expect(page).toHaveURL(/\/driver/);
  });

  test("mechanic login lands on /mechanic", async ({ page }) => {
    await loginAs(page, "mechanic");
    await expect(page).toHaveURL(/\/mechanic/);
  });

  test("unauthed visit to /admin redirects to /login", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/admin");
    await page.waitForURL(/\/login/, { timeout: 5_000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
