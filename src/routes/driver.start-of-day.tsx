import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  ArrowLeft,
  Loader2,
  MapPin,
  Check,
  AlertTriangle,
  AlertOctagon,
  ClipboardCheck,
  Lock,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";
import { useOffline } from "@/contexts/OfflineContext";
import { offlineQueue } from "@/lib/offline-queue";
import { useData } from "@/contexts/DataContext";
import { useMemo } from "react";
import { geotabCoordsForVehicle } from "@/data/mockData";
import { clearDriverTokenSession } from "@/hooks/use-driver-token-scope";

export const Route = createFileRoute("/driver/start-of-day")({
  head: () => ({ meta: [{ title: "Start of day — FleetOps" }] }),
  component: Page,
});

const fuels = ["Empty", "1/4", "1/2", "3/4", "Full"];
const conditions = [
  { v: "ok", label: "No issues", icon: Check, color: "text-success" },
  {
    v: "minor",
    label: "Minor issue (note required)",
    icon: AlertTriangle,
    color: "text-amber-brand",
  },
  {
    v: "major",
    label: "Major issue (notify management)",
    icon: AlertOctagon,
    color: "text-danger",
  },
];

// Pre-trip stays valid for 12h after the recorded completion time. After that
// CVOR rules require a fresh circle-check before the driver clocks in. Match
// to vehicles.last_pretrip_at + 12h on the server side.
const PRETRIP_WINDOW_MS = 12 * 60 * 60 * 1000;

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { isOnline } = useOffline();
  const { drivers, vehicles } = useData();
  const me = drivers.find((d) => d.id === user.id || d.email === user.email);
  const assignedVehicle = useMemo(
    () => vehicles.find((v) => v.id === me?.vehicleAssignmentId) ?? null,
    [vehicles, me?.vehicleAssignmentId],
  );
  // The CVOR lockout: bail out before any clock-in UI renders if the
  // driver's assigned vehicle has no recent passing pre-trip on file.
  // Drivers without an assignment skip the lockout (they have nothing to
  // circle-check yet) but stay flagged for admin follow-up via the audit
  // badge on the vehicle detail page.
  const pretripStatus = useMemo<{ blocked: boolean; lastAt: string | null }>(() => {
    if (!assignedVehicle) return { blocked: false, lastAt: null };
    const lastAt = assignedVehicle.lastPretripAt ?? null;
    if (!lastAt) return { blocked: true, lastAt: null };
    const ageMs = Date.now() - new Date(lastAt).getTime();
    return { blocked: ageMs > PRETRIP_WINDOW_MS, lastAt };
  }, [assignedVehicle]);
  const fallback = useMemo(() => {
    const c = geotabCoordsForVehicle(me?.vehicleAssignmentId ?? null);
    return c ? { lat: c.lat, lng: c.lng, label: "Vehicle last known location" } : null;
  }, [me?.vehicleAssignmentId]);
  const gps = useGpsCapture(fallback);
  const [odo, setOdo] = useState("");
  const [fuel, setFuel] = useState("3/4");
  const [cond, setCond] = useState("ok");
  const [note, setNote] = useState("");
  const [pax, setPax] = useState(false);
  const [ppe, setPpe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ odo?: string; note?: string }>({});
  // Form-scoped idempotency key — minted once when the form mounts and reused
  // by both the online and offline submit paths so the partial unique index
  // on time_entries (clock_in_idempotency_key) can dedupe a retried replay.
  // Mirrors the pattern used in driver.inspection.tsx.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `sod-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
  );

  // Background submit: fires after we've already shown the success toast and
  // navigated away. If the server call fails we surface a toast.error with a
  // "Resubmit" CTA that re-enqueues the original payload. Because the form is
  // unmounted by the time this catch can run, we can't read the latest input
  // state — the payload is closed over at submit-time, which is exactly what
  // we want for a true replay.
  function fireAndForget(
    payload: Parameters<typeof api.submitStartOfDay>[0],
    finalize: () => Promise<void>,
  ) {
    void (async () => {
      try {
        await api.submitStartOfDay(payload);
        await finalize();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        toast.error(`Start-of-day failed to sync: ${msg}`, {
          action: {
            label: "Resubmit",
            onClick: () => {
              // Re-enqueue so the offline-queue flusher (or the next online
              // attempt) replays the payload. The idempotencyKey rides
              // along, so even if the original write actually landed, the
              // server will dedupe rather than double-submit.
              void offlineQueue.enqueue({ kind: "startOfDay", payload });
            },
          },
        });
      }
    })();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Defence in depth: the lockout screen already guards the route, but a
    // race (stale pre-trip ageing out mid-form) could still slip through.
    // Bounce the driver back to the inspection rather than submitting a
    // shift the MTO would later void.
    if (pretripStatus.blocked) {
      toast.error("Pre-trip inspection required before clocking in");
      nav({ to: "/driver/inspection" });
      return;
    }
    const errs: typeof err = {};
    if (!odo || isNaN(+odo)) errs.odo = "Enter a valid odometer reading";
    if (cond === "minor" && !note.trim()) errs.note = "Describe the issue";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      const payload = {
        driverId: user.id,
        odometer: +odo,
        fuelLevel: fuel,
        condition: cond,
        gps: gps.coords,
        idempotencyKey,
      };
      // Single-use enforcement for scope='forms' tokens: this is the entry
      // point the dispatcher hands a driver who only needs to file paperwork
      // for the day. Once start-of-day is in, the link's job is done — we
      // burn it so the same URL can't be re-opened on another phone tomorrow.
      const token = sessionStorage.getItem("fo:driver-token");
      const tokenScope = sessionStorage.getItem("fo:driver-token-scope");
      const isFormsToken = !!(token && tokenScope === "forms");
      if (!isOnline) {
        // Offline: must enqueue before navigating — there's no live network
        // call to optimistically defer. The idempotencyKey on the payload is
        // preserved by offlineQueue.enqueue (it only mints one when missing).
        await offlineQueue.enqueue({ kind: "startOfDay", payload });
        if (isFormsToken && token) {
          await offlineQueue.enqueue({ kind: "consumeDriverToken", payload: token });
        }
        toast.success("Saved offline — will sync when connection returns");
        nav({ to: "/driver" });
        return;
      }
      // Online optimistic path: show the success toast and route to the next
      // step immediately. The actual api.submitStartOfDay call runs in the
      // background; on failure we toast a Resubmit CTA that re-enqueues the
      // payload (the idempotencyKey makes that safe even if the write
      // actually landed before the network blip).
      toast.success("Start-of-day form submitted · finish the tool check next");
      nav({ to: "/driver/tool-checklist", search: { kind: "start_of_shift" } });
      fireAndForget(payload, async () => {
        if (isFormsToken && token) {
          const claimed = await api.consumeDriverToken(token);
          if (claimed) {
            clearDriverTokenSession();
          } else {
            toast.warning(
              "Start-of-day submitted, but the access link couldn't be revoked. Contact dispatch if it was reshared.",
            );
          }
        }
      });
    } finally {
      setLoading(false);
    }
  }

  if (pretripStatus.blocked) {
    // BLOCKING screen — driver cannot reach the clock-in form. Wording is
    // deliberately about the MTO ($150 fine + CVOR violation) so drivers
    // understand the lockout is regulatory, not a bug.
    return (
      <DriverShell>
        <div className="p-4" data-testid="pretrip-lockout">
          <Link
            to="/driver"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </Link>
          <div className="mt-6 rounded-xl border-2 border-danger/40 bg-danger/5 p-6 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-danger/15 grid place-items-center">
              <Lock className="w-7 h-7 text-danger" />
            </div>
            <h1 className="mt-4 text-xl font-bold text-danger">Pre-trip inspection required</h1>
            <p className="mt-2 text-sm text-foreground/80">
              You must complete the pre-trip inspection before clocking in.
            </p>
            <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
              MTO rules require a daily circle-check on file before the shift starts. Skipping it is
              a $150 fine and a CVOR violation against the company.
            </p>
            <div className="mt-3 text-[11px] font-mono text-muted-foreground">
              {assignedVehicle
                ? `Vehicle: ${assignedVehicle.id} — ${assignedVehicle.name}`
                : "No vehicle assigned"}
              {pretripStatus.lastAt && (
                <div>Last pre-trip: {new Date(pretripStatus.lastAt).toLocaleString()} (expired)</div>
              )}
              {!pretripStatus.lastAt && <div>No pre-trip on file for today</div>}
            </div>
            <Button
              data-testid="pretrip-lockout-cta"
              onClick={() => nav({ to: "/driver/inspection" })}
              className="w-full h-14 mt-6 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold"
            >
              <ClipboardCheck className="w-5 h-5" /> Start pre-trip inspection
            </Button>
          </div>
        </div>
      </DriverShell>
    );
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
            <h1 className="text-xl font-bold">Start of day</h1>
            <p className="text-xs font-mono text-muted-foreground">14 May 2025</p>
          </div>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>

        <form onSubmit={submit} className="mt-5 space-y-5">
          <div>
            <Label className="text-base">Odometer reading at start</Label>
            <Input
              inputMode="numeric"
              value={odo}
              onChange={(e) => setOdo(e.target.value)}
              placeholder="84220"
              className={cn("h-14 mt-2 text-lg font-mono", err.odo && "border-danger")}
            />
            {err.odo && <p className="text-xs text-danger mt-1">{err.odo}</p>}
          </div>

          <div>
            <Label className="text-base">Fuel level</Label>
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
            <Label className="text-base">Vehicle condition</Label>
            <div className="space-y-2 mt-2">
              {conditions.map((c) => (
                <button
                  key={c.v}
                  type="button"
                  onClick={() => setCond(c.v)}
                  className={cn(
                    "w-full flex items-center gap-3 p-4 rounded-lg border-2 text-left transition-all",
                    cond === c.v ? "border-amber-brand bg-amber-brand/5" : "border-border",
                  )}
                >
                  <c.icon className={cn("w-5 h-5", c.color)} />
                  <span className="font-medium">{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          {cond === "minor" && (
            <div>
              <Label className="text-base">Describe the issue</Label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                className={cn("mt-2 text-base", err.note && "border-danger")}
              />
              {err.note && <p className="text-xs text-danger mt-1">{err.note}</p>}
            </div>
          )}

          <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg border border-border">
            <Label className="text-base">Passengers in vehicle?</Label>
            <Switch checked={pax} onCheckedChange={setPax} />
          </div>
          <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg border border-border">
            <Label className="text-base">Any personal PPE missing?</Label>
            <Switch checked={ppe} onCheckedChange={setPpe} />
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
              "Submit start-of-day form"
            )}
          </Button>
          <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
            <MapPin className="w-3 h-3" /> GPS location and timestamp will be recorded on submission
          </p>
        </form>
      </div>
    </DriverShell>
  );
}
