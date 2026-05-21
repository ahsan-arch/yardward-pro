import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Home, ClipboardCheck, ShoppingCart, Wrench, Package, Menu, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useApp } from "@/contexts/AppContext";

const navItems = [
  { to: "/mechanic", label: "Dashboard", icon: Home, exact: true },
  { to: "/mechanic/work-orders", label: "Work orders assigned to me", icon: ClipboardCheck },
  { to: "/mechanic/purchase-requests", label: "Purchase requests (PO)", icon: ShoppingCart },
  { to: "/mechanic/maintenance", label: "Vehicle maintenance logs", icon: Wrench },
  { to: "/mechanic/inventory", label: "Parts inventory", icon: Package },
];

export function MechanicShell({ children, title }: { children?: ReactNode; title?: string }) {
  const [open, setOpen] = useState(false);
  const { user } = useApp();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="flex min-h-[calc(100vh-44px)] bg-background">
      <aside
        className={cn(
          "fixed lg:static inset-y-0 left-0 top-11 lg:top-0 z-40 w-60 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col transition-transform",
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className="h-16 px-5 flex items-center gap-2 border-b border-sidebar-border">
          <div className="w-8 h-8 rounded-md bg-amber-brand grid place-items-center">
            <Wrench className="w-4 h-4 text-amber-brand-foreground" />
          </div>
          <div>
            <div className="font-bold text-sm tracking-tight">FleetOps CRM</div>
            <div className="text-[10px] font-mono text-sidebar-foreground/50">Workshop</div>
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
                <span className="truncate text-xs">{item.label}</span>
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
              Mechanic
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
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 border-b border-border bg-card flex items-center px-4 sm:px-6 gap-3">
          <button
            onClick={() => setOpen((v) => !v)}
            className="lg:hidden p-2 -ml-2 rounded-md hover:bg-accent"
          >
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <h1 className="text-lg sm:text-xl font-semibold tracking-tight">
            {title || "Workshop dashboard"}
          </h1>
        </header>
        <main className="flex-1 p-4 sm:p-6 overflow-x-hidden">{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}
