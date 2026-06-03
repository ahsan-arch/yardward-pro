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
  BarChart2,
  Settings,
  Menu,
  X,
  Clock,
  ShoppingCart,
  MessageSquare,
  MapPin,
  Ticket,
  Bug,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useApp } from "@/contexts/AppContext";
import { NotificationsBell } from "@/components/crm/NotificationsBell";

const navItems = [
  { to: "/admin", label: "Dashboard", icon: Home, exact: true },
  { to: "/admin/schedule", label: "Schedule", icon: Calendar },
  { to: "/admin/jobs", label: "Jobs", icon: Briefcase },
  { to: "/admin/drivers", label: "Drivers", icon: Users },
  { to: "/admin/vehicles", label: "Vehicles", icon: Truck },
  { to: "/admin/map", label: "Live map", icon: MapPin },
  { to: "/admin/work-orders", label: "Work Orders", icon: ClipboardCheck },
  { to: "/admin/timesheets", label: "Timesheets", icon: Clock },
  { to: "/admin/sms-log", label: "SMS log", icon: MessageSquare },
  { to: "/admin/purchase-requests", label: "Purchase Orders", icon: ShoppingCart },
  { to: "/admin/prepaid-tickets", label: "Prepaid tickets", icon: Ticket },
  { to: "/admin/clients", label: "Clients", icon: Building2 },
  { to: "/admin/forms", label: "Forms & Submissions", icon: FileText },
  { to: "/admin/errors", label: "Error log", icon: Bug },
  { to: "/admin/reports", label: "Reports", icon: BarChart2 },
  { to: "/admin/settings", label: "Settings", icon: Settings },
];

export function AdminShell({ children, title }: { children?: ReactNode; title?: string }) {
  const [open, setOpen] = useState(false);
  const { user } = useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex min-h-[calc(100vh-44px)] bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed lg:static inset-y-0 left-0 top-11 lg:top-0 z-40 w-60 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col transition-transform",
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className="h-16 px-5 flex items-center gap-2 border-b border-sidebar-border">
          <div className="w-8 h-8 rounded-md bg-amber-brand grid place-items-center">
            <Truck className="w-4 h-4 text-amber-brand-foreground" />
          </div>
          <div>
            <div className="font-bold text-sm tracking-tight">FleetOps CRM</div>
            <div className="text-[10px] font-mono text-sidebar-foreground/50">v1.0</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {navItems.map((item) => {
            const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
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
                Wed · 14 May 2025
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
