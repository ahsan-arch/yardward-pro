import { useApp, type Role } from "@/contexts/AppContext";
import { useNavigate } from "@tanstack/react-router";
import { Moon, Sun, Shield, Truck, Wrench, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// "Demo mode" — when the user can flip between admin / driver / mechanic views
// from the top bar — is a dev-only convenience. Production builds (npm run
// build) flip import.meta.env.DEV to false, which hides the DEMO MODE label
// and the role-switcher buttons. Theme + logout always render so the top bar
// still has the standard chrome.
//
// To force-enable demo in a dev session (e.g. local prod-like testing) flip
// the env var VITE_DEMO_MODE=true.
const DEMO_MODE =
  import.meta.env.DEV || import.meta.env.VITE_DEMO_MODE === "true";

export function RoleSwitcher() {
  const { role, setRole, theme, toggleTheme, logout, isDriverTokenSession } = useApp();
  const navigate = useNavigate();
  const opts: { value: Role; label: string; icon: any; path: string }[] = [
    { value: "admin", label: "Admin", icon: Shield, path: "/admin" },
    { value: "driver", label: "Driver", icon: Truck, path: "/driver" },
    { value: "mechanic", label: "Mechanic", icon: Wrench, path: "/mechanic" },
  ];
  return (
    <div className="sticky top-0 z-50 w-full bg-navy text-navy-foreground border-b border-sidebar-border">
      <div className="flex items-center justify-between px-3 sm:px-4 h-11 gap-2">
        {DEMO_MODE ? (
          <div className="flex items-center gap-2 text-xs font-mono text-navy-foreground/70">
            <span className="hidden sm:inline">DEMO MODE</span>
            <span className="sm:hidden">DEMO</span>
          </div>
        ) : (
          // Production: occupy the slot so the centered row stays balanced.
          <div className="w-8" aria-hidden />
        )}
        {DEMO_MODE && !isDriverTokenSession && (
          <div className="flex items-center gap-1 bg-sidebar-accent/60 rounded-lg p-0.5">
            {opts.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  setRole(o.value);
                  navigate({ to: o.path });
                }}
                className={cn(
                  "flex items-center gap-1.5 px-2 sm:px-3 h-8 rounded-md text-xs font-medium transition-colors",
                  role === o.value
                    ? "bg-amber-brand text-amber-brand-foreground"
                    : "text-navy-foreground/80 hover:bg-sidebar-accent",
                )}
              >
                <o.icon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{o.label} view</span>
                <span className="sm:hidden">{o.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="h-8 w-8 text-navy-foreground hover:bg-sidebar-accent hover:text-navy-foreground"
          >
            {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              void logout();
              navigate({ to: "/login" });
            }}
            className="h-8 w-8 text-navy-foreground hover:bg-sidebar-accent hover:text-navy-foreground"
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
