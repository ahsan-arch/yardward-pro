// Native hauling record (dump / load form) — replaces the per-client
// Formstack dump forms for NEW submissions. Captures load type, quantity,
// manual weight, loading location and receiving site, stamps GPS + timestamp
// automatically, and works offline via the shared queue (the submit path in
// api.submitDumpLog enqueues when navigator.onLine is false).
//
// Distinct from /driver/work-order: that flow is the billable work order
// with foreman signature + office approval. This is the regulatory/BOL-style
// hauling log that previously lived in Formstack.

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Loader2, Droplets } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";

export const Route = createFileRoute("/driver/dump-log")({
  head: () => ({ meta: [{ title: "Hauling record — Yardward Pro" }] }),
  component: Page,
});

// Load types mirror what the Formstack history actually contains (liquid
// soil dominates) — "Other" falls back to the free-text notes field.
const LOAD_TYPES = [
  "Liquid soil",
  "Dry soil",
  "Slurry",
  "Street sweepings",
  "Sewage waste",
  "Aggregate",
  "Other",
];

const NONE_JOB = "__none__";

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { jobs } = useData();
  const myJobs = jobs.filter((j) => j.driverId === user.id);
  const [jobId, setJobId] = useState<string>(myJobs[0]?.id ?? NONE_JOB);
  const pickedJob = myJobs.find((j) => j.id === jobId);
  const fallback = useMemo(() => {
    if (pickedJob?.location.lat != null && pickedJob.location.lng != null) {
      return {
        lat: pickedJob.location.lat,
        lng: pickedJob.location.lng,
        label: "Using job site location",
      };
    }
    return null;
  }, [pickedJob?.location.lat, pickedJob?.location.lng]);
  const gps = useGpsCapture(fallback);

  const [loadType, setLoadType] = useState("");
  const [quantity, setQuantity] = useState("");
  const [weight, setWeight] = useState("");
  const [location, setLocation] = useState("");
  const [receivingSite, setReceivingSite] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ loadType?: string; location?: string; weight?: string }>({});

  function useJobAddress() {
    if (pickedJob?.location.address) setLocation(pickedJob.location.address);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof err = {};
    if (!loadType) errs.loadType = "Pick a load type";
    if (!location.trim()) errs.location = "Where was the load picked up?";
    if (!weight.trim() && !quantity.trim()) errs.weight = "Enter a weight or quantity";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      const gpsCoords = gps.result?.ok ? gps.result.coords : null;
      await api.submitDumpLog({
        driverId: user.id,
        jobId: jobId === NONE_JOB ? null : jobId,
        vehicleId: pickedJob?.vehicleId ?? null,
        loadType,
        quantity: quantity.trim(),
        weight: weight.trim(),
        location: location.trim(),
        receivingSite: receivingSite.trim(),
        notes: notes.trim(),
        gpsLat: gpsCoords?.lat ?? null,
        gpsLng: gpsCoords?.lng ?? null,
        loggedAt: new Date().toISOString(),
      });
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      toast.success(
        offline ? "Hauling record saved — will sync when back online" : "Hauling record saved",
      );
      nav({ to: "/driver" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save hauling record");
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
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Droplets className="w-5 h-5" /> Hauling record
          </h1>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Dump / load record — GPS and time are attached automatically.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <Label>Job (optional)</Label>
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger className="h-12 mt-1.5">
                <SelectValue placeholder="No job — standalone record" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_JOB}>No job — standalone record</SelectItem>
                {myJobs.map((j) => (
                  <SelectItem key={j.id} value={j.id}>
                    {j.id} · {j.location.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Load type</Label>
            <Select value={loadType} onValueChange={setLoadType}>
              <SelectTrigger
                className={cn("h-12 mt-1.5", err.loadType && "border-danger")}
                data-testid="dump-load-type"
              >
                <SelectValue placeholder="What was hauled?" />
              </SelectTrigger>
              <SelectContent>
                {LOAD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {err.loadType && <p className="text-xs text-danger mt-1">{err.loadType}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Quantity</Label>
              <Input
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="e.g. 8 m³"
                className="h-12 mt-1.5"
                data-testid="dump-quantity"
              />
            </div>
            <div>
              <Label>Weight</Label>
              <Input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="e.g. 12.4 t"
                className={cn("h-12 mt-1.5", err.weight && "border-danger")}
                data-testid="dump-weight"
              />
            </div>
          </div>
          {err.weight && <p className="text-xs text-danger -mt-2">{err.weight}</p>}

          <div>
            <div className="flex items-center justify-between">
              <Label>Loading location</Label>
              {pickedJob?.location.address && (
                <button
                  type="button"
                  onClick={useJobAddress}
                  className="text-xs text-amber-brand font-medium"
                >
                  Use job address
                </button>
              )}
            </div>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Where the load was picked up"
              className={cn("h-12 mt-1.5", err.location && "border-danger")}
              data-testid="dump-location"
            />
            {err.location && <p className="text-xs text-danger mt-1">{err.location}</p>}
          </div>

          <div>
            <Label>Receiving site (optional)</Label>
            <Input
              value={receivingSite}
              onChange={(e) => setReceivingSite(e.target.value)}
              placeholder="Where the load was dumped"
              className="h-12 mt-1.5"
              data-testid="dump-receiving-site"
            />
          </div>

          <div>
            <Label>Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Anything else about this load…"
              className="mt-1.5"
            />
          </div>

          <Button
            type="submit"
            disabled={loading}
            data-testid="submit-dump-log"
            className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-bold"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Saving…
              </>
            ) : (
              "Save hauling record"
            )}
          </Button>
        </form>
      </div>
    </DriverShell>
  );
}
