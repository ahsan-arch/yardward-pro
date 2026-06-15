import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  ClipboardCheck,
  Loader2,
  Check,
  AlertTriangle,
  Camera,
  X,
  Satellite,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";
import { useOffline } from "@/contexts/OfflineContext";
import { offlineQueue, OfflineQueueQuotaError } from "@/lib/offline-queue";
import { geotabCoordsForVehicle, inspectionChecklist } from "@/data/mockData";
import { haversineMeters } from "@/lib/geolocation";
import type { InspectionItemStatus } from "@/types/domain";

export const Route = createFileRoute("/driver/inspection")({
  head: () => ({ meta: [{ title: "Vehicle inspection — Engage Hydrovac CRM" }] }),
  component: Page,
});

type ChecklistRow = { name: string; status: InspectionItemStatus; notes: string };

function relativeTime(iso: string) {
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)} h ago`;
  return `${Math.round(diffSec / 86400)} d ago`;
}

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { drivers, vehicles } = useData();
  const { isOnline } = useOffline();

  const me = drivers.find((d) => d.id === user.id || d.email === user.email) ?? drivers[0];
  const defaultVehicleId = me?.vehicleAssignmentId ?? vehicles[0]?.id ?? "";

  const [vehicleId, setVehicleId] = useState(defaultVehicleId);
  // defaultVehicleId is "" until drivers/vehicles hydrate (Supabase mode); set it
  // once available so the inspection isn't stuck with no vehicle selected (which
  // would also skip the Geotab cross-reference). Only while still unset.
  useEffect(() => {
    if (!vehicleId && defaultVehicleId) setVehicleId(defaultVehicleId);
  }, [defaultVehicleId, vehicleId]);
  const [items, setItems] = useState<ChecklistRow[]>(
    inspectionChecklist.map((i) => ({ name: i.name, status: "ok", notes: "" })),
  );
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Form-scoped idempotency key — minted once when the form mounts and reused
  // by both the online and offline submit paths. Without this, a back-then-
  // resubmit while offline mints a fresh key on each enqueue and the partial
  // unique index can't dedupe the replay.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `insp-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
  );

  const fallback = useMemo(() => {
    const c = geotabCoordsForVehicle(vehicleId);
    return c ? { lat: c.lat, lng: c.lng, label: `Vehicle ${vehicleId} last known` } : null;
  }, [vehicleId]);

  const gps = useGpsCapture(fallback, true);

  const [geotab, setGeotab] = useState<{
    lat: number;
    lng: number;
    capturedAt: string;
  } | null>(null);

  useEffect(() => {
    if (!vehicleId) return;
    let cancelled = false;
    api.fetchGeotabLocation(vehicleId).then((g) => {
      if (!cancelled) setGeotab(g);
    });
    return () => {
      cancelled = true;
    };
  }, [vehicleId]);

  const distance = gps.coords && geotab ? Math.round(haversineMeters(gps.coords, geotab)) : null;

  const matchLabel = (() => {
    if (distance == null) return "Waiting for GPS + Geotab…";
    if (distance < 500) return `Match (${distance}m apart)`;
    if (distance < 5000) return `Close (${distance}m apart) — verify location`;
    return `Mismatch (${distance}m apart) — flagged`;
  })();
  const matchKind: "ok" | "warn" | "fail" =
    distance == null ? "warn" : distance < 500 ? "ok" : distance < 5000 ? "warn" : "fail";

  function setItemStatus(idx: number, status: InspectionItemStatus) {
    setItems((arr) => arr.map((x, i) => (i === idx ? { ...x, status } : x)));
  }
  function setItemNote(idx: number, notes: string) {
    setItems((arr) => arr.map((x, i) => (i === idx ? { ...x, notes } : x)));
  }
  function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPhotos((p) => [...p, reader.result as string]);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  const issueCount = items.filter((i) => i.status === "issue").length;
  const requiresNote = issueCount > 0 && !notes.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (requiresNote) {
      toast.error("Add a note describing the flagged issues");
      return;
    }
    setSubmitting(true);
    try {
      const gpsCapture = gps.coords
        ? { ...gps.coords, capturedAt: new Date().toISOString() }
        : null;
      const geotabSnapshot =
        gps.coords && geotab
          ? {
              lat: geotab.lat,
              lng: geotab.lng,
              capturedAt: geotab.capturedAt,
              distanceMeters: Math.round(haversineMeters(gps.coords, geotab)),
            }
          : null;
      const payload = {
        driverId: user.id,
        vehicleId,
        gpsCapture,
        geotabSnapshot,
        items,
        notes,
        photos,
        flagged: issueCount > 0,
        idempotencyKey,
      };
      if (!isOnline) {
        // Enqueue rather than firing api.submitVehicleInspection — that call
        // would throw on transport failure when offline, leaving the driver
        // staring at an error toast with a fully-completed walk-around lost.
        // The flushOne path replays the same payload shape on reconnect.
        try {
          await offlineQueue.enqueue({ kind: "inspection", payload });
        } catch (err) {
          if (err instanceof OfflineQueueQuotaError) {
            toast.error(
              "Couldn't save offline — storage full. Reconnect and resubmit, or remove photos.",
            );
            return;
          }
          throw err;
        }
        toast.success("Inspection saved — will sync when back online");
        nav({ to: "/driver" });
        return;
      }
      await api.submitVehicleInspection(payload);
      toast.success(`Inspection submitted${issueCount ? ` · ${issueCount} flagged` : ""}`);
      nav({ to: "/driver" });
    } catch (e) {
      // Online submit (or a re-thrown offline-enqueue error) had no catch — a
      // transport failure silently lost the completed walk-around with no toast.
      // Surface it so the driver can retry instead of losing their inspection.
      toast.error(e instanceof Error ? e.message : "Could not submit inspection — please retry");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DriverShell>
      <div className="p-4" data-testid="driver-inspection-page">
        <Link
          to="/driver"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <ClipboardCheck className="w-5 h-5" /> Vehicle inspection
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pre-trip walk-around · GPS + Geotab cross-reference
            </p>
          </div>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>

        <form onSubmit={submit} className="mt-5 space-y-5">
          <div>
            <Label className="text-base">Vehicle</Label>
            <Select value={vehicleId} onValueChange={setVehicleId}>
              <SelectTrigger className="h-12 mt-2" data-testid="inspection-vehicle-select">
                <SelectValue placeholder="Choose vehicle" />
              </SelectTrigger>
              <SelectContent>
                {vehicles.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.id} — {v.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div
            className={cn(
              "rounded-lg border p-3 text-sm",
              matchKind === "ok" && "border-success/40 bg-success/5",
              matchKind === "warn" && "border-amber-brand/40 bg-amber-brand/5",
              matchKind === "fail" && "border-danger/40 bg-danger/5",
            )}
            data-testid="geotab-card"
            data-geotab-match={matchKind}
          >
            <div className="flex items-center gap-2 font-semibold">
              <Satellite className="w-4 h-4" /> Geotab cross-reference
            </div>
            {geotab ? (
              <div className="mt-2 space-y-1 text-xs font-mono">
                <div>
                  Vehicle GPS: {geotab.lat.toFixed(5)}, {geotab.lng.toFixed(5)} ·{" "}
                  {relativeTime(geotab.capturedAt)}
                </div>
                <div>
                  Your GPS:{" "}
                  {gps.coords
                    ? `${gps.coords.lat.toFixed(5)}, ${gps.coords.lng.toFixed(5)}`
                    : "waiting…"}
                </div>
                <div
                  className={cn(
                    "inline-flex items-center gap-1.5 font-sans text-xs mt-1",
                    matchKind === "ok" && "text-success",
                    matchKind === "warn" && "text-amber-brand",
                    matchKind === "fail" && "text-danger",
                  )}
                >
                  {matchKind === "ok" ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5" />
                  )}
                  {matchLabel}
                </div>
              </div>
            ) : (
              <div className="mt-2 text-xs text-muted-foreground">Loading Geotab data…</div>
            )}
            <p className="text-[10px] text-muted-foreground mt-2">
              Cross-reference confirms the inspection is happening at the vehicle's location.
            </p>
          </div>

          <div>
            <Label className="text-base">Pre-trip checklist</Label>
            <div className="space-y-2 mt-2" data-testid="inspection-checklist">
              {items.map((it, i) => (
                <div
                  key={it.name}
                  className={cn(
                    "rounded-lg border p-3",
                    it.status === "ok" ? "bg-card border-border" : "bg-danger/10 border-danger/30",
                  )}
                  data-testid={`inspection-item-${i}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 font-medium">{it.name}</div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        aria-label={`${it.name} OK`}
                        onClick={() => setItemStatus(i, "ok")}
                        className={cn(
                          "w-9 h-9 rounded grid place-items-center border-2",
                          it.status === "ok"
                            ? "bg-success border-success text-success-foreground"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`${it.name} issue`}
                        onClick={() => setItemStatus(i, "issue")}
                        className={cn(
                          "w-9 h-9 rounded grid place-items-center border-2",
                          it.status === "issue"
                            ? "bg-danger border-danger text-danger-foreground"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        <AlertTriangle className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {it.status === "issue" && (
                    <input
                      value={it.notes}
                      onChange={(e) => setItemNote(i, e.target.value)}
                      placeholder="Describe the issue…"
                      className="w-full mt-2 h-9 px-2 text-sm rounded-md border border-input bg-background"
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          {issueCount > 0 && (
            <div className="p-3 bg-danger/15 border border-danger/30 rounded-lg text-danger text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> {issueCount} item{issueCount > 1 ? "s" : ""}{" "}
              flagged — add a note below
            </div>
          )}

          <div>
            <Label className="text-base">Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={issueCount > 0 ? "Required — describe what's wrong…" : "Optional"}
              className={cn("mt-2 text-base", requiresNote && "border-danger")}
              data-testid="inspection-notes"
            />
          </div>

          <div>
            <Label className="text-base">Photos (optional)</Label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {photos.map((p, i) => (
                <div
                  key={i}
                  className="relative aspect-square rounded-md overflow-hidden border border-border"
                >
                  <img src={p} alt="" className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhotos((arr) => arr.filter((_, idx) => idx !== i))}
                    className="absolute top-1 right-1 w-6 h-6 bg-black/60 text-white rounded-full grid place-items-center"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <label className="aspect-square rounded-md border-2 border-dashed border-border grid place-items-center text-muted-foreground cursor-pointer hover:border-amber-brand">
                <Camera className="w-6 h-6" />
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={onPhoto}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          <Button
            type="submit"
            disabled={submitting}
            data-testid="inspection-submit"
            className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold"
          >
            {submitting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Submitting…
              </>
            ) : (
              "Submit inspection"
            )}
          </Button>
        </form>
      </div>
    </DriverShell>
  );
}
