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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
} from "lucide-react";
import { api } from "@/lib/api";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { VehicleMap } from "@/components/crm/VehicleMap";

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

  useEffect(() => {
    // Swallow telematics fetch failures so the rest of the page still
    // renders. A missing Geotab row should not turn the vehicle detail
    // page into a blank screen — the Refresh location button stays
    // reachable so the admin can retry.
    if (v) {
      api
        .fetchGeotabLocation(v.id)
        .then(setTele)
        .catch(() => setTele(null));
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
            <NextServiceDueRow vehicleId={v.id} value={v.nextServiceDue} />
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
          <SectionLabel icon={Wrench}>Tools assigned</SectionLabel>
          {assignedTools.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No tools assigned.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {assignedTools.map((t) => (
                <li key={t.id} className="flex items-center justify-between">
                  <span>{t.name}</span>
                  <span
                    className={`text-xs font-mono uppercase ${t.condition === "ok" ? "text-success" : t.condition === "damaged" ? "text-amber-brand" : "text-danger"}`}
                  >
                    {t.condition}
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
                <tr key={l.id} className="border-t border-border">
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

      <div className="mt-4">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <SectionLabel icon={Fuel}>Fuel log</SectionLabel>
            <Button size="sm" variant="outline" onClick={() => setFuelOpen(true)}>
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

// Inline editor for next_service_due. This is the free-text km/hours service
// target ("90,000 km" / "5,800 hrs") the preventive-maintenance-check parses —
// the only operator-facing way to set it on an existing vehicle, so PM alerts
// can actually fire. Persists via api.updateVehicle (admin-only under RLS).
function NextServiceDueRow({ vehicleId, value }: { vehicleId: string; value: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(value), [value]);

  async function save() {
    setSaving(true);
    try {
      const r = await api.updateVehicle(vehicleId, { nextServiceDue: draft });
      if (!r.ok) {
        toast.error(`Save failed: ${r.reason}`);
        return;
      }
      toast.success("Next service updated");
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex justify-between items-center">
        <span className="text-muted-foreground">Next service</span>
        <span className="flex items-center gap-2">
          <span>{value || "—"}</span>
          <button
            type="button"
            className="text-xs text-amber-brand hover:underline"
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
            data-testid="edit-next-service"
          >
            Edit
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-muted-foreground shrink-0">Next service</span>
      <span className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="90,000 km"
          className="h-8 w-36 text-sm"
          data-testid="next-service-input"
        />
        <Button
          size="sm"
          className="h-8"
          onClick={save}
          disabled={saving}
          data-testid="save-next-service"
        >
          {saving ? "…" : "Save"}
        </Button>
        <button
          type="button"
          className="text-xs text-muted-foreground hover:underline"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </span>
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
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
