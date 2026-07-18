import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Check, AlertTriangle, Loader2, Wrench, Sun, Moon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import type { ToolCondition, ToolChecklistKind } from "@/types/domain";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";
import { useOffline } from "@/contexts/OfflineContext";
import { offlineQueue } from "@/lib/offline-queue";
import { geotabCoordsForVehicle } from "@/data/mockData";
import { useMemo } from "react";

type ChecklistSearch = { kind: ToolChecklistKind };

export const Route = createFileRoute("/driver/tool-checklist")({
  head: () => ({ meta: [{ title: "Tool checklist — Engage Hydrovac CRM" }] }),
  validateSearch: (search: Record<string, unknown>): ChecklistSearch => {
    const k = search.kind;
    return { kind: k === "end_of_shift" ? "end_of_shift" : "start_of_shift" };
  },
  component: Page,
});

const stateStyles: Record<ToolCondition, string> = {
  ok: "bg-card border-border",
  missing: "bg-danger/10 border-danger/30",
  damaged: "bg-amber-brand/10 border-amber-brand/40",
};
const stateLabel: Record<ToolCondition, string> = {
  ok: "OK",
  missing: "MISSING",
  damaged: "DAMAGED",
};

function Page() {
  const nav = useNavigate();
  const { kind } = Route.useSearch();
  const { tools, drivers } = useData();
  const { user } = useAuth();
  const { isOnline } = useOffline();
  const me = drivers.find((d) => d.id === user.id || d.email === user.email);
  const vehicleId = me?.vehicleAssignmentId ?? "TRK-07";
  const fallback = useMemo(() => {
    const c = geotabCoordsForVehicle(vehicleId);
    return c ? { lat: c.lat, lng: c.lng, label: `Vehicle ${vehicleId} last known` } : null;
  }, [vehicleId]);
  const gps = useGpsCapture(fallback);
  // Scope to THIS vehicle's tools only. Unfiltered, every driver saw the
  // org's entire tool roster mixed together regardless of what truck they
  // actually drive — the demo never surfaced it because every seed tool
  // happens to belong to TRK-07, the same id the vehicleId fallback above
  // uses. Client feedback: "the tools inventory check doesn't work."
  const vehicleTools = useMemo(
    () => tools.filter((t) => t.vehicleId === vehicleId),
    [tools, vehicleId],
  );
  const [items, setItems] = useState<
    { toolId: string; name: string; status: ToolCondition; notes: string }[]
  >([]);
  // Seed once per resolved vehicleId rather than via useState's one-time
  // initializer. AuthContext's mock `user` starts as the admin preset and
  // only flips to the real driver in an effect after mount, so on the very
  // first render `me` is unresolved and vehicleId falls back to the
  // hardcoded default — a useState initializer would freeze `items` from
  // the WRONG vehicle forever once the real id resolves a tick later. This
  // re-seeds whenever vehicleId settles to a new value, and vehicleId is
  // stable for the rest of the page's life once resolved, so it won't
  // clobber in-progress edits.
  const seededVehicleRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededVehicleRef.current === vehicleId) return;
    seededVehicleRef.current = vehicleId;
    setItems(
      vehicleTools.map((t) => ({
        toolId: t.id,
        name: t.name,
        status: t.condition as ToolCondition,
        notes: "",
      })),
    );
    // vehicleTools is intentionally omitted: it's a derived array that gets a
    // new reference on every render, and re-running only on vehicleId is the
    // whole point of the ref guard above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId]);
  const [loading, setLoading] = useState(false);
  // Form-scoped idempotency key — minted once at mount so a retried submit
  // (online flake, fail-then-Resubmit, or offline replay) carries the same
  // key. Server-side dedupe uses the partial unique index on
  // tool_checklist_submissions.idempotency_key.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `tcl-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
  );
  const flagged = items.filter((i) => i.status !== "ok").length;

  function setStatus(idx: number, next: ToolCondition) {
    setItems((arr) => arr.map((x, i) => (i === idx ? { ...x, status: next } : x)));
  }

  // Background submit: fire after we've optimistically advanced the driver to
  // the next screen. On failure, surface a Resubmit toast that re-enqueues —
  // the idempotencyKey on the payload makes that safe even if the original
  // write actually landed before the network blip.
  function fireAndForget(payload: Parameters<typeof api.submitToolChecklist>[0]) {
    void (async () => {
      try {
        await api.submitToolChecklist(payload);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        toast.error(`Tool checklist failed to sync: ${msg}`, {
          action: {
            label: "Resubmit",
            onClick: () => {
              void offlineQueue.enqueue({ kind: "toolChecklist", payload });
            },
          },
        });
      }
    })();
  }

  async function submit() {
    setLoading(true);
    try {
      const payload = {
        driverId: user.id,
        vehicleId,
        kind,
        gpsLat: gps.coords?.lat ?? null,
        gpsLng: gps.coords?.lng ?? null,
        items: items.map(({ toolId, status, notes }) => ({ toolId, status, notes })),
        idempotencyKey,
      };
      if (!isOnline) {
        await offlineQueue.enqueue({ kind: "toolChecklist", payload });
        toast.success("Saved offline — will sync when connection returns");
      } else {
        // Optimistic: toast + nav immediately, with the network call backgrounded.
        toast.success(flagged ? `Checklist submitted · ${flagged} flagged` : "Checklist submitted");
        fireAndForget(payload);
      }
      // After end-of-shift checklist, route back to the end-of-day flow so the
      // driver can finish clocking out. Start-of-shift returns home.
      if (kind === "end_of_shift") {
        nav({ to: "/driver/end-of-day" });
      } else {
        nav({ to: "/driver" });
      }
    } finally {
      setLoading(false);
    }
  }

  const kindLabel = kind === "end_of_shift" ? "End-of-shift" : "Start-of-shift";
  const KindIcon = kind === "end_of_shift" ? Moon : Sun;

  return (
    <DriverShell>
      <div className="p-4">
        <Link
          to="/driver"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div
          className={cn(
            "rounded-lg border px-3 py-2 mb-3 inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider",
            kind === "end_of_shift"
              ? "bg-navy/10 border-navy/30 text-navy"
              : "bg-amber-brand/10 border-amber-brand/30 text-amber-brand",
          )}
        >
          <KindIcon className="w-3.5 h-3.5" /> {kindLabel} tool check
        </div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">Tool checklist — {vehicleId}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {kind === "end_of_shift"
                ? "Confirm every tool is back on the truck before clocking out."
                : "Mark each item: OK, damaged, or missing."}
            </p>
          </div>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>

        {items.length === 0 && (
          // Empty-state: this vehicle has no tools registered against it yet
          // (or the roster hasn't hydrated). Either way the driver must not
          // be stuck here — Submit stays enabled below so they can confirm
          // "nothing to check" and continue their shift; blocking them
          // entirely was the client-reported bug ("no tools present but
          // won't bypass it" / "could not get past the driver initial
          // screen").
          <div className="mt-6 rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
            <Wrench className="w-6 h-6 mx-auto text-muted-foreground" />
            <div className="mt-2 text-sm font-medium">No tools assigned to this vehicle</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing to check. Confirm below to continue — an admin can add
              this vehicle's tools from Vehicles → Tools at any time.
            </p>
          </div>
        )}

        <div className="mt-4 space-y-2">
          {items.map((it, i) => (
            <div
              key={it.toolId}
              className={cn(
                "rounded-lg border p-3 flex items-center gap-3",
                stateStyles[it.status],
              )}
            >
              <div className="flex-1 min-w-0">
                <div
                  className={cn(
                    "font-medium",
                    it.status === "missing" && "text-danger",
                    it.status === "damaged" && "text-amber-brand",
                  )}
                >
                  {it.name}
                </div>
                <div
                  className={cn(
                    "text-xs font-mono uppercase mt-0.5",
                    it.status === "ok" && "text-success",
                    it.status === "missing" && "text-danger",
                    it.status === "damaged" && "text-amber-brand",
                  )}
                >
                  {stateLabel[it.status]}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  aria-label="OK"
                  onClick={() => setStatus(i, "ok")}
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
                  aria-label="Damaged"
                  onClick={() => setStatus(i, "damaged")}
                  className={cn(
                    "w-9 h-9 rounded grid place-items-center border-2",
                    it.status === "damaged"
                      ? "bg-amber-brand border-amber-brand text-amber-brand-foreground"
                      : "border-border text-muted-foreground",
                  )}
                >
                  <Wrench className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  aria-label="Missing"
                  onClick={() => setStatus(i, "missing")}
                  className={cn(
                    "w-9 h-9 rounded grid place-items-center border-2",
                    it.status === "missing"
                      ? "bg-danger border-danger text-danger-foreground"
                      : "border-border text-muted-foreground",
                  )}
                >
                  <AlertTriangle className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {flagged > 0 && (
          <div className="mt-4 p-3 bg-danger/15 border border-danger/30 rounded-lg text-danger text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {flagged} item{flagged > 1 ? "s" : ""} flagged —
            management will be notified
          </div>
        )}

        <Button
          onClick={submit}
          disabled={loading}
          className="w-full mt-4 h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold disabled:opacity-60"
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" /> Submitting…
            </>
          ) : items.length === 0 ? (
            "Confirm — no tools to check"
          ) : (
            "Submit checklist"
          )}
        </Button>
      </div>
    </DriverShell>
  );
}
