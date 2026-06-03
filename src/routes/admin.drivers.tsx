import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { drivers } from "@/data/mockData";
import { Phone, Award } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/drivers")({
  head: () => ({ meta: [{ title: "Drivers — FleetOps CRM" }] }),
  component: Page,
});

// Empty defaults for the Add Driver form. Hoisted so the click handler can
// fall back to these if building defaults from contextual data ever throws.
const EMPTY_DRIVER_FORM = { name: "", phone: "", licenseNumber: "" };

function Page() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_DRIVER_FORM);

  // Open the Add Driver dialog. setOpen(true) fires FIRST so the dialog
  // appears reliably, then we attempt to seed defaults inside a try/catch.
  // Any throw inside the data-prep block silently falls back to the empty
  // form rather than swallowing the click.
  function openAddDriver() {
    setOpen(true);
    try {
      // Seed an auto-generated id-like next-number from the current list.
      // Reading .length on undefined would throw if drivers ever failed to
      // load — the try/catch keeps the dialog usable either way.
      const nextId = drivers.length + 1;
      setForm({ ...EMPTY_DRIVER_FORM, name: "", phone: "", licenseNumber: `DL-${nextId}` });
    } catch {
      setForm(EMPTY_DRIVER_FORM);
    }
  }

  function submit() {
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    toast.success(`${form.name} added (mock)`);
    setOpen(false);
    setForm(EMPTY_DRIVER_FORM);
  }

  return (
    <AdminShell title="Drivers">
      <div className="flex gap-2 mb-4">
        <Input placeholder="Search drivers…" className="max-w-sm" />
        <Button
          onClick={openAddDriver}
          data-testid="open-add-driver"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 ml-auto"
        >
          Add driver
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add driver</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Jane Doe"
              />
            </div>
            <div>
              <Label>Phone</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                placeholder="+1 555 000 0000"
                className="font-mono"
              />
            </div>
            <div>
              <Label>License number</Label>
              <Input
                value={form.licenseNumber}
                onChange={(e) => setForm((f) => ({ ...f, licenseNumber: e.target.value }))}
                className="font-mono"
              />
            </div>
            <Button
              onClick={submit}
              data-testid="submit-add-driver"
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              Add driver
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {drivers.map((d) => (
          <div
            key={d.id}
            className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-navy text-navy-foreground grid place-items-center font-bold">
                {d.initials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{d.name}</div>
                <div className="text-xs font-mono text-muted-foreground">{d.id}</div>
              </div>
              <span className="bg-success/15 text-success text-[10px] font-mono uppercase px-2 py-1 rounded">
                Active
              </span>
            </div>
            <div className="mt-4 pt-4 border-t border-border space-y-1.5 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Phone className="w-3.5 h-3.5" />
                <span className="font-mono text-xs">{d.phone}</span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Award className="w-3.5 h-3.5" />
                <span className="text-xs">License: {d.licenseNumber}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </AdminShell>
  );
}
