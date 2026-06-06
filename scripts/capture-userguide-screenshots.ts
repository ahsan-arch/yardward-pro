// Captures full-page screenshots of every major route + interactive states
// across admin/driver/mechanic shells. Run while `npm run dev` is up at
// http://localhost:5173 with VITE_USE_SUPABASE=false (mock mode).
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
  await page.waitForTimeout(waitMs);
  await page.screenshot({
    path: join(OUT_DIR, `${name}.png`),
    fullPage: true,
  });
  console.log(`  ✓ ${name}.png`);
}

interface RouteEntry {
  path: string;
  name: string;
  mobile?: boolean;
  wait?: number;
  // Optional sequence of click+capture actions after the page loads.
  // Each action navigates a single page; multiple actions = multiple shots.
  actions?: Array<{
    name: string;
    click?: string; // CSS selector
    waitFor?: string; // CSS selector to wait for after click
    wait?: number;
    closeAfter?: boolean; // press Escape to close dialog after shot
  }>;
}

async function captureRole(
  ctx: BrowserContext,
  role: Role,
  routes: RouteEntry[],
) {
  await stampRole(ctx, role);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const r of routes) {
    if (r.mobile) await page.setViewportSize({ width: 414, height: 896 });
    else await page.setViewportSize({ width: 1440, height: 900 });
    try {
      console.log(`[${role}] ${r.path}`);
      await page.goto(`${BASE}${r.path}`, {
        waitUntil: "networkidle",
        timeout: 15_000,
      });
      await shot(page, r.name, r.wait ?? 800);
      if (r.actions) {
        for (const a of r.actions) {
          try {
            if (a.click) {
              await page.click(a.click, { timeout: 5000 });
              if (a.waitFor) {
                await page.waitForSelector(a.waitFor, { timeout: 5000 });
              }
              await page.waitForTimeout(a.wait ?? 700);
            }
            await shot(page, a.name);
            if (a.closeAfter) {
              await page.keyboard.press("Escape");
              await page.waitForTimeout(400);
            }
          } catch (e) {
            console.log(
              `    ✗ action ${a.name} — ${e instanceof Error ? e.message.slice(0, 80) : e}`,
            );
          }
        }
      }
    } catch (e) {
      console.log(
        `  ✗ ${r.name} — ${e instanceof Error ? e.message.slice(0, 100) : e}`,
      );
    }
  }
  await page.close();
}

const adminRoutes: RouteEntry[] = [
  { path: "/admin", name: "admin-01-dashboard" },
  {
    path: "/admin/schedule",
    name: "admin-02-schedule",
    actions: [
      {
        name: "admin-02b-create-job-dialog",
        click: '[data-testid="open-create-job"]',
        waitFor: '[role="dialog"]',
        closeAfter: true,
      },
    ],
  },
  { path: "/admin/jobs", name: "admin-03-jobs" },
  {
    path: "/admin/drivers",
    name: "admin-04-drivers",
    actions: [
      {
        name: "admin-04b-add-driver-dialog",
        click: '[data-testid="open-add-driver"]',
        waitFor: '[role="dialog"]',
        closeAfter: true,
      },
    ],
  },
  { path: "/admin/vehicles", name: "admin-05-vehicles" },
  { path: "/admin/map", name: "admin-06-live-map", wait: 1500 },
  { path: "/admin/work-orders", name: "admin-07-work-orders" },
  {
    path: "/admin/communications",
    name: "admin-08-communications",
    actions: [
      {
        name: "admin-08b-new-conversation-dialog",
        click: '[data-testid="open-new-conversation"]',
        waitFor: '[role="dialog"]',
        closeAfter: true,
      },
    ],
  },
  { path: "/admin/timesheets", name: "admin-09-timesheets" },
  { path: "/admin/sms-log", name: "admin-10-sms-log" },
  { path: "/admin/purchase-requests", name: "admin-11-purchase-orders" },
  { path: "/admin/prepaid-tickets", name: "admin-12-prepaid-tickets" },
  {
    path: "/admin/clients",
    name: "admin-13-clients",
    actions: [
      {
        name: "admin-13b-new-client-dialog",
        click: 'button:has-text("New client")',
        waitFor: '[role="dialog"]',
        closeAfter: true,
      },
    ],
  },
  { path: "/admin/forms", name: "admin-14-forms" },
  { path: "/admin/tenders", name: "admin-15-tenders" },
  { path: "/admin/errors", name: "admin-16-errors" },
  { path: "/admin/reports", name: "admin-17-reports" },
  // Settings — capture multiple tabs
  { path: "/admin/settings", name: "admin-18-settings-org" },
  {
    path: "/admin/settings",
    name: "admin-18b-settings-system",
    actions: [
      {
        name: "admin-18c-settings-integrations",
        click: '[role="tab"]:has-text("Integrations")',
        wait: 700,
      },
      {
        name: "admin-18d-settings-users",
        click: '[role="tab"]:has-text("Users")',
        wait: 700,
      },
      {
        name: "admin-18e-settings-notifications",
        click: '[role="tab"]:has-text("Notifications")',
        wait: 700,
      },
      {
        name: "admin-18f-settings-billing",
        click: '[role="tab"]:has-text("Billing")',
        wait: 700,
      },
    ],
  },
];

const driverRoutes: RouteEntry[] = [
  { path: "/driver", name: "driver-01-home", mobile: true },
  { path: "/driver/jobs", name: "driver-02-jobs", mobile: true },
  { path: "/driver/forms", name: "driver-03-forms", mobile: true },
  { path: "/driver/start-of-day", name: "driver-04-start-of-day", mobile: true },
  {
    path: "/driver/tool-checklist",
    name: "driver-05-tool-checklist",
    mobile: true,
  },
  { path: "/driver/inspection", name: "driver-06-inspection", mobile: true },
  { path: "/driver/job-log", name: "driver-07-job-log", mobile: true },
  { path: "/driver/work-order", name: "driver-08-work-order", mobile: true },
  { path: "/driver/end-of-day", name: "driver-09-end-of-day", mobile: true },
  { path: "/driver/tickets", name: "driver-10-tickets", mobile: true },
  { path: "/driver/messages", name: "driver-11-messages", mobile: true },
  { path: "/driver/profile", name: "driver-12-profile", mobile: true },
];

const mechanicRoutes: RouteEntry[] = [
  { path: "/mechanic", name: "mechanic-01-dashboard" },
  { path: "/mechanic/work-orders", name: "mechanic-02-work-orders" },
  { path: "/mechanic/messages", name: "mechanic-03-messages" },
  { path: "/mechanic/purchase-requests", name: "mechanic-04-purchase-requests" },
  { path: "/mechanic/maintenance", name: "mechanic-05-maintenance" },
  { path: "/mechanic/inventory", name: "mechanic-06-inventory" },
];

const publicRoutes: RouteEntry[] = [
  {
    path: "/login",
    name: "public-01-login",
    actions: [
      {
        name: "public-02-forgot-password",
        click: '[data-testid="forgot-password-toggle"]',
        wait: 500,
      },
    ],
  },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  console.log("Capturing screenshots — this takes ~3 minutes");

  {
    const ctx = await browser.newContext();
    await captureRole(ctx, "admin", publicRoutes); // role doesn't matter for /login
    await ctx.close();
  }

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
