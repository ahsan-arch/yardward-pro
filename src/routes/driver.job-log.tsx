import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useAuth } from "@/contexts/AuthContext";
import { useData } from "@/contexts/DataContext";
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
import { ArrowLeft, Loader2, ClipboardList, Camera, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { GpsBadge, useGpsCapture } from "@/components/crm/GpsBadge";

export const Route = createFileRoute("/driver/job-log")({
  head: () => ({ meta: [{ title: "Job log — FleetOps" }] }),
  component: Page,
});

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const { jobs } = useData();
  const gps = useGpsCapture(true);
  const myJobs = jobs.filter((j) => j.driverId === user.id);
  const [jobId, setJobId] = useState(myJobs[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ job?: string; note?: string }>({});

  function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPhotos((p) => [...p, reader.result as string]);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof err = {};
    if (!jobId) errs.job = "Pick a job";
    if (!note.trim()) errs.note = "Add a note";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    await new Promise((r) => setTimeout(r, 300));
    toast.success(`Log added to ${jobId}`);
    setLoading(false);
    nav({ to: "/driver" });
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
          <div>
            <Label>Photos (optional)</Label>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
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
