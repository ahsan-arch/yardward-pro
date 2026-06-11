import { Page, expect, Locator } from "@playwright/test";

export type Role = "admin" | "driver" | "mechanic";

const PRESET: Record<Role, { email: string; dashboard: string; label: string }> = {
  admin: { email: "alex@fleetops.co", dashboard: "/admin", label: "Admin" },
  driver: { email: "tom@fleetops.co", dashboard: "/driver", label: "Driver" },
  mechanic: { email: "jamie@fleetops.co", dashboard: "/mechanic", label: "Mechanic" },
};

export async function loginAs(page: Page, role: Role) {
  const preset = PRESET[role];
  await page.goto("/login");
  await page.locator("#password").waitFor({ state: "visible" });
  await page.getByRole("button", { name: preset.label, exact: false }).first().click();
  const pwd = page.locator("#password");
  const current = await pwd.inputValue().catch(() => "");
  if (current.length < 6) {
    await pwd.fill("demo1234");
  }
  // Match any brand name ("Sign in to Yardward Pro" today, formerly
  // "...FleetOps") so a rebrand doesn't silently break every login test.
  await page.getByRole("button", { name: /^sign in to /i }).click();
  await page.waitForURL((url) => url.pathname.startsWith(preset.dashboard), { timeout: 15_000 });
  return preset;
}

/** Mark the browser as authed without going through the login form. */
export async function authedAs(page: Page, role: Role) {
  await page.addInitScript((r) => {
    localStorage.setItem("fo:authed", "1");
    localStorage.setItem("fo:role", r);
  }, role);
}

export function recordConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (text.includes("React DevTools")) return;
      if (text.includes("[vite] connect")) return; // dev HMR chatter
      errors.push(`[${page.url()}] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    errors.push(`[${page.url()}] ${err.message}`);
  });
  return errors;
}

export function recordNetworkErrors(page: Page) {
  const errors: string[] = [];
  page.on("response", (resp) => {
    const status = resp.status();
    const url = resp.url();
    // Ignore third-party stuff (fonts, telemetry)
    if (!url.includes(new URL(page.url() || "http://localhost").host)) return;
    // Vite/Vercel dev-time stuff
    if (url.includes("/.well-known/") || url.includes("/_vercel/")) return;
    if (status >= 400 && status !== 404) {
      // 404 on favicon/sourcemaps is noisy and not actionable
      if (url.endsWith(".map") || url.endsWith("favicon.ico")) return;
      errors.push(`${status} ${url}`);
    }
  });
  return errors;
}

export async function assertGpsBadgeNeverErrors(page: Page) {
  await expect(page.locator('[data-testid="gps-badge"]')).toBeVisible();
  const state = await page.locator('[data-testid="gps-badge"]').getAttribute("data-gps-state");
  expect(["loading", "real", "fallback"]).toContain(state ?? "");
}

/** Wait for the GPS badge to settle (real or fallback) and assert no red error. */
export async function awaitGpsSettled(page: Page) {
  const badge = page.locator('[data-testid="gps-badge"]').first();
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => await badge.getAttribute("data-gps-state"), { timeout: 12_000 })
    .toMatch(/^(real|fallback)$/);
}

/** Pick the first option from a shadcn Select bound to a given trigger. */
export async function pickFirstOption(page: Page, trigger: Locator) {
  await trigger.click();
  await page.getByRole("option").first().click();
}
