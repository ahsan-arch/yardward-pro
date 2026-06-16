import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Home,
  Briefcase,
  FileText,
  User,
  Menu,
  Clock,
  Loader2,
  Lock,
  LogOut,
  Wrench,
  Ticket,
  MessagesSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  // Direct link to the prepaid-ticket recording flow. Most QR-scan landings
  // hit /driver/tickets via the t/<token> bridge already, but this tab gives
  // the driver a one-tap entry when they walk in with a paper ticket book
  // and need to record a debit before leaving the yard.
  { to: "/driver/tickets", label: "Tickets", icon: Ticket },
  { to: "/driver/messages", label: "Messages", icon: MessagesSquare },
  { to: "/driver/profile", label: "Profile", icon: User },
];

export function DriverShell({ children }: { children?: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const nav = useNavigate();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const { timeEntries, drivers, toolChecklistSubmissions } = useData();
  const openShift = timeEntries.find((t) => t.driverId === user.id && !t.clockOut);
  const me = drivers.find((d) => d.id === user.id || d.email === user.email);
  const fallback = useMemo(() => {
    const c = geotabCoordsForVehicle(me?.vehicleAssignmentId ?? null);
    return c ? { lat: c.lat, lng: c.lng, label: "Vehicle last known location" } : null;
  }, [me?.vehicleAssignmentId]);
  const [open, setOpen] = useState(false);
  const [odo, setOdo] = useState("");
  const [busy, setBusy] = useState(false);
  const gps = useGpsCapture(fallback, open);

  // Phone-based vehicle tracking (GeoTab replacement): while a shift is
  // open, ping the driver's phone position every 5 minutes (plus once on
  // mount). The SECURITY DEFINER RPC updates the assigned vehicle's live
  // position so the admin Live map keeps working without truck hardware.
  // Best-effort: denied geolocation or no assignment is silently ignored.
  const onShift = !!openShift;
  useEffect(() => {
    if (!onShift || typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    const ping = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (cancelled) return;
          void api.recordDriverLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speedKmh: pos.coords.speed != null ? Math.round(pos.coords.speed * 3.6) : null,
          });
        },
        () => {},
        { enableHighAccuracy: false, maximumAge: 60_000, timeout: 15_000 },
      );
    };
    ping();
    const t = window.setInterval(ping, 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [onShift]);

  // Twice-daily checklist gate. Clock-out requires an end-of-shift checklist
  // submitted after this open shift's clock_in. Clock-in requires a
  // start-of-shift checklist submitted after the driver's most recent
  // clock_out (or, if they've never clocked out, any prior start-of-shift
  // would be stale so we still require a fresh one).
  const checklistGate = useMemo(() => {
    const mine = toolChecklistSubmissions.filter((s) => s.driverId === user.id);
    if (openShift) {
      const cutoff = new Date(openShift.clockIn).getTime();
      const done = mine.some(
        (s) => s.kind === "end_of_shift" && new Date(s.submittedAt).getTime() >= cutoff,
      );
      return { kind: "end_of_shift" as const, satisfied: done };
    }
    // No open shift → about to clock in. Find driver's most recent clock_out
    // (entries with both clockIn and clockOut). If none, cutoff is 0 so any
    // start-of-shift checklist qualifies — but only one submitted AFTER any
    // shift the driver may have ended (we still want a fresh one per shift).
    const lastClockOut = timeEntries
      .filter((t) => t.driverId === user.id && t.clockOut)
      .map((t) => new Date(t.clockOut as string).getTime())
      .reduce((max, ts) => (ts > max ? ts : max), 0);
    const done = mine.some(
      (s) => s.kind === "start_of_shift" && new Date(s.submittedAt).getTime() >= lastClockOut,
    );
    return { kind: "start_of_shift" as const, satisfied: done };
  }, [openShift, timeEntries, toolChecklistSubmissions, user.id]);

  async function handleClock() {
    if (!checklistGate.satisfied) {
      toast.error(
        checklistGate.kind === "end_of_shift"
          ? "Complete the end-of-shift tool check before clocking out"
          : "Complete the start-of-shift tool check before clocking in",
      );
      return;
    }
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

  function openChecklist() {
    setOpen(false);
    nav({ to: "/driver/tool-checklist", search: { kind: checklistGate.kind } });
  }

  return (
    <div className="min-h-[calc(100vh-44px)] bg-muted/30 flex justify-center">
      <div className="w-full max-w-[480px] bg-background min-h-[calc(100vh-44px)] flex flex-col shadow-xl">
        <header className="h-14 bg-navy text-navy-foreground flex items-center justify-between px-3 sticky top-11 z-20">
          <button
            className="p-2 rounded-md hover:bg-sidebar-accent"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            data-testid="driver-menu-button"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="font-bold tracking-tight inline-flex items-center gap-2">
            Engage Hydrovac <PendingBadge />
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
        <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[520px] bg-card border-t border-border grid grid-cols-6 z-30">
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
            {!checklistGate.satisfied && (
              <div
                className="p-3 rounded-md border-2 border-danger/40 bg-danger/10 text-danger"
                role="alert"
                data-testid="clock-gate"
              >
                <div className="flex items-center gap-2 font-semibold text-sm">
                  <Lock className="w-4 h-4" />{" "}
                  {checklistGate.kind === "end_of_shift"
                    ? "Complete the end-of-shift tool check before clocking out"
                    : "Complete the start-of-shift tool check before clocking in"}
                </div>
                <Button
                  onClick={openChecklist}
                  className="w-full mt-3 h-11 bg-danger text-danger-foreground hover:bg-danger/90 font-bold"
                >
                  <Wrench className="w-4 h-4" /> Open tool checklist
                </Button>
              </div>
            )}
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
              disabled={busy || !checklistGate.satisfied}
              // Keep a stable accessible name regardless of the visible label
              // (which swaps to "Locked" while the checklist gate blocks the
              // click). Tests that rely on getByRole("button", { name:
              // /confirm clock in|out/ }) — including the driver button audit
              // EOD-gate path — need the role+name to remain present even
              // when disabled, so the assertion can resolve quickly and the
              // skip/gate branches both surface their respective UI without
              // burning the full default 30s element-search timeout.
              aria-label={openShift ? "Confirm clock out" : "Confirm clock in"}
              className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-bold disabled:opacity-60"
            >
              {busy ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" /> Saving…
                </>
              ) : !checklistGate.satisfied ? (
                <>
                  <Lock className="w-4 h-4" /> Locked
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

      {/* Account menu — opened by the header hamburger. The bottom tab bar
          handles navigation, so this surfaces what it can't: who's signed in
          and a sign-out (a driver previously had no way to log out). */}
      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-72" data-testid="driver-menu-sheet">
          <SheetHeader>
            <SheetTitle>Menu</SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-1">
            <div className="px-3 py-2 rounded-md bg-muted/40">
              {/* Prefer the roster-resolved driver (`me`) over `user`: a token
                  session only carries the driver's id, so user.name/email are
                  still the mock-admin defaults — me.name/email are the real
                  driver's. Fall back to user.* before the roster hydrates. */}
              <div className="text-sm font-semibold">{me?.name ?? user.name}</div>
              <div className="text-xs text-muted-foreground">{me?.email ?? user.email}</div>
            </div>
            {tabs.map((t) => (
              <Link
                key={t.to}
                to={t.to}
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm hover:bg-muted/60"
              >
                <t.icon className="w-4 h-4 text-muted-foreground" /> {t.label}
              </Link>
            ))}
            <button
              onClick={() => {
                setMenuOpen(false);
                void logout().then(() => nav({ to: "/login" }));
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm text-danger hover:bg-danger/10 mt-2"
              data-testid="driver-menu-signout"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
