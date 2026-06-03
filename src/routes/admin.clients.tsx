import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Plus, Trash2, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { RateLineItem } from "@/types/domain";
import { toast } from "sonner";
import { api } from "@/lib/api";

export const Route = createFileRoute("/admin/clients")({
  head: () => ({ meta: [{ title: "Clients — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { clients, rateTables, jobs } = useData();
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = useMemo(
    () =>
      clients.filter(
        (c) =>
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.contactName.toLowerCase().includes(search.toLowerCase()),
      ),
    [clients, search],
  );

  const current = openId ? clients.find((c) => c.id === openId) : null;
  const currentRate = current?.rateTableId
    ? rateTables.find((rt) => rt.id === current.rateTableId)
    : null;
  const lastJob = (cid: string) =>
    jobs
      .filter((j) => j.clientId === cid)
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0];

  return (
    <AdminShell title="Clients">
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search clients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          onClick={() => setCreateOpen(true)}
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 sm:ml-auto"
        >
          <Plus className="w-4 h-4" /> New client
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["Name", "Contact", "Phone", "Rate table", "Status", "Last job"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const lj = lastJob(c.id);
              return (
                <tr
                  key={c.id}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                  onClick={() => setOpenId(c.id)}
                >
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.contactName}</td>
                  <td className="px-4 py-3 font-mono text-xs">{c.phone}</td>
                  <td className="px-4 py-3 text-xs">
                    {c.rateTableId ? (
                      <span className="font-mono text-amber-brand">{c.rateTableId}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status === "active" ? "Active" : "Inactive"} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {lj ? lj.scheduledAt.slice(0, 10) : "—"}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No clients match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {current && (
            <>
              <SheetHeader>
                <SheetTitle>{current.name}</SheetTitle>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{current.id}</span>
                  <StatusBadge status={current.status === "active" ? "Active" : "Inactive"} />
                </div>
              </SheetHeader>
              <div className="space-y-6 mt-6">
                <Section title="Contact">
                  <Row k="Primary contact" v={current.contactName} />
                  <Row k="Email" v={current.email} />
                  <Row k="Phone" v={current.phone} mono />
                  <Row k="Billing address" v={current.billingAddress} />
                </Section>
                {current.notes && (
                  <Section title="Notes">
                    <p className="text-sm">{current.notes}</p>
                  </Section>
                )}
                <RateTableEditor clientId={current.id} initial={currentRate?.lineItems ?? []} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New client</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              toast.success("Client created (mock)");
              setCreateOpen(false);
            }}
            className="space-y-3"
          >
            <div>
              <Label>Company name</Label>
              <Input required />
            </div>
            <div>
              <Label>Primary contact</Label>
              <Input required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Email</Label>
                <Input type="email" />
              </div>
              <div>
                <Label>Phone</Label>
                <Input />
              </div>
            </div>
            <div>
              <Label>Billing address</Label>
              <Input />
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea rows={2} />
            </div>
            <Button
              type="submit"
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              Create client
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}
function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between text-sm py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className={mono ? "font-mono text-xs" : "font-medium"}>{v}</span>
    </div>
  );
}

function RateTableEditor({ clientId, initial }: { clientId: string; initial: RateLineItem[] }) {
  const [items, setItems] = useState<RateLineItem[]>(initial.length ? initial : []);
  const [saving, setSaving] = useState(false);
  function addRow() {
    setItems((arr) => [...arr, { description: "", unit: "hour", rate: 0, surcharges: [] }]);
  }
  function removeRow(i: number) {
    setItems((arr) => arr.filter((_, idx) => idx !== i));
  }
  function patch(i: number, p: Partial<RateLineItem>) {
    setItems((arr) => arr.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  }
  async function save() {
    setSaving(true);
    try {
      await api.upsertRateTable(clientId, items);
      toast.success(`Rate table saved for ${clientId}`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Rate table">
      <div className="space-y-2">
        {items.map((it, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_90px_100px_auto] gap-2 items-end bg-muted/20 border border-border rounded-md p-2"
          >
            <div>
              <Label className="text-[10px] uppercase">Description</Label>
              <Input
                value={it.description}
                onChange={(e) => patch(i, { description: e.target.value })}
                placeholder="e.g. Truck + driver"
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase">Unit</Label>
              <Select
                value={it.unit}
                onValueChange={(v: RateLineItem["unit"]) => patch(i, { unit: v })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hour">hour</SelectItem>
                  <SelectItem value="tonne">tonne</SelectItem>
                  <SelectItem value="load">load</SelectItem>
                  <SelectItem value="flat">flat</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[10px] uppercase">Rate</Label>
              <Input
                type="number"
                value={it.rate}
                onChange={(e) => patch(i, { rate: +e.target.value })}
                className="h-9 font-mono"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeRow(i)}
              className="text-danger hover:bg-danger/10"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        {items.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No rate table assigned to this client yet.
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <Plus className="w-3 h-3" /> Add line
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={saving}
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Section>
  );
}
