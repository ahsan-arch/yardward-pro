import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Loader2, Moon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";
import { useOffline } from "@/contexts/OfflineContext";
import { offlineQueue } from "@/lib/offline-queue";
import { geotabCoordsForVehicle } from "@/data/mockData";
import { useMemo } from "react";

export const Route = createFileRoute("/driver/end-of-day")({
  head: () => ({ meta: [{ title: "End of day — FleetOps" }] }),
  component: Page,
});

const fuels = ["Empty", "1/4", "1/2", "3/4", "Full"];

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { timeEntries, drivers } = useData();
  const { isOnline } = useOffline();
  const me = drivers.find((d) => d.id === user.id);
  const fallback = useMemo(() => {
    const c = geotabCoordsForVehicle(me?.vehicleAssignmentId ?? null);
    return c ? { lat: c.lat, lng: c.lng, label: "Vehicle last known location" } : null;
  }, [me?.vehicleAssignmentId]);
  const gps = useGpsCapture(fallback);
  const [odo, setOdo] = useState("");
  const [fuel, setFuel] = useState("1/2");
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ odo?: string; summary?: string }>({});

  const openShift = timeEntries.find((t) => t.driverId === user.id && !t.clockOut);
  const hours = openShift
    ? ((Date.now() - new Date(openShift.clockIn).getTime()) / 3600_000).toFixed(1)
    : "—";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof err = {};
    if (!odo || isNaN(+odo)) errs.odo = "Enter a valid odometer reading";
    if (!summary.trim()) errs.summary = "Add a quick summary";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      const payload = {
        driverId: user.id,
        odometer: +odo,
        fuelLevel: fuel,
        summary,
        gps: gps.coords,
      };
      if (!isOnline) {
        await offlineQueue.enqueue({ kind: "endOfDay", payload });
        toast.success("Saved offline — will sync when connection returns");
      } else {
        await api.submitEndOfDay(payload);
        // revoke driver token (if used via /t/:token)
        const token = sessionStorage.getItem("fo:driver-token");
        if (token) sessionStorage.clear();
        toast.success("End-of-day submitted · shift closed");
      }
      nav({ to: "/driver" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <DriverShell>
      <div className="p-4">
        <Link
          to="/driver"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Moon className="w-5 h-5" /> End of day
            </h1>
            <p className="text-xs font-mono text-muted-foreground">Hours so far: {hours}h</p>
          </div>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>

        <form onSubmit={submit} className="mt-5 space-y-5">
          <div>
            <Label className="text-base">Final odometer</Label>
            <Input
              inputMode="numeric"
              value={odo}
              onChange={(e) => setOdo(e.target.value)}
              placeholder="84580"
              className={cn("h-14 mt-2 text-lg font-mono", err.odo && "border-danger")}
            />
            {err.odo && <p className="text-xs text-danger mt-1">{err.odo}</p>}
          </div>
          <div>
            <Label className="text-base">Fuel level at end</Label>
            <div className="grid grid-cols-5 gap-1 mt-2 bg-muted rounded-md p-1">
              {fuels.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFuel(f)}
                  className={cn(
                    "h-12 rounded text-sm font-medium transition-colors",
                    fuel === f
                      ? "bg-amber-brand text-amber-brand-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label className="text-base">Shift summary</Label>
            <Textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={4}
              placeholder="Jobs completed, any issues, vehicle state..."
              className={cn("mt-2 text-base", err.summary && "border-danger")}
            />
            {err.summary && <p className="text-xs text-danger mt-1">{err.summary}</p>}
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Submitting…
              </>
            ) : (
              "Submit end-of-day"
            )}
          </Button>
        </form>
      </div>
    </DriverShell>
  );
}
