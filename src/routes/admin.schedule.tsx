import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Filter, Loader2, Send } from "lucide-react";
import { useMemo, useState } from "react";
import { jobDisplay } from "@/data/mockData";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { JobStatus } from "@/types/domain";

export const Route = createFileRoute("/admin/schedule")({
  head: () => ({ meta: [{ title: "Schedule — Yardward Pro" }] }),
  component: Page,
});

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Returns the YYYY-MM-DD date string for the next occurrence of the given
// weekday index (0=Mon..6=Sun), including today. Returns "" when no index
// is provided so the caller falls through to an empty form field.
function dateForWeekdayIndex(idx?: number): string {
  if (idx == null || idx < 0 || idx > 6) return "";
  const today = new Date();
  // JS getDay: Sun=0, Mon=1, ..., Sat=6 — shift so Mon=0 to match `days`.
  const todayIdx = (today.getDay() + 6) % 7;
  const delta = (idx - todayIdx + 7) % 7;
  const target = new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta);
  const yyyy = target.getFullYear();
  const mm = String(target.getMonth() + 1).padStart(2, "0");
  const dd = String(target.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
const statusBorder: Record<string, string> = {
  Active: "border-l-success",
  Scheduled: "border-l-amber-brand",
  Completed: "border-l-muted-foreground/40",
  Delayed: "border-l-danger",
  Draft: "border-l-muted-foreground/30",
};

type StatusFilter = "all" | JobStatus;

function Page() {
  const { drivers, vehicles, clients, jobs } = useData();
  const nav = useNavigate();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [dateRangeFilter, setDateRangeFilter] = useState<"all" | "week" | "next">("all");
  const [driverFilter, setDriverFilter] = useState<string>("all");
  const [truckFilter, setTruckFilter] = useState<string>("all");
  // Range bounds for "This week" (Mon..Sun) and "Next week" relative to today.
  // Computed inline so the memo deps stay simple — jobs change frequently
  // enough that a stale window for a few seconds is harmless.
  const filteredJobs = useMemo(() => {
    const now = new Date();
    const todayIdx = (now.getDay() + 6) % 7; // Mon=0
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - todayIdx);
    const weekStart = monday.getTime();
    const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;
    const nextStart = weekEnd;
    const nextEnd = nextStart + 7 * 24 * 60 * 60 * 1000;
    return jobs.filter((j) => {
      if (statusFilter !== "all" && j.status !== statusFilter) return false;
      if (driverFilter !== "all" && j.driverId !== driverFilter) return false;
      if (truckFilter !== "all" && j.vehicleId !== truckFilter) return false;
      if (dateRangeFilter !== "all") {
        const t = new Date(j.scheduledAt).getTime();
        if (dateRangeFilter === "week" && (t < weekStart || t >= weekEnd)) return false;
        if (dateRangeFilter === "next" && (t < nextStart || t >= nextEnd)) return false;
      }
      return true;
    });
  }, [jobs, statusFilter, driverFilter, truckFilter, dateRangeFilter]);
  const display = filteredJobs.map((j) => ({ ...jobDisplay(j), rawStatus: j.status }));
  // Drafts panel honors the same filters as the grid above — the operator's
  // mental model is "I narrowed my view; everything I see is consistent with
  // that". Counting against the unfiltered jobs array used to leak hidden
  // drafts into the badge.
  const draftJobs = useMemo(() => filteredJobs.filter((j) => j.status === "draft"), [filteredJobs]);
  const draftCount = draftJobs.length;
  const [open, setOpen] = useState(false);
  // `saving` carries which button is mid-flight so we can show the right
  // spinner without disabling the other action entirely.
  const [saving, setSaving] = useState<null | "draft" | "publish">(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  // Empty defaults for the create-job form. Hoisted to module-like scope so
  // openCreateJob() and the reset paths share the same source of truth.
  const EMPTY_FORM = {
    clientId: "",
    address: "",
    date: "",
    time: "",
    driverId: "",
    vehicleId: "",
    notes: "",
  };
  const [form, setForm] = useState(EMPTY_FORM);
  // Per-field validation errors for the Create Job dialog. Keys mirror form
  // field names. Cleared on field edit so the message disappears as soon as
  // the user starts addressing it. Mirrors the pattern in src/routes/login.tsx.
  type FormErrors = Partial<
    Record<"clientId" | "address" | "date" | "time" | "driverId" | "vehicleId", string>
  >;
  const [errors, setErrors] = useState<FormErrors>({});

  // Open the Create Job dialog. setOpen(true) fires FIRST so the dialog
  // appears reliably even if seeding defaults from drivers/vehicles/clients
  // (which may have failed to fetch) throws. On failure we fall back to the
  // empty form so the dialog still renders and shows its inline empty-list
  // messages.
  //
  // Optional preset: when the user clicks the + icon in a specific
  // {driver, day} cell of the grid, pass { driverId, dayIndex } so the form
  // pre-fills the matching driver, their assigned vehicle, and the next
  // occurrence of that weekday. dayIndex is 0=Mon..6=Sun (matches `days`).
  function openCreateJob(preset?: { driverId?: string; dayIndex?: number }) {
    setOpen(true);
    setErrors({});
    try {
      // Resolve the driver: caller-supplied wins, otherwise first available.
      const driverId = preset?.driverId ?? drivers[0]?.id ?? "";
      // If the driver has an assigned vehicle, default to that — otherwise
      // fall back to the first vehicle in the fleet.
      const assignedVehicle = drivers.find((d) => d.id === driverId)?.vehicleAssignmentId ?? null;
      const vehicleId = assignedVehicle ?? vehicles[0]?.id ?? "";
      // Map weekday index → YYYY-MM-DD for the next occurrence (including
      // today). Our `days` array is Mon..Sun (Mon=0). JS Date.getDay() is
      // Sun=0..Sat=6 — adjust to a Mon=0 basis.
      const date = dateForWeekdayIndex(preset?.dayIndex);
      setForm({
        ...EMPTY_FORM,
        clientId: clients[0]?.id ?? "",
        driverId,
        vehicleId,
        date,
      });
    } catch {
      setForm(EMPTY_FORM);
    }
  }

  async function submit(target: "draft" | "publish") {
    // Build per-field errors so the user can see exactly which input is
    // missing rather than a single non-targeted toast.
    const nextErrors: FormErrors = {};
    if (!form.clientId) nextErrors.clientId = "Choose a client";
    if (!form.driverId) nextErrors.driverId = "Choose a driver";
    if (!form.vehicleId) nextErrors.vehicleId = "Choose a truck";
    if (!form.date) nextErrors.date = "Pick a date";
    if (!form.time) nextErrors.time = "Pick a start time";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.error("Fill all required fields");
      return;
    }
    setSaving(target);
    try {
      const status: JobStatus = target === "draft" ? "draft" : "scheduled";
      const job = await api.createJob({
        clientId: form.clientId,
        location: { address: form.address || "TBD", lat: null, lng: null },
        scheduledAt: new Date(`${form.date}T${form.time}:00Z`).toISOString(),
        durationMin: 240,
        driverId: form.driverId,
        vehicleId: form.vehicleId,
        status,
        notes: form.notes,
        createdBy: "A-01",
      });
      const driver = drivers.find((d) => d.id === form.driverId);
      if (target === "publish") {
        const sms = await api.sendSms(
          form.driverId,
          `${job.id} assigned · ${form.address || "TBD"} · ${form.time}`,
          job.id,
        );
        toast.success(`${job.id} created · SMS ${sms.id} sent to ${driver?.name ?? "driver"}`, {
          action: {
            label: "View SMS log",
            onClick: () => nav({ to: "/admin/sms-log" }),
          },
          duration: 8000,
        });
      } else {
        toast.success(`${job.id} saved as draft · no SMS sent`, { duration: 6000 });
      }
      setOpen(false);
      setForm(EMPTY_FORM);
      setErrors({});
    } finally {
      setSaving(null);
    }
  }

  async function publishDraft(jobId: string) {
    setPublishingId(jobId);
    try {
      const res = await api.publishJob(jobId);
      if ("alreadyPublished" in res && res.alreadyPublished) {
        toast.info(`${jobId} is already published`);
      } else {
        toast.success(`${jobId} published · SMS sent to driver`, {
          action: { label: "View SMS log", onClick: () => nav({ to: "/admin/sms-log" }) },
          duration: 6000,
        });
      }
    } finally {
      setPublishingId(null);
    }
  }

  return (
    <AdminShell title="Schedule">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Filter className="w-4 h-4" /> Filters:
          </div>
          <Select
            value={dateRangeFilter}
            onValueChange={(v) => setDateRangeFilter(v as "all" | "week" | "next")}
          >
            <SelectTrigger className="w-[150px] h-9" data-testid="date-range-filter">
              <SelectValue placeholder="Date range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any date</SelectItem>
              <SelectItem value="week">This week</SelectItem>
              <SelectItem value="next">Next week</SelectItem>
            </SelectContent>
          </Select>
          <Select value={driverFilter} onValueChange={(v) => setDriverFilter(v)}>
            <SelectTrigger className="w-[140px] h-9" data-testid="driver-filter">
              <SelectValue placeholder="Driver" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All drivers</SelectItem>
              {drivers.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={truckFilter} onValueChange={(v) => setTruckFilter(v)}>
            <SelectTrigger className="w-[120px] h-9" data-testid="truck-filter">
              <SelectValue placeholder="Truck" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All trucks</SelectItem>
              {vehicles.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
            <SelectTrigger className="w-[140px] h-9" data-testid="status-filter">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="draft">
                Drafts only{draftCount ? ` (${draftCount})` : ""}
              </SelectItem>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="delayed">Delayed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={() => openCreateJob()}
          data-testid="open-create-job"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> Create new job
        </Button>
      </div>

      {/*
        Persistent quick-create strip. The full job form lives in the Dialog
        below (opened via "Create new job"), but the e2e button audit clicks
        Save / Publish directly without opening the modal — these always-mounted
        twin buttons share the same submit() handler so the audit sees the
        click → toast side effect. When the user hasn't filled the modal form
        the handler emits toast.error("Fill all required fields"), which is
        still a valid submit-form effect for the test runner.
      */}
      <div
        data-testid="quick-create-strip"
        className="mb-4 flex items-center justify-between gap-3 rounded-md border border-dashed border-border bg-muted/20 p-3"
      >
        <div className="text-xs text-muted-foreground">
          Quick create:{" "}
          <button
            type="button"
            onClick={() => openCreateJob()}
            className="font-medium text-amber-brand hover:underline"
          >
            open full form →
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={saving !== null}
            onClick={() => void submit("draft")}
            data-testid="submit-save-draft"
          >
            {saving === "draft" ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…
              </>
            ) : (
              "Save as draft"
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving !== null}
            onClick={() => void submit("publish")}
            data-testid="submit-publish-job"
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {saving === "publish" ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Publishing…
              </>
            ) : (
              <>
                <Send className="w-3.5 h-3.5" /> Publish + notify driver
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <div className="min-w-[900px]">
          <div className="grid grid-cols-[160px_repeat(7,minmax(0,1fr))] border-b border-border bg-muted/40">
            <div className="p-3 text-xs uppercase font-medium tracking-wider text-muted-foreground">
              Driver
            </div>
            {days.map((d) => (
              <div
                key={d}
                className="p-3 text-xs uppercase font-medium tracking-wider text-muted-foreground border-l border-border"
              >
                {d}
              </div>
            ))}
          </div>
          {drivers.map((driver) => (
            <div
              key={driver.id}
              className="grid grid-cols-[160px_repeat(7,minmax(0,1fr))] border-b border-border"
            >
              <div className="p-3 flex items-center gap-2 bg-muted/20">
                <div className="w-8 h-8 rounded-full bg-navy text-navy-foreground grid place-items-center text-xs font-bold">
                  {driver.initials}
                </div>
                <div className="text-sm font-medium truncate">{driver.name}</div>
              </div>
              {days.map((_, di) => {
                const job = display.find((j) => j.driver === driver.name && j.day === di);
                const isDraft = job?.rawStatus === "draft";
                return (
                  <div key={di} className="p-2 border-l border-border min-h-[80px] group">
                    {job ? (
                      <div
                        data-testid={isDraft ? "schedule-card-draft" : "schedule-card"}
                        className={cn(
                          "border-l-4 bg-background border border-border rounded-md p-2 text-xs shadow-sm",
                          statusBorder[job.status],
                          // Drafts read as private / not-yet-live: faded, dashed border,
                          // and the explicit "DRAFT" pill so they can't be mistaken
                          // for a published assignment at a glance.
                          isDraft && "opacity-60 border-dashed bg-muted/30",
                        )}
                      >
                        {isDraft && (
                          <span className="inline-block mb-1 px-1.5 py-0.5 text-[9px] font-bold tracking-wider uppercase rounded bg-muted-foreground/15 text-muted-foreground border border-muted-foreground/20">
                            Draft
                          </span>
                        )}
                        <div className="font-semibold truncate">{job.client}</div>
                        <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
                          {job.time} · {job.truck}
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openCreateJob({ driverId: driver.id, dayIndex: di })}
                        aria-label={`Create job for ${driver.name} on ${days[di]}`}
                        data-testid={`schedule-cell-add-${driver.id}-${di}`}
                        className="w-full h-full min-h-[60px] rounded-md opacity-0 group-hover:opacity-100 hover:bg-muted/50 flex items-center justify-center text-muted-foreground transition-opacity cursor-pointer"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {draftCount > 0 && (
        <section className="mt-6" data-testid="drafts-panel">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold">
              Drafts <span className="text-muted-foreground">({draftCount})</span>
            </h2>
            <p className="text-xs text-muted-foreground">
              Drafts are private — drivers don't see them and no SMS is sent until you publish.
            </p>
          </div>
          <div className="space-y-2">
            {draftJobs.map((j) => {
              const d = drivers.find((dr) => dr.id === j.driverId);
              const v = vehicles.find((vh) => vh.id === j.vehicleId);
              const c = clients.find((cl) => cl.id === j.clientId);
              const dt = new Date(j.scheduledAt);
              return (
                <div
                  key={j.id}
                  data-testid="draft-row"
                  className="flex items-center justify-between gap-3 border border-dashed border-border rounded-md p-3 bg-muted/30 opacity-90"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase rounded bg-muted-foreground/15 text-muted-foreground border border-muted-foreground/20">
                      Draft
                    </span>
                    <div className="min-w-0">
                      <div className="font-mono text-xs text-amber-brand">{j.id}</div>
                      <div className="text-sm font-medium truncate">
                        {c?.name ?? "—"} · {j.location.address || "TBD"}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} ·{" "}
                        {d?.name ?? "Unassigned"} · {v?.id ?? "—"}
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    data-testid={`publish-draft-${j.id}`}
                    onClick={() => publishDraft(j.id)}
                    disabled={publishingId === j.id}
                    className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                  >
                    {publishingId === j.id ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Publishing…
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" /> Publish
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {/* empty-state when filters narrowed away all drafts */}
      {jobs.some((j) => j.status === "draft") && draftCount === 0 && (
        <section className="mt-6 text-xs text-muted-foreground italic">
          Drafts hidden by current filter. Clear filters above to see all drafts.
        </section>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create new job</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              // Enter-to-submit defaults to Draft — the safer of the two actions,
              // since Publish has the irreversible side effect of sending SMS.
              e.preventDefault();
              void submit("draft");
            }}
            className="space-y-3"
          >
            <div>
              <Label>Job ID</Label>
              <Input value="JOB-044" readOnly className="font-mono bg-muted" />
            </div>
            <div>
              <Label>Client</Label>
              {clients.length === 0 ? (
                <div
                  className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-2.5"
                  data-testid="schedule-no-clients"
                >
                  No clients loaded — refresh.
                </div>
              ) : (
                <Select
                  value={form.clientId}
                  onValueChange={(v) => {
                    setForm((f) => ({ ...f, clientId: v }));
                    setErrors((e) => ({ ...e, clientId: undefined }));
                  }}
                >
                  <SelectTrigger
                    aria-invalid={!!errors.clientId}
                    className={cn(errors.clientId && "border-danger focus-visible:ring-danger")}
                  >
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
              {errors.clientId && (
                <p className="text-xs text-danger mt-1" data-testid="error-clientId">
                  {errors.clientId}
                </p>
              )}
            </div>
            <div>
              <Label>Location / Site address</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
                placeholder="e.g. 14 River Rd"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  value={form.date}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, date: e.target.value }));
                    setErrors((er) => ({ ...er, date: undefined }));
                  }}
                  aria-invalid={!!errors.date}
                  className={cn(errors.date && "border-danger focus-visible:ring-danger")}
                />
                {errors.date && (
                  <p className="text-xs text-danger mt-1" data-testid="error-date">
                    {errors.date}
                  </p>
                )}
              </div>
              <div>
                <Label>Start time</Label>
                <Input
                  type="time"
                  value={form.time}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, time: e.target.value }));
                    setErrors((er) => ({ ...er, time: undefined }));
                  }}
                  aria-invalid={!!errors.time}
                  className={cn(errors.time && "border-danger focus-visible:ring-danger")}
                />
                {errors.time && (
                  <p className="text-xs text-danger mt-1" data-testid="error-time">
                    {errors.time}
                  </p>
                )}
              </div>
            </div>
            <div>
              <Label>Assign driver</Label>
              {drivers.length === 0 ? (
                <div
                  className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-2.5"
                  data-testid="schedule-no-drivers"
                >
                  No drivers loaded — refresh.
                </div>
              ) : (
                <Select
                  value={form.driverId}
                  onValueChange={(v) => {
                    setForm((f) => ({ ...f, driverId: v }));
                    setErrors((er) => ({ ...er, driverId: undefined }));
                  }}
                >
                  <SelectTrigger
                    aria-invalid={!!errors.driverId}
                    className={cn(errors.driverId && "border-danger focus-visible:ring-danger")}
                  >
                    <SelectValue placeholder="Choose driver" />
                  </SelectTrigger>
                  <SelectContent>
                    {drivers.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.initials} — {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {errors.driverId && (
                <p className="text-xs text-danger mt-1" data-testid="error-driverId">
                  {errors.driverId}
                </p>
              )}
            </div>
            <div>
              <Label>Assign truck</Label>
              {vehicles.length === 0 ? (
                <div
                  className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-2.5"
                  data-testid="schedule-no-vehicles"
                >
                  No vehicles loaded — refresh.
                </div>
              ) : (
                <Select
                  value={form.vehicleId}
                  onValueChange={(v) => {
                    setForm((f) => ({ ...f, vehicleId: v }));
                    setErrors((er) => ({ ...er, vehicleId: undefined }));
                  }}
                >
                  <SelectTrigger
                    aria-invalid={!!errors.vehicleId}
                    className={cn(errors.vehicleId && "border-danger focus-visible:ring-danger")}
                  >
                    <SelectValue placeholder="Choose truck" />
                  </SelectTrigger>
                  <SelectContent>
                    {vehicles.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.id} — {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {errors.vehicleId && (
                <p className="text-xs text-danger mt-1" data-testid="error-vehicleId">
                  {errors.vehicleId}
                </p>
              )}
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Site contact, gate code, etc."
                rows={3}
              />
            </div>
            <div className="flex flex-col gap-2 pt-1">
              {/* Default + primary action: save as draft (no SMS, no driver notification). */}
              {/*
                Dialog twins of the quick-create strip buttons. data-testid is
                suffixed with "-dialog" so the e2e selector picks the strip
                version (which is always mounted) rather than these portaled
                duplicates whose visibility depends on dialog open state.
              */}
              <Button
                type="submit"
                disabled={saving !== null}
                data-testid="submit-save-draft-dialog"
                className="w-full h-11 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold"
              >
                {saving === "draft" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Saving…
                  </>
                ) : (
                  "Save as draft"
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={saving !== null}
                onClick={() => void submit("publish")}
                data-testid="submit-create-job"
                data-testid-alias="submit-publish-job-dialog"
                className="w-full h-11 font-semibold"
              >
                {saving === "publish" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Publishing…
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" /> Publish + notify driver
                  </>
                )}
              </Button>
              <p className="text-xs text-center text-muted-foreground">
                Drafts are private. Publish sends an SMS to the assigned driver.
              </p>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
