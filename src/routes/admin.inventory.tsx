// Admin parts-inventory management. The catalog (1,532 Fleetio-imported
// parts + manual rows) hydrates through DataContext; this page gives the
// office search, low-stock filtering, quantity/reorder-point editing, new
// items, and a CSV export. Mechanics have their own read+adjust view at
// /mechanic/inventory — this is the management surface.

import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, AlertTriangle, Package, Plus, Download, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { toCsv, downloadCsv } from "@/lib/csv";

export const Route = createFileRoute("/admin/inventory")({
  head: () => ({ meta: [{ title: "Inventory — Engage Hydrovac CRM" }] }),
  component: Page,
});

const PAGE_SIZE = 50;

type Item = ReturnType<typeof useData>["inventoryItems"][number];

function Page() {
  const { inventoryItems, applyInventoryItem } = useData();
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Item | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inventoryItems.filter((i) => {
      const matchSearch =
        q === "" || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q);
      const matchLow = !lowOnly || i.qtyOnHand <= i.reorderPoint;
      return matchSearch && matchLow;
    });
  }, [inventoryItems, search, lowOnly]);

  const lowCount = useMemo(
    () => inventoryItems.filter((i) => i.qtyOnHand <= i.reorderPoint).length,
    [inventoryItems],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function exportCsv() {
    const csv = toCsv(
      ["SKU", "Name", "On hand", "Reserved", "Available", "Reorder point", "Last restocked"],
      filtered.map((i) => [
        i.sku,
        i.name,
        i.qtyOnHand,
        i.qtyReserved,
        i.qtyOnHand - i.qtyReserved,
        i.reorderPoint,
        i.lastRestocked,
      ]),
    );
    downloadCsv(`inventory-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    toast.success(`Exported ${filtered.length} items`);
  }

  return (
    <AdminShell title="Inventory">
      <div className="flex flex-col sm:flex-row gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={`Search ${inventoryItems.length} parts by name or SKU…`}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="pl-9"
            data-testid="admin-inv-search"
          />
        </div>
        <Button
          variant={lowOnly ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setLowOnly(!lowOnly);
            setPage(0);
          }}
          className={lowOnly ? "bg-danger text-danger-foreground hover:bg-danger/90" : ""}
          data-testid="admin-inv-low"
        >
          <AlertTriangle className="w-4 h-4" /> Low stock ({lowCount})
        </Button>
        <div className="sm:ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="admin-inv-export">
            <Download className="w-4 h-4" /> Export CSV
          </Button>
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            data-testid="admin-inv-new"
          >
            <Plus className="w-4 h-4" /> New item
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {[
                "SKU",
                "Name",
                "On hand",
                "Reserved",
                "Available",
                "Reorder pt",
                "Last restocked",
              ].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((i) => {
              const available = i.qtyOnHand - i.qtyReserved;
              const low = i.qtyOnHand <= i.reorderPoint;
              return (
                <tr
                  key={i.id}
                  onClick={() => setEditing(i)}
                  className={`border-t border-border hover:bg-muted/30 cursor-pointer ${low ? "bg-danger/5" : ""}`}
                  data-testid={`admin-inv-row-${i.sku}`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{i.sku}</td>
                  <td className="px-4 py-3 font-medium">
                    <span className="inline-flex items-center gap-2">
                      <Package className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="max-w-md truncate inline-block align-middle">{i.name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono">{i.qtyOnHand}</td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">{i.qtyReserved}</td>
                  <td
                    className={`px-4 py-3 font-mono font-medium ${available <= 0 ? "text-danger" : "text-success"}`}
                  >
                    {available}
                  </td>
                  <td className="px-4 py-3 font-mono text-muted-foreground">{i.reorderPoint}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {i.lastRestocked || "—"}
                  </td>
                </tr>
              );
            })}
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No parts match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground mt-3">
        <span>
          {filtered.length} of {inventoryItems.length} items
          {lowOnly || search ? " (filtered)" : ""}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Prev
          </Button>
          <span>
            Page {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{editing?.sku}</DialogTitle>
          </DialogHeader>
          {editing && (
            <EditItemForm
              item={editing}
              onSaved={(updated) => {
                applyInventoryItem(updated);
                setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New inventory item</DialogTitle>
          </DialogHeader>
          <CreateItemForm
            onSaved={(item) => {
              applyInventoryItem(item);
              setCreateOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function EditItemForm({ item, onSaved }: { item: Item; onSaved: (i: Item) => void }) {
  const [name, setName] = useState(item.name);
  const [qty, setQty] = useState(String(item.qtyOnHand));
  const [reorder, setReorder] = useState(String(item.reorderPoint));
  const [saving, setSaving] = useState(false);

  async function save() {
    const qtyN = Number(qty);
    const reorderN = Number(reorder);
    if (!name.trim() || isNaN(qtyN) || qtyN < 0 || isNaN(reorderN) || reorderN < 0) {
      toast.error("Enter a name and non-negative numbers");
      return;
    }
    setSaving(true);
    try {
      const r = await api.updateInventoryItem(item.id, {
        name: name.trim(),
        qtyOnHand: qtyN,
        reorderPoint: reorderN,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`${item.sku} updated`);
      onSaved({
        ...item,
        name: name.trim(),
        qtyOnHand: Math.round(qtyN),
        reorderPoint: Math.round(reorderN),
        lastRestocked:
          Math.round(qtyN) !== item.qtyOnHand
            ? new Date().toISOString().slice(0, 10)
            : item.lastRestocked,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Qty on hand</Label>
          <Input
            type="number"
            min="0"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="mt-1 font-mono"
            data-testid="admin-inv-edit-qty"
          />
        </div>
        <div>
          <Label>Reorder point</Label>
          <Input
            type="number"
            min="0"
            value={reorder}
            onChange={(e) => setReorder(e.target.value)}
            className="mt-1 font-mono"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Reserved: {item.qtyReserved} (managed automatically by purchase-request approvals)
      </p>
      <Button
        onClick={() => void save()}
        disabled={saving}
        className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        data-testid="admin-inv-edit-save"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
      </Button>
    </div>
  );
}

function CreateItemForm({ onSaved }: { onSaved: (i: Item) => void }) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState("0");
  const [reorder, setReorder] = useState("0");
  const [saving, setSaving] = useState(false);

  async function save() {
    const qtyN = Number(qty);
    const reorderN = Number(reorder);
    if (!name.trim() || !sku.trim() || isNaN(qtyN) || qtyN < 0 || isNaN(reorderN) || reorderN < 0) {
      toast.error("Name, SKU, and non-negative numbers required");
      return;
    }
    setSaving(true);
    try {
      const r = await api.createInventoryItem({
        name: name.trim(),
        sku: sku.trim(),
        qtyOnHand: qtyN,
        reorderPoint: reorderN,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`${sku.trim()} added`);
      onSaved({
        id: r.id,
        name: name.trim(),
        sku: sku.trim(),
        qtyOnHand: Math.round(qtyN),
        qtyReserved: 0,
        reorderPoint: Math.round(reorderN),
        supplierId: "",
        lastRestocked: new Date().toISOString().slice(0, 10),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <Label>SKU</Label>
        <Input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="e.g. FLT-2290"
          className="mt-1 font-mono"
          data-testid="admin-inv-new-sku"
        />
      </div>
      <div>
        <Label>Name</Label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Part description"
          className="mt-1"
          data-testid="admin-inv-new-name"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Qty on hand</Label>
          <Input
            type="number"
            min="0"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="mt-1 font-mono"
          />
        </div>
        <div>
          <Label>Reorder point</Label>
          <Input
            type="number"
            min="0"
            value={reorder}
            onChange={(e) => setReorder(e.target.value)}
            className="mt-1 font-mono"
          />
        </div>
      </div>
      <Button
        onClick={() => void save()}
        disabled={saving}
        className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        data-testid="admin-inv-new-save"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Add item"}
      </Button>
    </div>
  );
}
