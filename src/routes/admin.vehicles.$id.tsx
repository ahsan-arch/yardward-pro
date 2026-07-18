import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { driverById } from "@/data/mockData";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  MapPin,
  Wrench,
  Fuel,
  Truck,
  Calendar,
  Activity,
  ClipboardCheck,
  Plus,
  Paperclip,
  Pencil,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { VehicleMap } from "@/components/crm/VehicleMap";
import type { Tool, ToolCondition } from "@/types/domain";

// Radix Select rejects an empty-string item value, so the "unassigned" pool
// needs a sentinel — same pattern as NONE_JOB in driver.dump-log.tsx.
const UNASSIGNED = "__unassigned__";

export const Route = createFileRoute("/admin/vehicles/$id")({
  head: () => ({ meta: [{ title: "Vehicle detail — Engage Hydrovac CRM" }] }),
  component: Page,
});

function Page() {
  const { id } = useParams({ from: "/admin/vehicles/$id" });
  const { vehicles, maintenanceLogs, fuelLogs, tools, drivers } = useData();
  const { user } = useAuth();
  const v = vehicles.find((x) => x.id === id);
  const [tele, setTele] = useState<{ lat: number; lng: number; capturedAt: string } | null>(null);
  const [maintOpen, setMaintOpen] = useState(false);
  const [fuelOpen, setFuelOpen] = useState(false);
  const [openLogId, setOpenLogId] = useState<string | null>(null);
  const [toolDialogOpen, setToolDialogOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<Tool | null>(null);
  const [deletingToolId, setDeletingToolId] = useState<string | null>(null);

  useEffect(() => {
    // Swallow telematics fetch failures so the rest of the page still
    // renders. A missing Geotab row should not turn the vehicle detail
    // page into a blank screen — the Refresh location button stays
    // reachable so the admin can retry.
    if (v) {
      api.fetchGeotabLocation(v.id).then(setTele).catch(() => setTele(null));
    }
  }, [v]);

  if (!v)
    return (
      <AdminShell title="Vehicle">
        <div className="text-center py-12">
          <p className="text-sm text-muted-foreground">Vehicle not found.</p>
          <Link
            to="/admin/vehicles"
            className="inline-flex items-center gap-1 mt-3 text-amber-brand text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Back to vehicles
          </Link>
        </div>
      </AdminShell>
    );

  const logs = maintenanceLogs.filter((l) => l.vehicleId === v.id);
  const fuel = fuelLogs.filter((f) => f.vehicleId === v.id);
  const assignedTools = tools.filter((t) => t.vehicleId === v.id);
  const driver = driverById(v.driverId);
  const openLog = openLogId ? logs.find((l) => l.id === openLogId) : null;

  return (
    <AdminShell title={`${v.id} — ${v.name}`}>
      <Link
        to="/admin/vehicles"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Back to vehicles
      </Link>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <Card>
          <SectionLabel icon={Truck}>Profile</SectionLabel>
          <div className="space-y-1.5 text-sm">
            <Row k="Plate" v={v.plate} mono />
            <Row k="Year" v={`${v.year}`} />
            <Row k="Type" v={v.type} />
            <Row k="VIN" v={v.vin} mono />
            <Row k="Driver" v={driver?.name ?? "Unassigned"} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusBadge
              status={
                v.status === "operational"
                  ? "Operational"
                  : v.status === "maintenance"
                    ? "In maintenance"
                    : "Out of service"
              }
            />
            <PretripBadge lastAt={v.lastPretripAt ?? null} />
          </div>
        </Card>

        <Card>
          <SectionLabel icon={Activity}>Geotab telematics</SectionLabel>
          <div className="space-y-1.5 text-sm">
            <Row k="Odometer" v={`${v.odometer.toLocaleString()} km`} mono />
            <Row k="Engine hours" v={`${v.engineHours.toLocaleString()}h`} mono />
            <Row k="Last service" v={v.lastService} />
            <Row k="Next service" v={v.nextServiceDue} />
            {tele && <Row k="Last GPS" v={`${tele.lat.toFixed(4)}, ${tele.lng.toFixed(4)}`} mono />}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={async () => {
              try {
                const fresh = await api.fetchGeotabLocation(v.id);
                setTele(fresh);
                toast.success("Refreshed from Geotab");
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                toast.error(`Refresh failed: ${msg}`);
              }
            }}
          >
            <MapPin className="w-3.5 h-3.5" /> Refresh location
          </Button>
          <div className="mt-3 -mx-4 -mb-4 border-t border-border overflow-hidden">
            <VehicleMap
              key={tele?.capturedAt ?? "init"}
              vehicles={[v]}
              height="220px"
              autoRefreshMs={0}
              interactive
              showSidebar={false}
              focusVehicleId={v.id}
            />
          </div>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionLabel icon={Wrench}>Tools assigned</SectionLabel>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              onClick={() => {
                setEditingTool(null);
                setToolDialogOpen(true);
              }}
            >
              <Plus className="w-3.5 h-3.5" /> Add
            </Button>
          </div>
          {assignedTools.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No tools assigned.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {assignedTools.map((t) => (
                <li key={t.id} className="flex items-center justify-between group">
                  <span className="truncate">{t.name}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span
                      className={`text-xs font-mono uppercase ${t.condition === "ok" ? "text-success" : t.condition === "damaged" ? "text-amber-brand" : "text-danger"}`}
                    >
                      {t.condition}
                    </span>
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-muted text-muted-foreground opacity-0 group-hover:opacity-100"
                      onClick={() => {
                        setEditingTool(t);
                        setToolDialogOpen(true);
                      }}
                      aria-label={`Edit ${t.name}`}
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      className="p-1 rounded hover:bg-danger/10 text-muted-foreground hover:text-danger opacity-0 group-hover:opacity-100"
                      onClick={() => setDeletingToolId(t.id)}
                      aria-label={`Remove ${t.name}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionLabel icon={Wrench}>Maintenance log</SectionLabel>
          <Button
            size="sm"
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            onClick={() => setMaintOpen(true)}
          >
            Schedule service
          </Button>
        </div>
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No maintenance history yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Date</th>
                <th className="text-left font-medium px-3 py-2">Type</th>
                <th className="text-left font-medium px-3 py-2">Mileage</th>
                <th className="text-left font-medium px-3 py-2">By</th>
                <th className="text-left font-medium px-3 py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr
                  key={l.id}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                  onClick={() => setOpenLogId(l.id)}
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    <Calendar className="w-3 h-3 inline -mt-0.5 mr-1" />
                    {l.date}
                  </td>
                  <td className="px-3 py-2">{l.type}</td>
                  <td className="px-3 py-2 font-mono">{l.mileage.toLocaleString()}</td>
                  <td className="px-3 py-2 text-muted-foreground">{l.performedBy}</td>
                  <td className="px-3 py-2 font-mono">${l.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Sheet open={!!openLogId} onOpenChange={(o) => !o && setOpenLogId(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {openLog && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Wrench className="w-4 h-4" /> {openLog.type}
                </SheetTitle>
              </SheetHeader>
              <div className="space-y-4 mt-6">
                <Field k="Date" v={openLog.date} />
                <Field k="Mileage" v={`${openLog.mileage.toLocaleString()} mi`} />
                <Field k="Performed by" v={openLog.performedBy} />
                <Field k="Cost" v={`$${openLog.cost}`} />
                <Field k="Notes" v={openLog.notes || "—"} />
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                    Attachments
                  </div>
                  {openLog.attachments.length === 0 ? (
                    <div className="mt-0.5 text-sm text-muted-foreground">
                      No attachments recorded.
                    </div>
                  ) : (
                    <div className="mt-1 space-y-1">
                      {openLog.attachments.map((a) => (
                        <div key={a} className="flex items-center gap-2 text-sm">
                          <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{a}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <div className="mt-4">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionLabel icon={Fuel}>Fuel log</SectionLabel>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFuelOpen(true)}
            >
              <Plus className="w-4 h-4" /> Add fuel entry
            </Button>
          </div>
          {fuel.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No fuel entries yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Date</th>
                  <th className="text-left font-medium px-3 py-2">Gallons</th>
                  <th className="text-left font-medium px-3 py-2">Cost</th>
                  <th className="text-left font-medium px-3 py-2">Location</th>
                  <th className="text-left font-medium px-3 py-2">Driver</th>
                </tr>
              </thead>
              <tbody>
                {fuel.map((f) => (
                  <tr key={f.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{f.date}</td>
                    <td className="px-3 py-2 font-mono">{f.gallons}</td>
                    <td className="px-3 py-2 font-mono">${f.cost}</td>
                    <td className="px-3 py-2">{f.location}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {driverById(f.driverId)?.name ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <ScheduleServiceDialog
        open={maintOpen}
        onOpenChange={setMaintOpen}
        vehicleId={v.id}
        defaultPerformedBy={user?.name ?? "Admin"}
      />
      <AddFuelDialog
        open={fuelOpen}
        onOpenChange={setFuelOpen}
        vehicleId={v.id}
        defaultDriverId={v.driverId ?? drivers[0]?.id ?? ""}
        drivers={drivers}
      />
      <ToolDialog
        open={toolDialogOpen}
        onOpenChange={setToolDialogOpen}
        vehicleId={v.id}
        tool={editingTool}
      />
      <Dialog open={!!deletingToolId} onOpenChange={(o) => !o && setDeletingToolId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove tool?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This deletes the tool record entirely — it will no longer appear on{" "}
            {v.id}&apos;s driver tool checklist. This can&apos;t be undone.
          </p>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setDeletingToolId(null)}>
              Cancel
            </Button>
            <Button
              className="bg-danger text-danger-foreground hover:bg-danger/90"
              onClick={async () => {
                const id = deletingToolId!;
                setDeletingToolId(null);
                try {
                  await api.deleteTool(id);
                  toast.success("Tool removed");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Could not remove tool");
                }
              }}
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4">
      {children}
    </div>
  );
}
function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
        {k}
      </div>
      <div className="mt-0.5 text-sm">{v}</div>
    </div>
  );
}
function SectionLabel({ children, icon: Icon }: { children: React.ReactNode; icon: typeof Truck }) {
  return (
    <h3 className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-3 flex items-center gap-1.5">
      <Icon className="w-3 h-3" />
      {children}
    </h3>
  );
}
function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{v}</span>
    </div>
  );
}

// Schedule-service dialog: shared shape with mechanic.maintenance so the audit
// trail is consistent regardless of which role recorded the entry.
function ScheduleServiceDialog({
  open,
  onOpenChange,
  vehicleId,
  defaultPerformedBy,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  vehicleId: string;
  defaultPerformedBy: string;
}) {
  const [type, setType] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [mileage, setMileage] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setType("");
    setDate(new Date().toISOString().slice(0, 10));
    setMileage("");
    setCost("");
    setNotes("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const mileageNum = Number(mileage);
    const costNum = Number(cost);
    if (!Number.isFinite(mileageNum) || mileageNum < 0) {
      toast.error("Mileage must be a non-negative number");
      return;
    }
    if (!Number.isFinite(costNum) || costNum < 0) {
      toast.error("Cost must be a non-negative number");
      return;
    }
    setSaving(true);
    try {
      await api.addMaintenanceLog({
        vehicleId,
        type,
        performedBy: defaultPerformedBy,
        date,
        mileage: mileageNum,
        cost: costNum,
        notes,
        attachments: [],
      });
      toast.success("Service scheduled");
      resetForm();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save log");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset on close so reopening doesn't show stale text — guards against
        // cross-vehicle data leaks if the dialog is reused at the page level.
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule service — {vehicleId}</DialogTitle>
        </DialogHeader>
        {/*
          Validation lives in handleSubmit() rather than HTML5 `required` so the
          button-audit e2e (which clicks Submit on an empty form) still sees a
          toast.error response instead of being blocked silently by the browser's
          built-in form validation.
        */}
        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div>
            <Label>Service type</Label>
            <Input
              placeholder="e.g. Oil change"
              value={type}
              onChange={(e) => setType(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Mileage</Label>
              <Input
                type="number"
                className="font-mono"
                value={mileage}
                onChange={(e) => setMileage(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Cost ($)</Label>
            <Input
              type="number"
              step="0.01"
              className="font-mono"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <Button
            type="submit"
            disabled={saving}
            className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {saving ? "Saving…" : "Add log"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Driver picker is a Select rather than free-text so the foreign key on
// fuel_logs.driver_id always resolves to a known driver row.
function AddFuelDialog({
  open,
  onOpenChange,
  vehicleId,
  defaultDriverId,
  drivers,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  vehicleId: string;
  defaultDriverId: string;
  drivers: { id: string; name: string }[];
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [gallons, setGallons] = useState("");
  const [cost, setCost] = useState("");
  const [location, setLocation] = useState("");
  const [driverId, setDriverId] = useState(defaultDriverId);
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setDate(new Date().toISOString().slice(0, 10));
    setGallons("");
    setCost("");
    setLocation("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const gallonsNum = Number(gallons);
    const costNum = Number(cost);
    if (!Number.isFinite(gallonsNum) || gallonsNum <= 0) {
      toast.error("Gallons must be a positive number");
      return;
    }
    if (!Number.isFinite(costNum) || costNum < 0) {
      toast.error("Cost must be a non-negative number");
      return;
    }
    if (!location.trim()) {
      toast.error("Location is required");
      return;
    }
    setSaving(true);
    try {
      await api.addFuelLog({
        vehicleId,
        date,
        gallons: gallonsNum,
        cost: costNum,
        location: location.trim(),
        driverId,
      });
      toast.success("Fuel entry added");
      resetForm();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save fuel entry");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add fuel entry — {vehicleId}</DialogTitle>
        </DialogHeader>
        {/*
          See note in ScheduleServiceDialog: handler-side validation only so the
          button audit's empty-form click surfaces a toast instead of being
          blocked by HTML5 form validation.
        */}
        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Date</Label>
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Gallons</Label>
              <Input
                type="number"
                step="0.01"
                className="font-mono"
                value={gallons}
                onChange={(e) => setGallons(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Cost ($)</Label>
            <Input
              type="number"
              step="0.01"
              className="font-mono"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          <div>
            <Label>Location</Label>
            <Input
              placeholder="e.g. Petro-Canada · QEW"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>
          <div>
            <Label>Driver</Label>
            <Select value={driverId} onValueChange={setDriverId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {drivers.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            disabled={saving}
            className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {saving ? "Saving…" : "Add fuel entry"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Add/edit a tool. Same dialog handles both — `tool` null means "new tool
// for this vehicle", non-null means editing an existing row (including
// reassigning it to a different vehicle or back to the unassigned pool,
// which is what lets an admin move gear between trucks instead of only
// ever deleting + recreating it).
function ToolDialog({
  open,
  onOpenChange,
  vehicleId,
  tool,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  vehicleId: string;
  tool: Tool | null;
}) {
  const { vehicles } = useData();
  const [name, setName] = useState("");
  const [condition, setCondition] = useState<ToolCondition>("ok");
  const [assignedVehicleId, setAssignedVehicleId] = useState<string>(vehicleId);
  const [saving, setSaving] = useState(false);

  // Re-seed every time the dialog opens rather than via a plain useState
  // initializer — this one Dialog instance is reused for both "Add" (tool =
  // null) and every row's "Edit" click, so the fields must reset to match
  // whichever tool (or blank form) triggered this open.
  useEffect(() => {
    if (!open) return;
    setName(tool?.name ?? "");
    setCondition(tool?.condition ?? "ok");
    setAssignedVehicleId(tool ? (tool.vehicleId ?? UNASSIGNED) : vehicleId);
  }, [open, tool, vehicleId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Tool name is required");
      return;
    }
    setSaving(true);
    try {
      const patch = {
        name: name.trim(),
        condition,
        vehicleId: assignedVehicleId === UNASSIGNED ? null : assignedVehicleId,
      };
      if (tool) {
        await api.updateTool(tool.id, patch);
        toast.success("Tool updated");
      } else {
        await api.createTool(patch);
        toast.success("Tool added");
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save tool");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tool ? `Edit tool — ${tool.name}` : "Add tool"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div>
            <Label>Name</Label>
            <Input
              placeholder="e.g. Fire extinguisher"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <Label>Condition</Label>
            <Select value={condition} onValueChange={(v) => setCondition(v as ToolCondition)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ok">OK</SelectItem>
                <SelectItem value="missing">Missing</SelectItem>
                <SelectItem value="damaged">Damaged</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Assigned vehicle</Label>
            <Select value={assignedVehicleId} onValueChange={setAssignedVehicleId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned (spare pool)</SelectItem>
                {vehicles.map((veh) => (
                  <SelectItem key={veh.id} value={veh.id}>
                    {veh.id} — {veh.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            disabled={saving}
            className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {saving ? "Saving…" : tool ? "Save changes" : "Add tool"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Audit chip showing the most recent passing pre-trip. Admins use this to
// confirm a driver actually circle-checked the truck before clocking in
// (the lockout enforces it on the driver side; this is the audit view).
// Green = fresh (<12h), amber = stale, red = never recorded.
function PretripBadge({ lastAt }: { lastAt: string | null }) {
  const PRETRIP_WINDOW_MS = 12 * 60 * 60 * 1000;
  if (!lastAt) {
    return (
      <span
        data-testid="pretrip-badge"
        data-pretrip-status="missing"
        className="inline-flex items-center gap-1 rounded bg-danger/15 text-danger text-[10px] font-mono uppercase px-2 py-1"
        title="No pre-trip inspection on file — driver is locked out of clock-in."
      >
        <ClipboardCheck className="w-3 h-3" /> Pre-trip: never
      </span>
    );
  }
  const ageMs = Date.now() - new Date(lastAt).getTime();
  const fresh = ageMs <= PRETRIP_WINDOW_MS;
  const formatted = new Date(lastAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <span
      data-testid="pretrip-badge"
      data-pretrip-status={fresh ? "fresh" : "stale"}
      className={`inline-flex items-center gap-1 rounded text-[10px] font-mono uppercase px-2 py-1 ${
        fresh ? "bg-success/15 text-success" : "bg-amber-brand/15 text-amber-brand"
      }`}
      title={`Last passing pre-trip inspection · ${new Date(lastAt).toISOString()}`}
    >
      <ClipboardCheck className="w-3 h-3" /> Last pre-trip: {formatted}
    </span>
  );
}
