import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Home,
  Calendar,
  Briefcase,
  Users,
  Truck,
  ClipboardCheck,
  Building2,
  FileText,
  FileSpreadsheet,
  BarChart2,
  Settings,
  Menu,
  X,
  Clock,
  ShoppingCart,
  MessageSquare,
  MessagesSquare,
  Package,
  MapPin,
  Ticket,
  Bug,
  ChevronDown,
  ListChecks,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/crm/BrandMark";
import { useApp } from "@/contexts/AppContext";
import { NotificationsBell } from "@/components/crm/NotificationsBell";
import { ADMIN_TABS, type AdminTabGroup, type AdminTabKey } from "@/lib/admin-tabs";

// Icons keyed by the canonical tab list in admin-tabs.ts, which is also the
// source of truth for labels/paths/grouping (shared with the role-permission
// editor in admin.settings.tsx) — one place to add a tab instead of two.
const TAB_ICONS: Record<AdminTabKey, typeof Home> = {
  dashboard: Home,
  schedule: Calendar,
  jobs: Briefcase,
  drivers: Users,
  vehicles: Truck,
  inspections: ListChecks,
  map: MapPin,
  "work-orders": ClipboardCheck,
  communications: MessagesSquare,
  timesheets: Clock,
  "sms-log": MessageSquare,
  "purchase-orders": ShoppingCart,
  inventory: Package,
  "prepaid-tickets": Ticket,
  clients: Building2,
  receivables: BarChart2,
  forms: FileText,
  "hauling-records": FileSpreadsheet,
  "form-templates": ClipboardCheck,
  errors: Bug,
  reports: BarChart2,
  settings: Settings,
};

// Same group order as the TabChecklist in admin.settings.tsx, so the sidebar
// and the permission editor agree on what "grouped like the sidebar" means.
const NAV_GROUPS: AdminTabGroup[] = ["Operations", "Financial", "Admin"];

const navItems = ADMIN_TABS.map((t) => ({
  to: t.path,
  label: t.label,
  icon: TAB_ICONS[t.key],
  exact: t.path === "/admin",
  tab: t.key,
  group: t.group,
}));

// Collapsed-group prefs persist per browser (not per-admin — this is just a
// UI convenience, same trust level as theme). Client feedback asked for
// "sub-menus", not just visual grouping — collapsing/expanding a section is
// what makes the group header actually behave like a sub-menu trigger
// rather than a static label.
const NAV_COLLAPSE_STORAGE_KEY = "fo:admin-nav-collapsed";

function readCollapsedGroups(): Set<AdminTabGroup> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(NAV_COLLAPSE_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((g): g is AdminTabGroup => NAV_GROUPS.includes(g)));
  } catch {
    return new Set();
  }
}

export function AdminShell({ children, title }: { children?: ReactNode; title?: string }) {
  const [open, setOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<AdminTabGroup>>(readCollapsedGroups);
  const { user, allowedTabs } = useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Owner/custom-roles tab filtering. "all" (owners, unrestricted admins,
  // and any state where permission data is unavailable) keeps every item.
  const visibleItems =
    allowedTabs === "all" ? navItems : navItems.filter((item) => allowedTabs.includes(item.tab));
  const activeGroup = visibleItems.find((item) =>
    item.exact ? pathname === item.to : pathname.startsWith(item.to),
  )?.group;

  function toggleGroup(group: AdminTabGroup) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      try {
        window.localStorage.setItem(NAV_COLLAPSE_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore — collapse state just won't persist across reloads */
      }
      return next;
    });
  }

  return (
    <div className="flex min-h-[calc(100vh-44px)] bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed lg:sticky left-0 top-11 bottom-0 lg:bottom-auto lg:h-[calc(100vh-44px)] lg:self-start z-40 w-60 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col transition-transform",
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className="h-16 px-5 flex items-center gap-2 border-b border-sidebar-border">
          <BrandMark />
          <div>
            <div className="font-bold text-sm tracking-tight">Engage Hydrovac CRM</div>
            <div className="text-[10px] font-mono text-sidebar-foreground/50">v1.0</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {NAV_GROUPS.map((group) => {
            const items = visibleItems.filter((item) => item.group === group);
            if (items.length === 0) return null;
            // A group holding the current page always renders expanded,
            // regardless of stored collapse state — navigating must never
            // hide the link you're already on.
            const expanded = group === activeGroup || !collapsedGroups.has(group);
            return (
              <div key={group} className="mb-3 last:mb-0">
                <button
                  type="button"
                  onClick={() => toggleGroup(group)}
                  className="w-full flex items-center justify-between px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40 hover:text-sidebar-foreground/70"
                >
                  <span>{group}</span>
                  <ChevronDown
                    className={cn("w-3 h-3 transition-transform", !expanded && "-rotate-90")}
                  />
                </button>
                {expanded &&
                  items.map((item) => {
                    const active = item.exact
                      ? pathname === item.to
                      : pathname.startsWith(item.to);
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        onClick={() => setOpen(false)}
                        className={cn(
                          "relative flex items-center gap-3 px-3 py-2.5 rounded-md text-sm mb-0.5 transition-colors",
                          active
                            ? "bg-sidebar-accent text-amber-brand font-medium"
                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
                        )}
                      >
                        {active && (
                          <span className="absolute left-0 top-1 bottom-1 w-1 rounded-r bg-amber-brand" />
                        )}
                        <item.icon className="w-4 h-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    );
                  })}
              </div>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-amber-brand text-amber-brand-foreground grid place-items-center text-sm font-bold">
            {user.name
              .split(" ")
              .map((n) => n[0])
              .join("")}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{user.name}</div>
            <div className="text-[10px] uppercase tracking-wider font-mono text-amber-brand">
              Management
            </div>
          </div>
        </div>
      </aside>

      {open && (
        <div
          onClick={() => setOpen(false)}
          className="lg:hidden fixed inset-0 top-11 bg-black/50 z-30"
        />
      )}

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 border-b border-border bg-card flex items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setOpen((v) => !v)}
              className="lg:hidden p-2 -ml-2 rounded-md hover:bg-accent"
            >
              {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
            <div>
              <h1 className="text-lg sm:text-xl font-semibold tracking-tight">
                {title || "Dashboard"}
              </h1>
              <div className="text-xs text-muted-foreground font-mono hidden sm:block">
                {/* Real clock — was a hardcoded demo date until 2026-06. */}
                {new Date().toLocaleDateString("en-CA", {
                  weekday: "short",
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationsBell />
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6 overflow-x-hidden">{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}
