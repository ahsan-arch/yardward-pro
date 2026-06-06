import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { useData } from "@/contexts/DataContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, AlertTriangle, Package, ShoppingCart } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/mechanic/inventory")({
  head: () => ({ meta: [{ title: "Parts inventory — Yardward Pro" }] }),
  component: Page,
});

function Page() {
  const { inventoryItems } = useData();
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);

  const filtered = useMemo(
    () =>
      inventoryItems.filter((i) => {
        const matchSearch =
          search === "" ||
          i.name.toLowerCase().includes(search.toLowerCase()) ||
          i.sku.toLowerCase().includes(search.toLowerCase());
        const matchLow = !lowOnly || i.qtyOnHand <= i.reorderPoint;
        return matchSearch && matchLow;
      }),
    [inventoryItems, search, lowOnly],
  );

  const lowCount = inventoryItems.filter((i) => i.qtyOnHand <= i.reorderPoint).length;

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
              const low = i.qtyOnHand <= i.reorderPoint;
              return (
                <tr
                  key={i.id}
                  className={`border-t border-border hover:bg-muted/30 ${low ? "bg-danger/5" : ""}`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{i.sku}</td>
                  <td className="px-4 py-3 font-medium flex items-center gap-2">
                    <Package className="w-3.5 h-3.5 text-muted-foreground" />
                    {i.name}
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
                        onClick={() => toast.success(`${i.sku} adjusted (mock)`)}
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
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No parts match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </MechanicShell>
  );
}
