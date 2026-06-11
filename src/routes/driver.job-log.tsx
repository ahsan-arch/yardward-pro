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
import { ArrowLeft, Loader2, ClipboardList } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";
import { useMemo } from "react";

export const Route = createFileRoute("/driver/job-log")({
  head: () => ({ meta: [{ title: "Job log — Engage Hydrovac CRM" }] }),
  component: Page,
});

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { jobs } = useData();
  const myJobs = jobs.filter((j) => j.driverId === user.id);
  const [jobId, setJobId] = useState(myJobs[0]?.id ?? "");
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
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ job?: string; note?: string }>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof err = {};
    if (!jobId) errs.job = "Pick a job";
    if (!note.trim()) errs.note = "Add a note";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      const gpsCoords = gps.result?.ok ? gps.result.coords : null;
      await api.submitJobLog({
        jobId,
        driverId: user.id,
        // Vehicle is denormalised onto the log so admins can spot which truck
        // was on-site for the note even after the job/driver reassignment.
        vehicleId: pickedJob?.vehicleId ?? null,
        body: note.trim(),
        gpsLat: gpsCoords?.lat ?? null,
        gpsLng: gpsCoords?.lng ?? null,
        loggedAt: new Date().toISOString(),
      });
      toast.success(`Log added to ${jobId}`);
      nav({ to: "/driver" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save job log");
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
            <ClipboardList className="w-5 h-5" /> Job log
          </h1>
          <GpsBadge result={gps.result} loading={gps.loading} onRetry={gps.refresh} />
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Quick note for the current job — separate from your dump/load work order.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <Label>Job</Label>
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger className={cn("h-12 mt-1.5", err.job && "border-danger")}>
                <SelectValue placeholder="Choose job" />
              </SelectTrigger>
              <SelectContent>
                {myJobs.map((j) => (
                  <SelectItem key={j.id} value={j.id}>
                    {j.id} · {j.location.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Note</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              placeholder="Anything to log about this job…"
              className={cn("mt-1.5", err.note && "border-danger")}
            />
            {err.note && <p className="text-xs text-danger mt-1">{err.note}</p>}
          </div>
          <Button
            type="submit"
            disabled={loading}
            className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-bold"
          >
            {loading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Saving…
              </>
            ) : (
              "Save job log"
            )}
          </Button>
        </form>
      </div>
    </DriverShell>
  );
}
