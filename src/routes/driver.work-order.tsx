import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";
import { offlineQueue } from "@/lib/offline-queue";
import { useOffline } from "@/contexts/OfflineContext";
import { useData } from "@/contexts/DataContext";
import { useMemo } from "react";
import { clearDriverTokenSession, readDriverTokenSession } from "@/hooks/use-driver-token-scope";

export const Route = createFileRoute("/driver/work-order")({
  head: () => ({ meta: [{ title: "New work order — Engage Hydrovac CRM" }] }),
  component: Page,
});

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { isOnline } = useOffline();
  const { jobs } = useData();
  // Real drivers(id) uuid. A /t/<token> session carries it in sessionStorage;
  // a password-logged-in driver has profiles.id === drivers.id so user.id works.
  // AuthContext leaves user.id at the mock "A-01" for token sessions, so don't
  // trust it blindly.
  const driverId = readDriverTokenSession()?.driverId ?? user.id;
  // File against a job that actually exists in the DB. The old hardcoded
  // "JOB-041" is mockData-only and absent from the Supabase jobs table, so it
  // violated work_orders_job_id_fkey on every submit.
  const currentJob = jobs.find(
    (j) => j.driverId === driverId && (j.status === "scheduled" || j.status === "active"),
  );
  const fallback = useMemo(() => {
    if (currentJob?.location.lat != null && currentJob.location.lng != null) {
      return {
        lat: currentJob.location.lat,
        lng: currentJob.location.lng,
        label: "Using job site location",
      };
    }
    return null;
  }, [currentJob?.location.lat, currentJob?.location.lng]);
  const gps = useGpsCapture(fallback);
  const [work, setWork] = useState("");
  const [load, setLoad] = useState("");
  const [weight, setWeight] = useState("");
  const [dump, setDump] = useState("");
  const [issues, setIssues] = useState(false);
  const [hasSig, setHasSig] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ticketPhoto, setTicketPhoto] = useState<string | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.strokeStyle = "#0F1C2E";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
  }, []);

  function pos(e: any) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    const t = e.touches?.[0] || e;
    return {
      x: (t.clientX - r.left) * (c.width / r.width),
      y: (t.clientY - r.top) * (c.height / r.height),
    };
  }
  function start(e: any) {
    drawing.current = true;
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }
  function move(e: any) {
    if (!drawing.current) return;
    e.preventDefault?.();
    const ctx = canvasRef.current!.getContext("2d")!;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setHasSig(true);
  }
  function end() {
    drawing.current = false;
  }
  function clear() {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    setHasSig(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!work.trim()) errs.work = "Required";
    if (!load) errs.load = "Required";
    if (!weight || isNaN(+weight)) errs.weight = "Enter valid weight";
    if (!dump.trim()) errs.dump = "Required";
    if (!hasSig) errs.sig = "Signature required";
    // Fail closed client-side: never send a work order with a missing/mock
    // job_id or driver_id (both are NOT NULL FKs to jobs / drivers).
    if (!currentJob) errs.job = "No active job assigned to you — contact dispatch";
    setErr(errs);
    if (Object.keys(errs).length) {
      if (errs.job) toast.error(errs.job);
      return;
    }
    // Redundant past the guard above, but narrows currentJob to non-null for
    // the payload below.
    if (!currentJob) return;
    setLoading(true);
    try {
      const sig = canvasRef.current?.toDataURL("image/png") ?? "";
      const payload = {
        jobId: currentJob.id,
        driverId,
        workPerformed: work,
        loadType: load,
        weightTonnes: +weight,
        dumpSite: dump,
        gpsCapture: gps.coords
          ? { lat: gps.coords.lat, lng: gps.coords.lng, capturedAt: new Date().toISOString() }
          : null,
        foremanSignature: sig,
        siteIssues: issues,
        siteIssuesNote: "",
        approvedBy: null,
        approvedAt: null,
        invoiceDataId: null,
      };
      // A work order is the terminal action for a scope='job' token — once
      // it's submitted the driver has no further legitimate use for the link,
      // so we burn it server-side. Tokens with other scopes (shift / forms)
      // are NOT consumed here; their lifecycle ends on end-of-day or the
      // forms flow respectively.
      const token = sessionStorage.getItem("fo:driver-token");
      const tokenScope = sessionStorage.getItem("fo:driver-token-scope");
      const isJobToken = token && tokenScope === "job";
      if (!isOnline) {
        // Couple the consume to the submission via consumeTokenAfter so the
        // token burns only after the WO lands. A separate queue item could
        // otherwise burn before the WO (race) or burn even when the WO
        // itself was dead-lettered (data loss + locked-out driver).
        await offlineQueue.enqueue({
          kind: "workOrder",
          payload,
          consumeTokenAfter: isJobToken && token ? token : null,
        });
        // Defer the photo upload too. The queue caps total localStorage usage;
        // if the photo would overflow we keep the work order queued and surface
        // a real error so the driver knows the image didn't save.
        let photoFailed = false;
        if (ticketPhoto) {
          try {
            await offlineQueue.enqueue({
              kind: "ticketPhoto",
              payload: { driverId, jobId: payload.jobId, dataUrl: ticketPhoto },
            });
          } catch (err) {
            photoFailed = true;
            toast.error(
              "Work order saved offline, but the ticket photo is too large for offline storage. " +
                "Reconnect and re-capture the photo to attach it.",
            );
            console.warn("offlineQueue.enqueue(ticketPhoto) failed:", err);
          }
        }
        // (Token consume is coupled to the workOrder enqueue above via
        // consumeTokenAfter — no separate queue item.)
        if (!photoFailed) {
          toast.success("Saved offline — will sync when connection returns");
        }
      } else {
        await api.submitWorkOrder(payload);
        if (ticketPhoto) {
          // Fire-and-forget toast on failure so a flaky Storage upload
          // doesn't block the work-order success message — the actual error
          // gets surfaced via api.ts -> reportErrorToServer.
          try {
            await api.uploadTicketPhoto({
              driverId,
              jobId: payload.jobId,
              dataUrl: ticketPhoto,
            });
          } catch (err) {
            toast.error(
              `Ticket photo upload failed: ${err instanceof Error ? err.message : "unknown error"}`,
            );
          }
        }
        if (isJobToken && token) {
          const claimed = await api.consumeDriverToken(token);
          if (claimed) {
            clearDriverTokenSession();
          } else {
            toast.warning(
              "Work order submitted, but the access link couldn't be revoked. Contact dispatch if it was reshared.",
            );
          }
        }
        toast.success("Work order submitted for approval");
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
          className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold">New work order</h1>
            <p className="text-sm text-muted-foreground">JOB-041 — Maple City Council</p>
          </div>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <Label>Work performed</Label>
            <Textarea
              value={work}
              onChange={(e) => setWork(e.target.value)}
              rows={5}
              placeholder="Describe the work completed on site..."
              className={cn("mt-1.5 text-base", err.work && "border-danger")}
            />
            {err.work && <p className="text-xs text-danger mt-1">{err.work}</p>}
          </div>
          <div>
            <Label>Load type</Label>
            <Select value={load} onValueChange={setLoad}>
              <SelectTrigger className={cn("h-12 mt-1.5", err.load && "border-danger")}>
                <SelectValue placeholder="Select load type" />
              </SelectTrigger>
              <SelectContent>
                {["Mixed fill", "Clean fill", "Concrete", "Asphalt", "Green waste", "Other"].map(
                  (o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Load weight (tonnes)</Label>
            <Input
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className={cn("h-12 mt-1.5 font-mono text-base", err.weight && "border-danger")}
            />
            {err.weight && <p className="text-xs text-danger mt-1">{err.weight}</p>}
          </div>
          <div>
            <Label>Dump site location</Label>
            <Input
              value={dump}
              onChange={(e) => setDump(e.target.value)}
              className={cn("h-12 mt-1.5", err.dump && "border-danger")}
            />
          </div>
          <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg border border-border">
            <Label>Any site issues?</Label>
            <Switch checked={issues} onCheckedChange={setIssues} />
          </div>

          <div>
            <Label>Ticket photo (optional)</Label>
            {ticketPhoto ? (
              <div className="mt-1.5 relative">
                <img
                  src={ticketPhoto}
                  alt="ticket"
                  className="w-full rounded-lg border border-border"
                />
                <button
                  type="button"
                  onClick={() => setTicketPhoto(null)}
                  className="absolute top-2 right-2 px-2 py-1 bg-black/60 text-white text-xs rounded"
                >
                  Remove
                </button>
              </div>
            ) : (
              <label className="mt-1.5 block h-24 rounded-lg border-2 border-dashed border-border grid place-items-center text-muted-foreground cursor-pointer hover:border-amber-brand">
                <span className="text-sm">Tap to take photo of weighbridge ticket</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const r = new FileReader();
                    r.onload = () => setTicketPhoto(r.result as string);
                    r.readAsDataURL(f);
                  }}
                />
              </label>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              Mgmt will enter weight + location from this photo
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label>Foreman signature</Label>
              <button type="button" onClick={clear} className="text-xs text-amber-brand">
                Clear
              </button>
            </div>
            <div
              className={cn(
                "border-2 border-dashed rounded-lg bg-card relative",
                err.sig ? "border-danger" : "border-border",
              )}
            >
              <canvas
                ref={canvasRef}
                width={600}
                height={200}
                className="w-full h-[200px] touch-none rounded-lg"
                onMouseDown={start}
                onMouseMove={move}
                onMouseUp={end}
                onMouseLeave={end}
                onTouchStart={start}
                onTouchMove={move}
                onTouchEnd={end}
              />
              {!hasSig && (
                <div className="absolute inset-0 grid place-items-center pointer-events-none text-muted-foreground text-sm">
                  Ask foreman to sign here
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Have the site foreman sign on your device
            </p>
            {err.sig && <p className="text-xs text-danger mt-1">{err.sig}</p>}
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
              "Submit work order"
            )}
          </Button>
        </form>
      </div>
    </DriverShell>
  );
}
