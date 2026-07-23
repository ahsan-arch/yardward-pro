import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, AlertTriangle, Package, ShoppingCart, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { InventoryItem } from "@/types/domain";

export const Route = createFileRoute("/mechanic/inventory")({
  head: () => ({ meta: [{ title: "Parts inventory — Engage Hydrovac CRM" }] }),
  component: Page,
});

function Page() {
  const { inventoryItems: allInventoryItems, applyInventoryItem } = useData();
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [adjusting, setAdjusting] = useState<(typeof allInventoryItems)[number] | null>(null);

  // Archived parts are retired/superseded — a mechanic picking a part to
  // adjust or use shouldn't see them at all (this view has no restore
  // action; that's an admin-only capability on /admin/inventory).
  const inventoryItems = useMemo(
    () => allInventoryItems.filter((i) => !i.archived),
    [allInventoryItems],
  );

  const filtered = useMemo(
    () =>
      inventoryItems.filter((i) => {
        const matchSearch =
          search === "" ||
          i.name.toLowerCase().includes(search.toLowerCase()) ||
          i.sku.toLowerCase().includes(search.toLowerCase());
        const matchLow = !lowOnly || (!i.isUntracked && i.qtyOnHand <= i.reorderPoint);
        return matchSearch && matchLow;
      }),
    [inventoryItems, search, lowOnly],
  );

  const lowCount = inventoryItems.filter((i) => !i.isUntracked && i.qtyOnHand <= i.reorderPoint).length;

  return (
    <MechanicShell title="Parts inventory">
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name or SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Button
          variant={lowOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setLowOnly(!lowOnly)}
          className={lowOnly ? "bg-danger text-danger-foreground hover:bg-danger/90" : ""}
        >
          <AlertTriangle className="w-4 h-4" /> Low stock ({lowCount})
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {[
                "SKU",
                "Name",
                "Location",
                "On hand",
                "Reserved",
                "Available",
                "Reorder pt",
                "Last restocked",
                "Actions",
              ].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((i) => {
              const available = i.qtyOnHand - i.qtyReserved;
              const low = !i.isUntracked && i.qtyOnHand <= i.reorderPoint;
              return (
                <tr
                  key={i.id}
                  className={`border-t border-border hover:bg-muted/30 ${low ? "bg-danger/5" : ""}`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{i.sku}</td>
                  <td className="px-4 py-3 font-medium flex items-center gap-2">
                    <Package className="w-3.5 h-3.5 text-muted-foreground" />
                    {i.name}
                    {i.isUntracked && (
                      <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                        Non-stock
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {i.location || "—"}
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
                    {i.lastRestocked}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() => setAdjusting(i)}
                        data-testid={`mech-inv-adjust-${i.sku}`}
                      >
                        Adjust
                      </Button>
                      {low && (
                        <Button
                          size="sm"
                          className="h-7 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                          onClick={() => toast.success(`Reorder request raised for ${i.sku}`)}
                        >
                          <ShoppingCart className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No parts match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!adjusting} onOpenChange={(o) => !o && setAdjusting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono text-base">Adjust {adjusting?.sku}</DialogTitle>
          </DialogHeader>
          {adjusting && (
            <AdjustForm
              item={adjusting}
              onSaved={(updated) => {
                applyInventoryItem(updated);
                setAdjusting(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </MechanicShell>
  );
}

// Count adjustment that actually persists (was a mock toast before the
// Fleetio catalog import made the counts real).
function AdjustForm({
  item,
  onSaved,
}: {
  item: InventoryItem;
  onSaved: (i: InventoryItem) => void;
}) {
  const [qty, setQty] = useState(String(item.qtyOnHand));
  const [saving, setSaving] = useState(false);

  async function save() {
    const n = Number(qty);
    if (isNaN(n) || n < 0) {
      toast.error("Enter a non-negative count");
      return;
    }
    setSaving(true);
    try {
      const r = await api.updateInventoryItem(item.id, { qtyOnHand: n });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`${item.sku} set to ${Math.round(n)} on hand`);
      onSaved({
        ...item,
        qtyOnHand: Math.round(n),
        lastRestocked: new Date().toISOString().slice(0, 10),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{item.name}</p>
      <div>
        <Label>New count on hand</Label>
        <Input
          type="number"
          min="0"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          className="mt-1 font-mono"
          autoFocus
          data-testid="mech-inv-adjust-qty"
        />
      </div>
      <Button
        onClick={() => void save()}
        disabled={saving}
        className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        data-testid="mech-inv-adjust-save"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save count"}
      </Button>
    </div>
  );
}
