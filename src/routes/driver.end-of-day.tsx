import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ArrowLeft, Loader2, Moon, Wrench, Lock } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";
import { useOffline } from "@/contexts/OfflineContext";
import { offlineQueue } from "@/lib/offline-queue";
import { geotabCoordsForVehicle } from "@/data/mockData";
import { useMemo } from "react";
import { clearDriverTokenSession } from "@/hooks/use-driver-token-scope";

export const Route = createFileRoute("/driver/end-of-day")({
  head: () => ({ meta: [{ title: "End of day — Engage Hydrovac CRM" }] }),
  component: Page,
});

const fuels = ["Empty", "1/4", "1/2", "3/4", "Full"];

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { timeEntries, drivers, toolChecklistSubmissions } = useData();
  const { isOnline } = useOffline();
  const me = drivers.find((d) => d.id === user.id || d.email === user.email);
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
  // Form-scoped idempotency key — stable across retries so the back-end
  // partial unique index can dedupe replays.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `eod-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
  );

  const openShift = timeEntries.find((t) => t.driverId === user.id && !t.clockOut);
  const hours = openShift
    ? ((Date.now() - new Date(openShift.clockIn).getTime()) / 3600_000).toFixed(1)
    : "—";

  // Clock-out gate: we require an 'end_of_shift' tool checklist submitted AFTER
  // the most recent clock-in. Without an open shift there's nothing to close,
  // so let the page render and surface its existing "no open shift" handling.
  const endChecklistDone = useMemo(() => {
    if (!openShift) return true;
    const cutoff = new Date(openShift.clockIn).getTime();
    return toolChecklistSubmissions.some(
      (s) =>
        s.driverId === user.id &&
        s.kind === "end_of_shift" &&
        new Date(s.submittedAt).getTime() >= cutoff,
    );
  }, [openShift, toolChecklistSubmissions, user.id]);

  // Background submit closure. We capture the payload + token state at submit
  // time so the catch handler doesn't try to read unmounted form state. On
  // error we surface a Resubmit CTA that re-enqueues into the offline queue
  // (idempotent on the server via the form-scoped key).
  function fireAndForget(
    payload: Parameters<typeof api.submitEndOfDay>[0],
    burnToken: string | null,
  ) {
    void (async () => {
      try {
        const res = await api.submitEndOfDay(payload);
        if ("alreadyClosed" in res && res.alreadyClosed) {
          // The optimistic toast already said "shift closed", but the server
          // found no open shift to close — either there was no clock-in to
          // begin with or this is a replay. Correct the record so the driver
          // isn't told they clocked out when there was nothing to clock out of.
          toast.info("No open shift was found — nothing to clock out of.");
        }
        if (burnToken) {
          const claimed = await api.consumeDriverToken(burnToken);
          if (claimed) {
            clearDriverTokenSession();
          } else {
            toast.warning(
              "Shift closed, but the access link couldn't be revoked. Contact dispatch if it was reshared.",
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        toast.error(`End-of-day failed to sync: ${msg}`, {
          action: {
            label: "Resubmit",
            onClick: () => {
              void offlineQueue.enqueue({
                kind: "endOfDay",
                payload,
                consumeTokenAfter: burnToken,
              });
            },
          },
        });
      }
    })();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!endChecklistDone) {
      toast.error("Complete the end-of-shift tool check before clocking out");
      return;
    }
    const errs: typeof err = {};
    // Reject blank/whitespace/zero/negative/absurd (matches server 0..5,000,000).
    const odoNum = Number(odo);
    if (!Number.isFinite(odoNum) || odoNum <= 0 || odoNum > 5_000_000)
      errs.odo = "Enter a valid odometer reading";
    if (!summary.trim()) errs.summary = "Add a quick summary";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      const payload = {
        driverId: user.id,
        odometer: odoNum,
        fuelLevel: fuel,
        summary,
        gps: gps.coords,
        idempotencyKey,
      };
      const token = sessionStorage.getItem("fo:driver-token");
      // Only burn the token if its scope is shift-terminal. A "forms" scope
      // token covers multiple submissions across the day (SOD, EOD, tool
      // checks); burning it on the first EOD would lock the driver out of
      // the next form they need on the same link. Mirrors the gating
      // pattern in driver.work-order.tsx (scope === 'job').
      const tokenScope = sessionStorage.getItem("fo:driver-token-scope");
      const isShiftToken = !!(token && tokenScope === "shift");
      const burnToken = isShiftToken && token ? token : null;
      if (!isOnline) {
        // Couple the consume to the submission via consumeTokenAfter so the
        // token is burned only after the EOD lands on the server. A separate
        // queue item could otherwise burn before (race) or even when the EOD
        // itself was dead-lettered (data loss).
        await offlineQueue.enqueue({
          kind: "endOfDay",
          payload,
          consumeTokenAfter: burnToken,
        });
        toast.success("Saved offline — will sync when connection returns");
        nav({ to: "/driver" });
        return;
      }
      // Online optimistic path: navigate immediately so the driver isn't
      // stuck on a spinner if the network is slow. The fireAndForget call
      // handles success-side token burn and error-side Resubmit CTA.
      toast.success("End-of-day submitted · shift closed");
      nav({ to: "/driver" });
      fireAndForget(payload, burnToken);
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

        {!endChecklistDone && (
          <div
            className="mt-5 p-4 rounded-lg border-2 border-danger/40 bg-danger/10 text-danger"
            role="alert"
            data-testid="end-of-shift-gate"
          >
            <div className="flex items-center gap-2 font-semibold">
              <Lock className="w-4 h-4" /> Complete the end-of-shift tool check before clocking out
            </div>
            <p className="text-sm text-danger/90 mt-1.5">
              Walk the truck and confirm every tool is accounted for. We need to pinpoint missing
              gear to the shift it disappeared on.
            </p>
            <Button
              onClick={() =>
                nav({ to: "/driver/tool-checklist", search: { kind: "end_of_shift" } })
              }
              className="w-full mt-3 h-12 bg-danger text-danger-foreground hover:bg-danger/90 font-bold"
            >
              <Wrench className="w-4 h-4" /> Start end-of-shift tool check
            </Button>
          </div>
        )}

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
            disabled={loading || !endChecklistDone}
            className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Submitting…
              </>
            ) : !endChecklistDone ? (
              <>
                <Lock className="w-4 h-4" /> Locked — finish tool check
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
