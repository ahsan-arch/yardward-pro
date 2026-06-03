import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Plus, Wrench } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";

export const Route = createFileRoute("/mechanic/maintenance")({
  head: () => ({ meta: [{ title: "Vehicle maintenance logs — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { vehicles, maintenanceLogs } = useData();
  const { user } = useAuth();
  const [vehicleId, setVehicleId] = useState<string>(vehicles[0]?.id ?? "");
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [mileage, setMileage] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const logs = maintenanceLogs.filter((l) => l.vehicleId === vehicleId);
  const alerts = vehicles.filter(
    (v) => v.status === "maintenance" || v.nextServiceDue.toLowerCase().includes("overdue"),
  );

  function resetForm() {
    setType("");
    setDate(new Date().toISOString().slice(0, 10));
    setMileage("");
    setCost("");
    setNotes("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!vehicleId) return;
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
        performedBy: user?.name ?? user?.id ?? "Mechanic",
        date,
        mileage: mileageNum,
        cost: costNum,
        notes,
        attachments: [],
      });
      toast.success("Maintenance log added");
      resetForm();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save log");
    } finally {
      setSaving(false);
    }
  }

  return (
    <MechanicShell title="Vehicle maintenance logs">
      {alerts.length > 0 && (
        <div className="bg-amber-brand/10 border border-amber-brand/30 rounded-md p-3 mb-4 flex items-start gap-2 text-sm">
          <AlertTriangle className="w-4 h-4 text-amber-brand mt-0.5" />
          <div>
            <div className="font-semibold">Preventive service alerts</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {alerts.map((a) => `${a.id} (${a.nextServiceDue})`).join(" · ")}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mb-4 items-stretch sm:items-center">
        <Label className="sm:mr-2">Vehicle</Label>
        <Select value={vehicleId} onValueChange={setVehicleId}>
          <SelectTrigger className="max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {vehicles.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.id} — {v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          onClick={() => setOpen(true)}
          className="sm:ml-auto bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> Add log entry
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["Date", "Type", "Mileage", "Performed by", "Cost", "Notes"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-4 py-3 font-mono text-xs">{l.date}</td>
                <td className="px-4 py-3 font-medium flex items-center gap-2">
                  <Wrench className="w-3.5 h-3.5 text-muted-foreground" />
                  {l.type}
                </td>
                <td className="px-4 py-3 font-mono">{l.mileage.toLocaleString()}</td>
                <td className="px-4 py-3 text-muted-foreground">{l.performedBy}</td>
                <td className="px-4 py-3 font-mono">${l.cost}</td>
                <td className="px-4 py-3 text-sm">{l.notes}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No maintenance logs for this vehicle yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add maintenance log — {vehicleId}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <Label>Service type</Label>
              <Input
                required
                placeholder="e.g. Brake replacement"
                value={type}
                onChange={(e) => setType(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date</Label>
                <Input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <div>
                <Label>Mileage</Label>
                <Input
                  type="number"
                  required
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
                required
                className="font-mono"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
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
    </MechanicShell>
  );
}
