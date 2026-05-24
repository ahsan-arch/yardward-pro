import { Page, expect } from "@playwright/test";

export type Role = "admin" | "driver" | "mechanic";

const PRESET: Record<Role, { email: string; dashboard: string; label: string }> = {
  admin: { email: "alex@fleetops.co", dashboard: "/admin", label: "Admin" },
  driver: { email: "tom@fleetops.co", dashboard: "/driver", label: "Driver" },
  mechanic: { email: "jamie@fleetops.co", dashboard: "/mechanic", label: "Mechanic" },
};

export async function loginAs(page: Page, role: Role) {
  const preset = PRESET[role];
  await page.goto("/login");
  // Wait for the form to render before clicking
  await page.locator("#password").waitFor({ state: "visible" });
  await page.getByRole("button", { name: preset.label, exact: false }).first().click();
  // Password is pre-populated to "demo1234" — only refill if cleared
  const pwd = page.locator("#password");
  const current = await pwd.inputValue().catch(() => "");
  if (current.length < 6) {
    await pwd.fill("demo1234");
  }
  await page.getByRole("button", { name: /sign in to fleetops/i }).click();
  await page.waitForURL((url) => url.pathname.startsWith(preset.dashboard), { timeout: 15_000 });
  return preset;
}

export function recordConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // Ignore React DevTools download nag + benign hydration warnings
      if (text.includes("React DevTools")) return;
      errors.push(`[${page.url()}] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`[${page.url()}] ${err.message}`);
  });
  return errors;
}

export async function assertGpsBadgeNeverErrors(page: Page) {
  // GPS badge should land on "real" or "fallback" — never the red error state
  await expect(page.locator('[data-testid="gps-badge"]')).toBeVisible();
  const state = await page.locator('[data-testid="gps-badge"]').getAttribute("data-gps-state");
  expect(["loading", "real", "fallback"]).toContain(state ?? "");
}
