// Canonical admin tab keys + route mapping for the owner/custom-roles access
// system. This module is the single source of truth for WHICH tabs exist —
// the DB stores plain text[] of these keys (no CHECK constraint), so unknown
// keys coming back from the DB are simply ignored at resolution time here.
//
// Effective access resolution (mirrored by is_owner()/triggers server-side):
//   is_owner            -> ALL tabs
//   allowed_tabs_override (not null) -> exactly that set (replaces the role)
//   admin_roles.allowed_tabs         -> the named role's set
//   neither             -> ALL tabs (backward compat: untouched admins lose nothing)

export type AdminTabKey =
  | "dashboard"
  | "schedule"
  | "jobs"
  | "drivers"
  | "vehicles"
  | "map"
  | "work-orders"
  | "communications"
  | "timesheets"
  | "sms-log"
  | "purchase-orders"
  | "inventory"
  | "prepaid-tickets"
  | "clients"
  | "receivables"
  | "reports"
  | "forms"
  | "hauling-records"
  | "form-templates"
  | "errors"
  | "settings";

export type AllowedTabs = "all" | AdminTabKey[];

export type AdminTabGroup = "Operations" | "Financial" | "Admin";

// Nav order — firstAllowedAdminPath walks this list, so it doubles as the
// "where do I land when my current tab is denied" priority order.
export const ADMIN_TABS: ReadonlyArray<{
  key: AdminTabKey;
  label: string;
  path: string;
  group: AdminTabGroup;
}> = [
  { key: "dashboard", label: "Dashboard", path: "/admin", group: "Operations" },
  { key: "schedule", label: "Schedule", path: "/admin/schedule", group: "Operations" },
  { key: "jobs", label: "Jobs", path: "/admin/jobs", group: "Operations" },
  { key: "drivers", label: "Drivers", path: "/admin/drivers", group: "Operations" },
  { key: "vehicles", label: "Vehicles", path: "/admin/vehicles", group: "Operations" },
  { key: "map", label: "Live map", path: "/admin/map", group: "Operations" },
  { key: "work-orders", label: "Work Orders", path: "/admin/work-orders", group: "Operations" },
  { key: "communications", label: "Communications", path: "/admin/communications", group: "Operations" },
  { key: "timesheets", label: "Timesheets", path: "/admin/timesheets", group: "Operations" },
  { key: "sms-log", label: "SMS log", path: "/admin/sms-log", group: "Operations" },
  { key: "purchase-orders", label: "Purchase Orders", path: "/admin/purchase-requests", group: "Financial" },
  { key: "inventory", label: "Inventory", path: "/admin/inventory", group: "Financial" },
  { key: "prepaid-tickets", label: "Prepaid tickets", path: "/admin/prepaid-tickets", group: "Financial" },
  { key: "clients", label: "Clients", path: "/admin/clients", group: "Financial" },
  { key: "receivables", label: "Receivables", path: "/admin/receivables", group: "Financial" },
  { key: "reports", label: "Reports", path: "/admin/reports", group: "Financial" },
  { key: "forms", label: "Forms & Submissions", path: "/admin/forms", group: "Admin" },
  { key: "hauling-records", label: "Hauling records", path: "/admin/hauling-records", group: "Admin" },
  { key: "form-templates", label: "Form templates", path: "/admin/form-templates", group: "Admin" },
  { key: "errors", label: "Error log", path: "/admin/errors", group: "Admin" },
  { key: "settings", label: "Settings", path: "/admin/settings", group: "Admin" },
];

const TAB_KEY_SET = new Set<string>(ADMIN_TABS.map((t) => t.key));

