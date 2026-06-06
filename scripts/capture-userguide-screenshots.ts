// Captures full-page screenshots of every major route across admin/driver/
// mechanic shells. Run while `npm run dev` is up at http://localhost:5173.
// Output: docs/screenshots/<filename>.png
//
// Usage: npx tsx scripts/capture-userguide-screenshots.ts

import { chromium, type Page, type BrowserContext } from "playwright";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = "http://localhost:5173";
const OUT_DIR = join(process.cwd(), "docs", "screenshots");
mkdirSync(OUT_DIR, { recursive: true });

type Role = "admin" | "driver" | "mechanic";

async function stampRole(ctx: BrowserContext, role: Role) {
  await ctx.addInitScript((r) => {
    localStorage.setItem("fo:authed", "1");
    localStorage.setItem("fo:role", r);
  }, role);
}

async function shot(page: Page, name: string, waitMs = 800) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(waitMs); // allow framer-motion / mock fetches
  await page.screenshot({
    path: join(OUT_DIR, `${name}.png`),
    fullPage: true,
  });
  console.log(`  ✓ ${name}.png`);
}

async function captureRole(
  ctx: BrowserContext,
  role: Role,
  routes: Array<{ path: string; name: string; mobile?: boolean; wait?: number }>,
) {
  await stampRole(ctx, role);
  const page = await ctx.newPage();
  // Default desktop viewport; per-route mobile override below.
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const r of routes) {
    if (r.mobile) await page.setViewportSize({ width: 414, height: 896 });
    else await page.setViewportSize({ width: 1440, height: 900 });
    try {
      console.log(`[${role}] ${r.path}`);
      await page.goto(`${BASE}${r.path}`, { waitUntil: "networkidle", timeout: 15_000 });
      await shot(page, r.name, r.wait ?? 800);
    } catch (e) {
      console.log(`  ✗ ${r.name} — ${e instanceof Error ? e.message.slice(0, 100) : e}`);
    }
  }
  await page.close();
}

const adminRoutes = [
  { path: "/admin", name: "admin-01-dashboard" },
  { path: "/admin/schedule", name: "admin-02-schedule" },
  { path: "/admin/jobs", name: "admin-03-jobs" },
  { path: "/admin/drivers", name: "admin-04-drivers" },
  { path: "/admin/vehicles", name: "admin-05-vehicles" },
  { path: "/admin/map", name: "admin-06-live-map", wait: 1500 },
  { path: "/admin/work-orders", name: "admin-07-work-orders" },
  { path: "/admin/communications", name: "admin-08-communications" },
  { path: "/admin/timesheets", name: "admin-09-timesheets" },
  { path: "/admin/sms-log", name: "admin-10-sms-log" },
  { path: "/admin/purchase-requests", name: "admin-11-purchase-orders" },
  { path: "/admin/prepaid-tickets", name: "admin-12-prepaid-tickets" },
  { path: "/admin/clients", name: "admin-13-clients" },
  { path: "/admin/forms", name: "admin-14-forms" },
  { path: "/admin/tenders", name: "admin-15-tenders" },
  { path: "/admin/errors", name: "admin-16-errors" },
  { path: "/admin/reports", name: "admin-17-reports" },
  { path: "/admin/settings", name: "admin-18-settings" },
];

const driverRoutes = [
  { path: "/driver", name: "driver-01-home", mobile: true },
  { path: "/driver/jobs", name: "driver-02-jobs", mobile: true },
  { path: "/driver/forms", name: "driver-03-forms", mobile: true },
  { path: "/driver/start-of-day", name: "driver-04-start-of-day", mobile: true },
  { path: "/driver/tool-checklist", name: "driver-05-tool-checklist", mobile: true },
  { path: "/driver/inspection", name: "driver-06-inspection", mobile: true },
  { path: "/driver/job-log", name: "driver-07-job-log", mobile: true },
  { path: "/driver/work-order", name: "driver-08-work-order", mobile: true },
  { path: "/driver/end-of-day", name: "driver-09-end-of-day", mobile: true },
  { path: "/driver/tickets", name: "driver-10-tickets", mobile: true },
  { path: "/driver/messages", name: "driver-11-messages", mobile: true },
  { path: "/driver/profile", name: "driver-12-profile", mobile: true },
];

const mechanicRoutes = [
  { path: "/mechanic", name: "mechanic-01-dashboard" },
  { path: "/mechanic/work-orders", name: "mechanic-02-work-orders" },
  { path: "/mechanic/messages", name: "mechanic-03-messages" },
  { path: "/mechanic/purchase-requests", name: "mechanic-04-purchase-requests" },
  { path: "/mechanic/maintenance", name: "mechanic-05-maintenance" },
  { path: "/mechanic/inventory", name: "mechanic-06-inventory" },
];

const publicRoutes = [
  { path: "/login", name: "public-01-login" },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  console.log("Capturing screenshots — this takes ~2 minutes");

  // Public (no auth)
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const r of publicRoutes) {
      console.log(`[public] ${r.path}`);
      await page.goto(`${BASE}${r.path}`, { waitUntil: "networkidle", timeout: 15_000 });
      await shot(page, r.name);
    }
    await ctx.close();
  }

  // Each role gets its own context (cleanly isolated localStorage)
  for (const [role, routes] of [
    ["admin", adminRoutes] as const,
    ["driver", driverRoutes] as const,
    ["mechanic", mechanicRoutes] as const,
  ]) {
    const ctx = await browser.newContext();
    await captureRole(ctx, role, routes);
    await ctx.close();
  }

  await browser.close();
  console.log("Done. Screenshots in", OUT_DIR);
})();
