import { createFileRoute, Link } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Search, AlertTriangle, Truck as TruckIcon, Download, Loader2 } from "lucide-react";
import { useData } from "@/contexts/DataContext";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { USE_SUPABASE } from "@/lib/supabase";

export const Route = createFileRoute("/admin/vehicles/")({
  head: () => ({ meta: [{ title: "Vehicles — Yardward Pro" }] }),
  component: Page,
});

type FleetioImportKind = "vehicles" | "maintenance_logs" | "fuel_logs";

interface FleetioImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  importId: string | null;
  durationMs: number;
  dryRun: boolean;
  planned: {
    vehiclesToCreate?: number;
    vehiclesToUpdate?: number;
    maintenanceLogsToImport?: number;
    fuelLogsToImport?: number;
    samples: {
      vehiclesToCreate?: unknown[];
      vehiclesToUpdate?: unknown[];
      maintenanceLogsToImport?: unknown[];
      fuelLogsToImport?: unknown[];
    };
  } | null;
}

// Dialog wrapping api.importFromFleetio. Mirrors the QBO push-payroll dialog
// shape: kind picker on the left, dryRun toggle on the right, and a counter
// summary inline after each run so the operator can compare a preview run to
// the live run without dismissing the dialog.
function FleetioImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [kind, setKind] = useState<FleetioImportKind>("vehicles");
  // Default to dryRun=true so an admin opening the dialog can't double-tap
  // through to a live mutation. Matches the QBO push-payroll default.
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FleetioImportResult | null>(null);

  async function run() {
    if (!USE_SUPABASE) {
      toast.error(
        "Fleetio import requires Supabase credentials. Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.",
      );
      return;
    }
    setRunning(true);
    setResult(null);
    const toastId = toast.loading(
      dryRun ? "Running Fleetio dry run…" : "Importing from Fleetio…",
    );
    try {
      const r = await api.importFromFleetio(kind, dryRun);
      setResult(r);
      const seconds = (r.durationMs / 1000).toFixed(1);
      if (r.dryRun) {
        // Build a kind-specific summary. For vehicles we have create/update
        // splits; for the log kinds it's a single import count. The trailing
        // "(no changes made)" badge is the visual equivalent of the toggle
        // for operators reading toasts in passing.
        const planned = r.planned;
        let summary: string;
        if (kind === "vehicles") {
          const created = planned?.vehiclesToCreate ?? 0;
          const updated = planned?.vehiclesToUpdate ?? 0;
          summary = `would import ${created + updated} vehicles (${created} new, ${updated} updated)`;
        } else if (kind === "maintenance_logs") {
          summary = `would import ${planned?.maintenanceLogsToImport ?? r.imported} maintenance logs`;
        } else {
          summary = `would import ${planned?.fuelLogsToImport ?? r.imported} fuel logs`;
        }
        toast.success(
          `Dry run complete — ${summary} (no changes made)`,
          { id: toastId, duration: 6000 },
        );
      } else if (r.errors.length) {
        toast.warning(
          `Imported ${r.imported} from Fleetio (skipped ${r.skipped}, ${r.errors.length} error${r.errors.length === 1 ? "" : "s"}) in ${seconds}s`,
          { id: toastId },
        );
      } else {
        toast.success(
          `Imported ${r.imported} from Fleetio (skipped ${r.skipped}) in ${seconds}s`,
          { id: toastId },
        );
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Fleetio import failed";
      toast.error(message, { id: toastId });
    } finally {
      setRunning(false);
    }
  }

  function reset() {
    setResult(null);
    setRunning(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import from Fleetio</DialogTitle>
          <DialogDescription>
            Pulls the selected dataset from Fleetio and upserts into our DB.
            Use dry run first to preview the create/update counts before
            committing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="fleetio-kind">Dataset</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as FleetioImportKind)}
            >
              <SelectTrigger id="fleetio-kind" data-testid="fleetio-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vehicles">Vehicles</SelectItem>
                <SelectItem value="maintenance_logs">Maintenance logs</SelectItem>
                <SelectItem value="fuel_logs">Fuel logs</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <div>
              <Label htmlFor="fleetio-dry-run" className="cursor-pointer">
                Dry run
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Preview only — no rows are upserted. Writes a summary row to
                integration_alerts (kind=fleetio_dryrun_summary).
              </p>
            </div>
            <Switch
              id="fleetio-dry-run"
              checked={dryRun}
              onCheckedChange={setDryRun}
              data-testid="fleetio-dry-run"
            />
          </div>

          {result && (
            <div
              className="bg-muted/40 border border-border rounded-md p-3 text-sm space-y-2"
              data-testid="fleetio-result"
            >
              <div className="flex items-center justify-between">
                <div className="font-medium">
                  {result.dryRun ? "Dry run summary" : "Import summary"}
                </div>
                {result.dryRun && (
                  <span
                    className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-amber-brand/15 text-amber-brand"
                    data-testid="fleetio-no-changes-badge"
                  >
                    No changes made
                  </span>
                )}
              </div>
              {result.dryRun ? (
                <PlannedSummary kind={kind} planned={result.planned} />
              ) : (
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Imported</div>
                    <div className="font-mono text-success" data-testid="fleetio-imported">
                      {result.imported}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Skipped</div>
                    <div className="font-mono" data-testid="fleetio-skipped">
                      {result.skipped}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Errors</div>
                    <div className="font-mono text-danger" data-testid="fleetio-errors">
                      {result.errors.length}
                    </div>
                  </div>
                </div>
              )}
              <div className="text-[11px] text-muted-foreground font-mono pt-1 border-t border-border/50">
                duration {result.durationMs}ms
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={running}
          >
            Close
          </Button>
          <Button
            onClick={run}
            disabled={running}
            data-testid="fleetio-run"
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {running ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            {running ? "Running…" : dryRun ? "Run dry run" : "Import from Fleetio"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Renders the planned-op counts for a dryRun result. Falls back to result.imported
// when the edge function didn't return a planned section (older deploy).
function PlannedSummary({
  kind,
  planned,
}: {
  kind: FleetioImportKind;
  planned: FleetioImportResult["planned"];
}) {
  if (kind === "vehicles") {
    const created = planned?.vehiclesToCreate ?? 0;
    const updated = planned?.vehiclesToUpdate ?? 0;
    return (
      <div className="grid grid-cols-3 gap-2 text-xs">
        <Stat label="To create" value={created} testid="fleetio-vehicles-create" />
        <Stat label="To update" value={updated} testid="fleetio-vehicles-update" />
        <Stat label="Total" value={created + updated} testid="fleetio-vehicles-total" />
      </div>
    );
  }
  if (kind === "maintenance_logs") {
    return (
      <div className="grid grid-cols-2 gap-2 text-xs">
        <Stat
          label="Maintenance logs to import"
          value={planned?.maintenanceLogsToImport ?? 0}
          testid="fleetio-maint-import"
        />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <Stat
        label="Fuel logs to import"
        value={planned?.fuelLogsToImport ?? 0}
        testid="fleetio-fuel-import"
      />
    </div>
  );
}

function Stat({
  label,
  value,
  testid,
}: {
  label: string;
  value: number;
  testid: string;
}) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono" data-testid={testid}>
        {value}
      </div>
    </div>
  );
}

// Empty defaults for the Add Vehicle form. Hoisted so the click handler can
// fall back to these if seeding from contextual data ever throws.
const EMPTY_VEHICLE_FORM = { id: "", name: "", type: "truck", year: "" };

function Page() {
  const { vehicles, drivers } = useData();
  // Build the display list from LIVE Supabase data. Resolves the driver
  // assigned to each vehicle against the live drivers array — no mockData
  // seed in the production render path.
  const trucks = vehicles.map((v) => {
    const d = drivers.find((x) => x.id === v.driverId);
    return {
      id: v.id,
      name: v.name,
      year: v.year,
      type: v.type.charAt(0).toUpperCase() + v.type.slice(1),
      odometer: v.odometer,
      hours: v.engineHours,
      lastService: v.lastService,
      nextDue: v.nextServiceDue,
      status:
        v.status === "operational"
          ? "Operational"
          : v.status === "maintenance"
            ? "In maintenance"
            : "Out of service",
      driver: d?.name ?? "Unassigned",
    };
  });
  const [fleetioOpen, setFleetioOpen] = useState(false);
  const [addVehicleOpen, setAddVehicleOpen] = useState(false);
  const [vehicleForm, setVehicleForm] = useState(EMPTY_VEHICLE_FORM);
  // Per-card "Add record" dialog: a single dialog shared across cards so we
  // don't mount N dialogs. `addRecordFor` doubles as both the open flag (truthy)
  // and the vehicle id whose record we're about to file.
  const [addRecordFor, setAddRecordFor] = useState<string | null>(null);

  // Open the Add Record dialog for a specific vehicle. setOpen fires FIRST
  // (via setAddRecordFor) so the dialog appears reliably even if any future
  // contextual data-fetch were to throw mid-handler.
  function openAddRecord(vehicleId: string) {
    setAddRecordFor(vehicleId);
  }

  function submitAddRecord() {
    if (!addRecordFor) return;
    toast.success(`Maintenance record added for ${addRecordFor} (mock)`);
    setAddRecordFor(null);
  }

  // Open the Fleetio import dialog. setOpen fires FIRST so the dialog opens
  // even if any pre-flight check throws — the env check moved into run() so
  // it can never block the click.
  function openFleetioImport() {
    setFleetioOpen(true);
  }

  // Open the Add Vehicle dialog. setOpen(true) BEFORE seeding so the dialog
  // appears reliably; seeding the next-id from `trucks` is wrapped in
  // try/catch in case the list ever fails to load.
  function openAddVehicle() {
    setAddVehicleOpen(true);
    try {
      const nextNum = trucks.length + 1;
      setVehicleForm({
        ...EMPTY_VEHICLE_FORM,
        id: `T-${String(nextNum).padStart(2, "0")}`,
      });
    } catch {
      setVehicleForm(EMPTY_VEHICLE_FORM);
    }
  }

  function submitVehicle() {
    if (!vehicleForm.id.trim() || !vehicleForm.name.trim()) {
      toast.error("Vehicle ID and name are required");
      return;
    }
    toast.success(`${vehicleForm.id} added (mock)`);
    setAddVehicleOpen(false);
    setVehicleForm(EMPTY_VEHICLE_FORM);
  }

  return (
    <AdminShell title="Vehicles">
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search by ID, name, driver…" className="pl-9" />
        </div>
        <Select>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="truck">Truck</SelectItem>
            <SelectItem value="trailer">Trailer</SelectItem>
            <SelectItem value="equipment">Equipment</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          onClick={openFleetioImport}
          data-testid="open-fleetio-import"
          className="sm:ml-auto"
        >
          <Download className="w-4 h-4" />
          Import from Fleetio
        </Button>
        <Button
          onClick={openAddVehicle}
          data-testid="open-add-vehicle"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> Add vehicle
        </Button>
      </div>

      <FleetioImportDialog open={fleetioOpen} onOpenChange={setFleetioOpen} />

      {/*
        Add-record dialog — shared across cards. Confirms the maintenance row
        was filed and emits a success toast so the button-audit e2e sees the
        side effect. Real-world flow lives on the vehicle detail page; this is
        the quick-file shortcut from the card grid.
      */}
      <Dialog
        open={addRecordFor !== null}
        onOpenChange={(o) => !o && setAddRecordFor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Add record{addRecordFor ? ` — ${addRecordFor}` : ""}
            </DialogTitle>
            <DialogDescription>
              File a quick maintenance / service note against this vehicle. For
              full fields and attachments use the vehicle detail page.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Note</Label>
              <Input placeholder="e.g. Oil top-up at depot" />
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setAddRecordFor(null)}
              >
                Close
              </Button>
              <Button
                onClick={submitAddRecord}
                data-testid="submit-add-record"
                className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
              >
                Add record
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={addVehicleOpen} onOpenChange={setAddVehicleOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add vehicle</DialogTitle>
            <DialogDescription>
              Register a new truck, trailer, or piece of equipment. Mock-only
              until the backend is wired.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Vehicle ID</Label>
              <Input
                value={vehicleForm.id}
                onChange={(e) => setVehicleForm((f) => ({ ...f, id: e.target.value }))}
                placeholder="T-07"
                className="font-mono"
              />
            </div>
            <div>
              <Label>Name</Label>
              <Input
                value={vehicleForm.name}
                onChange={(e) => setVehicleForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Kenworth T880"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Type</Label>
                <Select
                  value={vehicleForm.type}
                  onValueChange={(v) => setVehicleForm((f) => ({ ...f, type: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="truck">Truck</SelectItem>
                    <SelectItem value="trailer">Trailer</SelectItem>
                    <SelectItem value="equipment">Equipment</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Year</Label>
                <Input
                  value={vehicleForm.year}
                  onChange={(e) => setVehicleForm((f) => ({ ...f, year: e.target.value }))}
                  placeholder="2024"
                  className="font-mono"
                />
              </div>
            </div>
            <Button
              onClick={submitVehicle}
              data-testid="submit-add-vehicle"
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              Add vehicle
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {trucks.map((t) => (
          <div
            key={t.id}
            className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden"
          >
            {t.status === "In maintenance" && (
              <div className="bg-amber-brand/15 text-amber-brand text-xs font-medium px-4 py-2 flex items-center gap-2 border-b border-amber-brand/20">
                <AlertTriangle className="w-3.5 h-3.5" /> In maintenance — scheduled work in
                progress
              </div>
            )}
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-md bg-navy text-navy-foreground grid place-items-center">
                    <TruckIcon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-mono text-xs font-bold text-navy bg-navy/10 px-2 py-0.5 rounded inline-block dark:bg-navy/30 dark:text-amber-brand">
                      {t.id}
                    </div>
                    <div className="font-semibold mt-1">{t.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.year} · {t.type}
                    </div>
                  </div>
                </div>
                <span
                  className={cn(
                    "text-[10px] font-mono uppercase px-2 py-1 rounded",
                    t.status === "Operational"
                      ? "bg-success/15 text-success"
                      : "bg-amber-brand/15 text-amber-brand",
                  )}
                >
                  {t.status === "Operational" ? "● Operational" : "● Maintenance"}
                </span>
              </div>

              <div className="mt-4 pt-4 border-t border-border flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-amber-brand text-amber-brand-foreground grid place-items-center text-[10px] font-bold">
                  {t.driver === "Unassigned"
                    ? "?"
                    : t.driver
                        .split(" ")
                        .map((n) => n[0])
                        .join("")}
                </div>
                <div className="text-sm">
                  <div className="text-[10px] uppercase font-mono text-muted-foreground">
                    Driver
                  </div>
                  <div
                    className={cn(
                      "font-medium",
                      t.driver === "Unassigned" && "text-muted-foreground italic",
                    )}
                  >
                    {t.driver}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <VehicleStat k="Odometer" v={t.odometer ? `${t.odometer.toLocaleString()} km` : "—"} />
                <VehicleStat k="Engine hours" v={`${t.hours.toLocaleString()} hrs`} />
                <VehicleStat k="Last service" v={t.lastService} />
                <VehicleStat k="Next service due" v={t.nextDue} />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <Link
                  to="/admin/vehicles/$id"
                  params={{ id: t.id }}
                  className="h-9 rounded-md border border-border text-xs font-medium grid place-items-center hover:bg-muted/50"
                >
                  View details
                </Link>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openAddRecord(t.id)}
                  data-testid={`open-add-record-${t.id}`}
                >
                  Add record
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </AdminShell>
  );
}

function VehicleStat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-mono text-muted-foreground">{k}</div>
      <div className="font-mono text-xs font-medium">{v}</div>
    </div>
  );
}