// Routes that exist under /admin but are NOT sidebar items. They still must
// be guarded (hiding nav items alone doesn't block direct URLs):
//  - /admin/invoices/$workOrderId is a financial drill-in -> receivables
//    (gating it under work-orders would leak dollar amounts to a
//    "no financials" manager)
//  - /admin/tickets feeds prepaid debits -> prepaid-tickets
//  - /admin/tenders is job acquisition -> jobs
//  - /admin/qbo-callback is the QuickBooks OAuth round-trip -> never guarded
//    (bouncing it would break the OAuth flow mid-handshake)
const EXTRA_ROUTE_TABS: ReadonlyArray<{ prefix: string; tab: AdminTabKey }> = [
  { prefix: "/admin/invoices", tab: "receivables" },
  { prefix: "/admin/tickets", tab: "prepaid-tickets" },
  { prefix: "/admin/tenders", tab: "jobs" },
];

// Tab key governing an /admin/* pathname, or null when the path is exempt
// from tab-guarding (qbo-callback, unknown future routes — fail open; the
// guard is UX, the server protects the assignment data itself).
export function tabForAdminPath(pathname: string): AdminTabKey | null {
  if (pathname === "/admin" || pathname === "/admin/") return "dashboard";
  if (pathname.startsWith("/admin/qbo-callback")) return null;
  for (const { prefix, tab } of EXTRA_ROUTE_TABS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return tab;
  }
  // Longest-prefix isn't needed: sidebar paths never nest inside each other,
  // so a simple prefix scan is unambiguous (same reasoning as
  // isPathAllowedForScope in use-driver-token-scope.ts).
  for (const { key, path } of ADMIN_TABS) {
    if (path === "/admin") continue; // dashboard handled exact-only above
    if (pathname === path || pathname.startsWith(`${path}/`)) return key;
  }
  return null;
}

// Compute the effective tab set from the three DB fields. Unknown keys are
// dropped; a known-but-empty result normalizes to ["dashboard"] so a
// misconfigured account can still land somewhere instead of redirect-looping.
export function resolveAllowedTabs(input: {
  isOwner: boolean;
  override: string[] | null;
  roleTabs: string[] | null;
}): AllowedTabs {
  if (input.isOwner) return "all";
  const source = input.override ?? input.roleTabs;
  if (source === null || source === undefined) return "all";
  const tabs = source.filter((k): k is AdminTabKey => TAB_KEY_SET.has(k));
  return tabs.length > 0 ? tabs : ["dashboard"];
}

export function isTabAllowed(allowed: AllowedTabs, tab: AdminTabKey): boolean {
  return allowed === "all" || allowed.includes(tab);
}

// First allowed path in nav order. Guaranteed non-looping: the returned
// path's own tab is in the allowed set. Falls back to /admin (dashboard) if
// the set somehow contains no known key — resolveAllowedTabs prevents that.
export function firstAllowedAdminPath(allowed: AllowedTabs): string {
  if (allowed === "all") return "/admin";
  for (const { key, path } of ADMIN_TABS) {
    if (allowed.includes(key)) return path;
  }
  return "/admin";
}

// localStorage bridge for the synchronous route guard in /admin's beforeLoad
// (same pattern as the fo:authed / fo:role flags). Missing or corrupt data
// fails OPEN to "all" — the client guard is a UX layer; server triggers/RLS
// protect the permission data, and phase 2 will protect financial data.
export const ADMIN_TABS_STORAGE_KEY = "fo:admin-tabs";

export function readStoredAdminTabs(): AllowedTabs {
  if (typeof window === "undefined") return "all";
  try {
    const raw = window.localStorage.getItem(ADMIN_TABS_STORAGE_KEY);
    if (!raw || raw === "all") return "all";
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return "all";
    const tabs = parsed.filter((k): k is AdminTabKey => typeof k === "string" && TAB_KEY_SET.has(k));
    return tabs.length > 0 ? tabs : ["dashboard"];
  } catch {
    return "all";
  }
}

export function writeStoredAdminTabs(allowed: AllowedTabs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      ADMIN_TABS_STORAGE_KEY,
      allowed === "all" ? "all" : JSON.stringify(allowed),
    );
  } catch {
    /* ignore — guard falls back to "all" */
  }
}

export function clearStoredAdminTabs(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ADMIN_TABS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
