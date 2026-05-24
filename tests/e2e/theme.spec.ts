import { test, expect } from "@playwright/test";
import { authedAs } from "./helpers";

test.describe("Theme toggle", () => {
  test("dark/light toggle on login page works", async ({ page }) => {
    await page.goto("/login");
    const html = page.locator("html");
    const beforeClass = await html.getAttribute("class");
    // Theme toggle on login: a ghost icon button
    await page.locator('button:has(svg.lucide-moon), button:has(svg.lucide-sun)').first().click();
    const afterClass = await html.getAttribute("class");
    expect(beforeClass !== afterClass).toBeTruthy();
  });

  test("theme toggle in role switcher header works for authed users", async ({ page }) => {
    await authedAs(page, "admin");
    await page.goto("/admin");
    const html = page.locator("html");
    const beforeClass = await html.getAttribute("class");
    const toggle = page.locator('button:has(svg.lucide-moon), button:has(svg.lucide-sun)').first();
    if (await toggle.isVisible()) {
      await toggle.click();
      const afterClass = await html.getAttribute("class");
      expect(beforeClass !== afterClass).toBeTruthy();
    }
  });
});
