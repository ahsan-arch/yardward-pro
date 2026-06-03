import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Check, AlertTriangle, Loader2, Wrench, Sun, Moon } from "lucide-react";
import { useState } from "react";
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
  head: () => ({ meta: [{ title: "Tool checklist — FleetOps" }] }),
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
  const [items, setItems] = useState(
    tools.map((t) => ({
      toolId: t.id,
      name: t.name,
      status: t.condition as ToolCondition,
      notes: "",
    })),
  );
  const [loading, setLoading] = useState(false);
  const flagged = items.filter((i) => i.status !== "ok").length;

  function setStatus(idx: number, next: ToolCondition) {
    setItems((arr) => arr.map((x, i) => (i === idx ? { ...x, status: next } : x)));
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
      };
      if (!isOnline) {
        await offlineQueue.enqueue({ kind: "toolChecklist", payload });
        toast.success("Saved offline — will sync when connection returns");
      } else {
        await api.submitToolChecklist(payload);
        toast.success(flagged ? `Checklist submitted · ${flagged} flagged` : "Checklist submitted");
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
            <h1 className="text-xl font-bold">Tool checklist — TRK-07</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {kind === "end_of_shift"
                ? "Confirm every tool is back on the truck before clocking out."
                : "Mark each item: OK, damaged, or missing."}
            </p>
          </div>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>

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
          className="w-full mt-4 h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold"
        >
          {loading ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" /> Submitting…
            </>
          ) : (
            "Submit checklist"
          )}
        </Button>
      </div>
    </DriverShell>
  );
}
