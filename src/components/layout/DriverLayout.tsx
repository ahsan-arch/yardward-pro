import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Home, Briefcase, FileText, User, Menu, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

const tabs = [
  { to: "/driver", label: "Home", icon: Home, exact: true },
  { to: "/driver/jobs", label: "My Jobs", icon: Briefcase },
  { to: "/driver/forms", label: "Forms", icon: FileText },
  { to: "/driver/profile", label: "Profile", icon: User },
];

export function DriverShell({ children }: { children?: ReactNode }) {
  const pathname = useRouterState({ select: s => s.location.pathname });
  return (
    <div className="min-h-[calc(100vh-44px)] bg-muted/30 flex justify-center">
      <div className="w-full max-w-[480px] bg-background min-h-[calc(100vh-44px)] flex flex-col shadow-xl">
        <header className="h-14 bg-navy text-navy-foreground flex items-center justify-between px-3 sticky top-11 z-20">
          <button className="p-2 rounded-md hover:bg-sidebar-accent"><Menu className="w-5 h-5" /></button>
          <div className="font-bold tracking-tight">FleetOps</div>
          <button className="flex items-center gap-1.5 h-9 px-3 rounded-full bg-amber-brand text-amber-brand-foreground text-sm font-semibold">
            <Clock className="w-4 h-4" /> Clock in
          </button>
        </header>
        <main className="flex-1 pb-20 overflow-x-hidden">
          {children ?? <Outlet />}
        </main>
        <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-card border-t border-border grid grid-cols-4 z-30">
          {tabs.map(t => {
            const active = t.exact ? pathname === t.to : pathname.startsWith(t.to);
            return (
              <Link key={t.to} to={t.to} className={cn("flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] transition-colors",
                active ? "text-amber-brand" : "text-muted-foreground")}>
                <t.icon className={cn("w-5 h-5", active && "stroke-[2.5]")} />
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
