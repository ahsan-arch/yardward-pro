import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { jobDisplay } from "@/data/mockData";
import { useData } from "@/contexts/DataContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowUpDown, Loader2, Send } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// Empty defaults for the New-Job form. Hoisted so the click handler can fall
// back to these if building defaults from contextual data ever throws.
const EMPTY_NEW_JOB_FORM = {
  clientId: "",
  address: "",
  date: "",
  time: "",
  driverId: "",
  vehicleId: "",
  notes: "",
};

export const Route = createFileRoute("/admin/jobs")({
  head: () => ({ meta: [{ title: "Jobs — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { jobs, drivers, vehicles, clients } = useData();
  // Keep the raw status alongside the display row so we can spot drafts
  // without re-deriving from the lowercased mock-data string.
  const rows = jobs.map((j) => ({ ...jobDisplay(j), rawStatus: j.status }));
  type Row = (typeof rows)[number];
  const [sort, setSort] = useState<{ k: keyof Row; dir: 1 | -1 }>({ k: "id", dir: 1 });
  const sorted = [...rows].sort(
    (a, b) => (((a[sort.k] ?? "") as any) > ((b[sort.k] ?? "") as any) ? 1 : -1) * sort.dir,
  );
  const toggle = (k: any) => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : 1 }));
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [newJobForm, setNewJobForm] = useState(EMPTY_NEW_JOB_FORM);
  const [savingJob, setSavingJob] = useState(false);

  // Open the New Job dialog. setOpen(true) fires FIRST so the dialog always
  // appears, even if reading from the (possibly fetch-failed) drivers /
  // vehicles / clients lists throws while we build form defaults. On failure
  // we fall back to EMPTY_NEW_JOB_FORM so the form still renders.
  function openNewJob() {
    setNewJobOpen(true);
    try {
      // Pre-fill the first available client/driver/vehicle if any. Reading
      // d.id on undefined is what would throw if the list arrived empty
      // from a failed fetch — the try/catch keeps the click reliable.
      setNewJobForm({
        ...EMPTY_NEW_JOB_FORM,
        clientId: clients[0]?.id ?? "",
        driverId: drivers[0]?.id ?? "",
        vehicleId: vehicles[0]?.id ?? "",
      });
    } catch {
      setNewJobForm(EMPTY_NEW_JOB_FORM);
    }
  }

  async function submitNewJob() {
    if (!newJobForm.clientId || !newJobForm.driverId || !newJobForm.vehicleId) {
      toast.error("Pick a client, driver, and vehicle first");
      return;
    }
    setSavingJob(true);
    try {
      const when = newJobForm.date && newJobForm.time
        ? new Date(`${newJobForm.date}T${newJobForm.time}:00Z`).toISOString()
        : new Date().toISOString();
      const job = await api.createJob({
        clientId: newJobForm.clientId,
        location: { address: newJobForm.address || "TBD", lat: null, lng: null },
        scheduledAt: when,
        durationMin: 240,
        driverId: newJobForm.driverId,
        vehicleId: newJobForm.vehicleId,
        status: "draft",
        notes: newJobForm.notes,
        createdBy: "A-01",
      });
      toast.success(`${job.id} saved as draft`);
      setNewJobOpen(false);
      setNewJobForm(EMPTY_NEW_JOB_FORM);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create job");
    } finally {
      setSavingJob(false);
    }
  }

  async function publishDraft(jobId: string) {
    setPublishingId(jobId);
    try {
      const res = await api.publishJob(jobId);
      if ("alreadyPublished" in res && res.alreadyPublished) {
        toast.info(`${jobId} is already published`);
      } else {
        toast.success(`${jobId} published · SMS sent to driver`);
      }
    } finally {
      setPublishingId(null);
    }
  }

  return (
    <AdminShell title="Jobs">
      <div className="flex gap-2 mb-4">
        <Input placeholder="Search jobs…" className="max-w-sm" />
        <Button
          onClick={openNewJob}
          data-testid="open-new-job"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 ml-auto"
        >
          New job
        </Button>
      </div>

      <Dialog open={newJobOpen} onOpenChange={setNewJobOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New job</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Client</Label>
              {clients.length === 0 ? (
                <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-3">
                  No clients available — add one first.
                </div>
              ) : (
                <Select
                  value={newJobForm.clientId}
                  onValueChange={(v) => setNewJobForm((f) => ({ ...f, clientId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose client" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <Label>Address</Label>
              <Input
                value={newJobForm.address}
                onChange={(e) => setNewJobForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="e.g. 14 River Rd"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={newJobForm.date}
                  onChange={(e) => setNewJobForm((f) => ({ ...f, date: e.target.value }))}
                />
              </div>
              <div>
                <Label>Time</Label>
                <Input
                  type="time"
                  value={newJobForm.time}
                  onChange={(e) => setNewJobForm((f) => ({ ...f, time: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Driver</Label>
              {drivers.length === 0 ? (
                <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-3">
                  No drivers available — add one first.
                </div>
              ) : (
                <Select
                  value={newJobForm.driverId}
                  onValueChange={(v) => setNewJobForm((f) => ({ ...f, driverId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose driver" />
                  </SelectTrigger>
                  <SelectContent>
                    {drivers.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <Label>Vehicle</Label>
              {vehicles.length === 0 ? (
                <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-3">
                  No vehicles available — add one first.
                </div>
              ) : (
                <Select
                  value={newJobForm.vehicleId}
                  onValueChange={(v) => setNewJobForm((f) => ({ ...f, vehicleId: v }))}
                >
                  <SelectTrigger>
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
              )}
            </div>
            <Button
              onClick={submitNewJob}
              disabled={savingJob}
              data-testid="submit-new-job"
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              {savingJob ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                </>
              ) : (
                "Save as draft"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <div className="bg-card border border-border rounded-lg overflow-x-auto shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {(["id", "client", "location", "driver", "truck", "status", "time"] as const).map(
                (c) => (
                  <th key={c} className="text-left font-medium px-4 py-3">
                    <button
                      onClick={() => toggle(c)}
                      className="flex items-center gap-1 hover:text-foreground"
                    >
                      {c} <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                ),
              )}
              <th className="text-left font-medium px-4 py-3">actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((j) => {
              const isDraft = j.rawStatus === "draft";
              return (
                <tr
                  key={j.id}
                  data-testid={isDraft ? "jobs-row-draft" : "jobs-row"}
                  className={cn(
                    "border-t border-border hover:bg-muted/30",
                    // Drafts are visually de-emphasised in the master list so
                    // they read as "not yet live".
                    isDraft && "opacity-60 bg-muted/20",
                  )}
                >
                  <td className="px-4 py-3 font-mono text-xs">{j.id}</td>
                  <td className="px-4 py-3">{j.client}</td>
                  <td className="px-4 py-3 text-muted-foreground">{j.location}</td>
                  <td className="px-4 py-3">{j.driver}</td>
                  <td className="px-4 py-3 font-mono text-xs">{j.truck}</td>
                  <td className="px-4 py-3">
                    {isDraft ? (
                      <span
                        data-testid="draft-badge"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold tracking-wider uppercase border bg-muted-foreground/15 text-muted-foreground border-muted-foreground/20"
                      >
                        Draft
                      </span>
                    ) : (
                      <StatusBadge status={j.status} />
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono">{j.time}</td>
                  <td className="px-4 py-3">
                    {isDraft && (
                      <Button
                        size="sm"
                        data-testid={`publish-draft-${j.id}`}
                        onClick={() => publishDraft(j.id)}
                        disabled={publishingId === j.id}
                        className="h-7 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                      >
                        {publishingId === j.id ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" /> Publishing…
                          </>
                        ) : (
                          <>
                            <Send className="w-3 h-3" /> Publish
                          </>
                        )}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
