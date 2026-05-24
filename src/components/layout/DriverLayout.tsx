import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Home, Briefcase, FileText, User, Menu, Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMemo, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";
import { PendingBadge } from "@/components/crm/OfflineBanner";
import { toast } from "sonner";
import { geotabCoordsForVehicle } from "@/data/mockData";

const tabs = [
  { to: "/driver", label: "Home", icon: Home, exact: true },
  { to: "/driver/jobs", label: "My Jobs", icon: Briefcase },
  { to: "/driver/forms", label: "Forms", icon: FileText },
  { to: "/driver/profile", label: "Profile", icon: User },
];

export function DriverShell({ children }: { children?: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { user } = useAuth();
  const { timeEntries, drivers } = useData();
  const openShift = timeEntries.find((t) => t.driverId === user.id && !t.clockOut);
  const me = drivers.find((d) => d.id === user.id);
  const fallback = useMemo(() => {
    const c = geotabCoordsForVehicle(me?.vehicleAssignmentId ?? null);
    return c ? { lat: c.lat, lng: c.lng, label: "Vehicle last known location" } : null;
  }, [me?.vehicleAssignmentId]);
  const [open, setOpen] = useState(false);
  const [odo, setOdo] = useState("");
  const [busy, setBusy] = useState(false);
  const gps = useGpsCapture(fallback, open);

  async function handleClock() {
    setBusy(true);
    try {
      if (openShift) {
        await api.clockOut(openShift.id, gps.coords, +odo || 0);
        toast.success("Clocked out");
      } else {
        if (!odo || isNaN(+odo)) {
          toast.error("Enter odometer reading");
          setBusy(false);
          return;
        }
        await api.clockIn(user.id, gps.coords, +odo);
        toast.success("Clocked in");
      }
      setOpen(false);
      setOdo("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-44px)] bg-muted/30 flex justify-center">
      <div className="w-full max-w-[480px] bg-background min-h-[calc(100vh-44px)] flex flex-col shadow-xl">
        <header className="h-14 bg-navy text-navy-foreground flex items-center justify-between px-3 sticky top-11 z-20">
          <button className="p-2 rounded-md hover:bg-sidebar-accent">
            <Menu className="w-5 h-5" />
          </button>
          <div className="font-bold tracking-tight inline-flex items-center gap-2">
            FleetOps <PendingBadge />
          </div>
          <button
            onClick={() => setOpen(true)}
            className={cn(
              "flex items-center gap-1.5 h-9 px-3 rounded-full text-sm font-semibold",
              openShift
                ? "bg-success text-success-foreground"
                : "bg-amber-brand text-amber-brand-foreground",
            )}
          >
            <Clock className="w-4 h-4" /> {openShift ? "Clock out" : "Clock in"}
          </button>
        </header>
        <main className="flex-1 pb-20 overflow-x-hidden">{children ?? <Outlet />}</main>
        <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-card border-t border-border grid grid-cols-4 z-30">
          {tabs.map((t) => {
            const active = t.exact ? pathname === t.to : pathname.startsWith(t.to);
            return (
              <Link
                key={t.to}
                to={t.to}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] transition-colors",
                  active ? "text-amber-brand" : "text-muted-foreground",
                )}
              >
                <t.icon className={cn("w-5 h-5", active && "stroke-[2.5]")} />
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-w-[480px] mx-auto rounded-t-2xl">
          <SheetHeader>
            <SheetTitle>{openShift ? "Clock out" : "Clock in"}</SheetTitle>
          </SheetHeader>
          <div className="mt-5 space-y-4">
            <div className="flex items-center justify-between p-3 bg-muted/40 rounded-md">
              <span className="text-sm">Location</span>
              <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
            </div>
            <div>
              <Label>Odometer reading</Label>
              <Input
                inputMode="numeric"
                value={odo}
                onChange={(e) => setOdo(e.target.value)}
                placeholder={openShift ? "End odometer" : "Start odometer"}
                className="h-12 mt-1.5 font-mono text-base"
              />
            </div>
            {openShift && (
              <div className="text-xs text-muted-foreground bg-muted/40 rounded-md p-2 font-mono">
                Clocked in at {new Date(openShift.clockIn).toLocaleTimeString()}
              </div>
            )}
            <Button
              onClick={handleClock}
              disabled={busy}
              className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-bold"
            >
              {busy ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" /> Saving…
                </>
              ) : openShift ? (
                "Confirm clock out"
              ) : (
                "Confirm clock in"
              )}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
