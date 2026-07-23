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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Search,
  AlertTriangle,
  Package,
  Plus,
  Download,
  Loader2,
  Camera,
  Printer,
  Archive,
  ArchiveRestore,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { toCsv, downloadCsv, openPrintView, escapeHtml } from "@/lib/csv";
import { printPartLabels } from "@/lib/part-labels";
import { cn } from "@/lib/utils";
import { CoreReturnsPanel } from "@/components/crm/CoreReturnsPanel";

export const Route = createFileRoute("/admin/inventory")({
  head: () => ({ meta: [{ title: "Inventory — Engage Hydrovac CRM" }] }),
  component: Page,
});

const PAGE_SIZE = 50;

// No categories table exists (category is a plain text field on
// inventory_items — see 20260717120000_parts_metadata_fields.sql), so the
// filter dropdown's options are just whatever distinct values are already in
// use. Radix Select rejects an empty-string item value, hence the sentinel.
const ALL_CATEGORIES = "__all__";

type Item = ReturnType<typeof useData>["inventoryItems"][number];

// Renders an <img> whose src is signed on demand — inventory_items.photo_url
// stores a storage PATH (not a baked URL, which would 403 after the signed
// link's TTL), same pattern as SignedTicketImg in admin.tickets.tsx.
function SignedPartImg({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    api
      .signInventoryPhotoUrl(path)
      .then((s) => {
        if (!cancelled) setSrc(s ?? path);
      })
      .catch(() => {
        if (!cancelled) setSrc(path);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  if (!src) return <div className="w-full h-full bg-muted animate-pulse" aria-busy />;
  return <img src={src} alt={alt} className="w-full h-full object-cover" />;
}

// Shared photo picker for the Create/Edit forms. `currentPhotoUrl` is the
// already-persisted path (edit only); `onPick` hands the parent a data URL
// to hold until save() actually uploads it — an item that doesn't exist yet
// (create flow) has no id to build a storage path from, so upload is
// deferred to right after the row itself is created.
function PhotoField({
  currentPhotoUrl,
  pendingDataUrl,
  onPick,
}: {
  currentPhotoUrl?: string;
  pendingDataUrl: string | null;
  onPick: (dataUrl: string) => void;
}) {
  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onPick(reader.result as string);
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  return (
    <div>
      <Label>Photo</Label>
      <div className="mt-1 flex items-center gap-3">
        <div className="w-16 h-16 rounded-md border border-border overflow-hidden bg-muted shrink-0 grid place-items-center">
          {pendingDataUrl ? (
            <img src={pendingDataUrl} alt="Selected part" className="w-full h-full object-cover" />
          ) : currentPhotoUrl ? (
            <SignedPartImg path={currentPhotoUrl} alt="Part" />
          ) : (
            <Package className="w-6 h-6 text-muted-foreground" />
          )}
        </div>
        <label className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border text-sm font-medium cursor-pointer hover:bg-muted">
          <Camera className="w-4 h-4" />
          {currentPhotoUrl || pendingDataUrl ? "Change photo" : "Add photo"}
          <input type="file" accept="image/*" onChange={onFileChange} className="hidden" />
        </label>
      </div>
    </div>
  );
}

// Client feedback: "There is no inventory dashboard, if there are no
// sub-menus there should at least be a multi panel dashboard e.g. sub-menu
// panels and Inventory overview." No cost/price field exists on parts, so
// this reads in counts, not dollar value — stat tiles, a category
// breakdown (single-series magnitude, so one hue and no legend), and the
// two lists an admin actually checks day to day: what's low and what just
// came in.
function InventoryOverview({
  activeItems,
  lowCount,
  archivedCount,
  onJumpToLowStock,
}: {
  activeItems: Item[];
  lowCount: number;
  archivedCount: number;
  onJumpToLowStock: () => void;
}) {
  const assignedCount = activeItems.filter(
    (i) => i.assignedVehicleId || i.assignedUserId,
  ).length;

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of activeItems) {
      const key = i.category || "Uncategorized";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [activeItems]);
  const maxCategoryCount = categoryCounts[0]?.[1] ?? 1;

  const lowStockList = useMemo(
    () =>
      activeItems
        .filter((i) => !i.isUntracked && i.qtyOnHand <= i.reorderPoint)
        .sort((a, b) => a.qtyOnHand - a.reorderPoint - (b.qtyOnHand - b.reorderPoint))
        .slice(0, 5),
    [activeItems],
  );
  const recentlyRestocked = useMemo(
    () =>
      activeItems
        .filter((i) => i.lastRestocked)
        .sort((a, b) => b.lastRestocked.localeCompare(a.lastRestocked))
        .slice(0, 5),
    [activeItems],
  );

  const tiles: { label: string; value: number; tone: "muted" | "danger" | "warning" }[] = [
    { label: "Active parts", value: activeItems.length, tone: "muted" },
    { label: "Low stock", value: lowCount, tone: lowCount > 0 ? "danger" : "muted" },
    { label: "Assigned to a vehicle/person", value: assignedCount, tone: "muted" },
    { label: "Archived", value: archivedCount, tone: "warning" },
  ];
  const toneClass: Record<string, string> = {
    muted: "text-foreground",
    danger: "text-danger",
    warning: "text-amber-brand",
  };

  return (
    <div className="space-y-4 mb-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          >
            <div className={cn("text-3xl font-bold font-mono", toneClass[t.tone])}>{t.value}</div>
            <div className="text-xs text-muted-foreground mt-1">{t.label}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <h3 className="font-semibold text-sm mb-3">Parts by category</h3>
          {categoryCounts.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No categories assigned yet.
            </p>
          ) : (
            <div className="space-y-2.5">
              {categoryCounts.map(([cat, count]) => (
                <div key={cat} className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground w-28 shrink-0 truncate">
                    {cat}
                  </span>
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-amber-brand"
                      style={{ width: `${Math.max(4, (count / maxCategoryCount) * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-muted-foreground w-6 text-right shrink-0">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">Needs restock</h3>
            {lowCount > 0 && (
              <button
                onClick={onJumpToLowStock}
                className="text-xs text-amber-brand hover:underline"
              >
                View all ({lowCount})
              </button>
            )}
          </div>
          {lowStockList.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              Nothing at or below its reorder point.
            </p>
          ) : (
            <div className="space-y-2">
              {lowStockList.map((i) => (
                <div
                  key={i.id}
                  className="flex items-center gap-2 p-2 rounded-md border border-danger/40 bg-danger/10"
                >
                  <Package className="w-3.5 h-3.5 text-danger shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{i.name}</div>
                    <div className="text-xs font-mono text-muted-foreground">{i.sku}</div>
                  </div>
                  <div className="text-xs font-mono text-danger shrink-0">
                    {i.qtyOnHand} / {i.reorderPoint}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <h3 className="font-semibold text-sm mb-3">Recently restocked</h3>
        {recentlyRestocked.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No restock history yet.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
            {recentlyRestocked.map((i) => (
              <div key={i.id} className="p-2 rounded-md border border-border bg-muted/20">
                <div className="font-medium text-sm truncate">{i.name}</div>
                <div className="text-xs font-mono text-muted-foreground">{i.sku}</div>
                <div className="text-xs text-muted-foreground mt-1">{i.lastRestocked}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Page() {
  const { inventoryItems, applyInventoryItem, vehicles, drivers, mechanics, admins } = useData();
  const [search, setSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const [category, setCategory] = useState(ALL_CATEGORIES);
  // Client feedback: "There is no inventory dashboard, if there are no
  // sub-menus there should at least be a multi panel dashboard e.g.
  // sub-menu panels and Inventory overview" — Overview is its own panel,
  // not a filter on the list. Archiving is a soft-hide (see
  // 20260717170000_archived_parts.sql) — Active/Archived are two disjoint
  // views over the same table, so low-stock/category derivations below
  // deliberately scope to the active set only.
  const [view, setView] = useState<"overview" | "active" | "archived" | "core-returns">(
    "overview",
  );
  const showArchived = view === "archived";
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Item | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const vehicleName = (id: string) => vehicles.find((v) => v.id === id)?.name ?? id;
  const personName = (id: string) =>
    [...admins, ...mechanics, ...drivers].find((p) => p.id === id)?.name ?? id;

  const activeItems = useMemo(() => inventoryItems.filter((i) => !i.archived), [inventoryItems]);
  const archivedCount = inventoryItems.length - activeItems.length;

  const categories = useMemo(
    () =>
      Array.from(new Set(activeItems.map((i) => i.category).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      ),
    [activeItems],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const pool = showArchived ? inventoryItems.filter((i) => i.archived) : activeItems;
    return pool.filter((i) => {
      const matchSearch =
        q === "" ||
        i.name.toLowerCase().includes(q) ||
        i.sku.toLowerCase().includes(q) ||
        i.location.toLowerCase().includes(q) ||
        i.manufacturer.toLowerCase().includes(q) ||
        i.manufacturerPartNumber.toLowerCase().includes(q) ||
        i.alternativePartNumber.toLowerCase().includes(q);
      const matchLow = !lowOnly || (!i.isUntracked && i.qtyOnHand <= i.reorderPoint);
      const matchCategory = category === ALL_CATEGORIES || i.category === category;
      return matchSearch && matchLow && matchCategory;
    });
  }, [inventoryItems, activeItems, showArchived, search, lowOnly, category]);

  const lowCount = useMemo(
    () => activeItems.filter((i) => !i.isUntracked && i.qtyOnHand <= i.reorderPoint).length,
    [activeItems],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  function exportCsv() {
    const csv = toCsv(
      [
        "SKU",
        "Name",
        "On hand",
        "Reserved",
        "Available",
        "Reorder point",
        "Last restocked",
        "Location",
        "Category",
        "Manufacturer",
        "Mfg part #",
        "Alt part #",
        "Supplier",
        "Alt supplier",
      ],
      filtered.map((i) => [
        i.sku,
        i.name,
        i.qtyOnHand,
        i.qtyReserved,
        i.qtyOnHand - i.qtyReserved,
        i.reorderPoint,
        i.lastRestocked,
        i.location,
        i.category,
        i.manufacturer,
        i.manufacturerPartNumber,
        i.alternativePartNumber,
        i.supplierId,
        i.alternativeSupplierId,
      ]),
    );
    downloadCsv(`inventory-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    toast.success(`Exported ${filtered.length} items`);
  }

  const [printingLabels, setPrintingLabels] = useState(false);
  async function printLabelsForFiltered() {
    if (filtered.length === 0) {
      toast.error("No parts match your filters");
      return;
    }
    // A few hundred QR encodes is fine; thousands would visibly stall the
    // tab. Narrowing the filter first is the fix, not a silent truncation
    // that ships fewer labels than the admin thinks they asked for.
    if (filtered.length > 300) {
      toast.error(`${filtered.length} parts match — narrow your search/category first (max 300)`);
      return;
    }
    setPrintingLabels(true);
    try {
      await printPartLabels(filtered.map((i) => ({ sku: i.sku, name: i.name })));
    } finally {
      setPrintingLabels(false);
    }
  }

  return (
    <AdminShell title="Inventory">
      <Tabs
        value={view}
        onValueChange={(v) => {
          setView(v as typeof view);
          setPage(0);
        }}
        className="mb-4"
      >
        <TabsList>
          <TabsTrigger value="overview" data-testid="admin-inv-tab-overview">
            Overview
          </TabsTrigger>
          <TabsTrigger value="active" data-testid="admin-inv-tab-active">
            Active ({activeItems.length})
          </TabsTrigger>
          <TabsTrigger value="archived" data-testid="admin-inv-tab-archived">
            Archived ({archivedCount})
          </TabsTrigger>
          <TabsTrigger value="core-returns" data-testid="admin-inv-tab-core-returns">
            Core returns
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {view === "overview" && (
        <InventoryOverview
          activeItems={activeItems}
          lowCount={lowCount}
          archivedCount={archivedCount}
          onJumpToLowStock={() => {
            setView("active");
            setLowOnly(true);
            setPage(0);
          }}
        />
      )}

      {view === "core-returns" && <CoreReturnsPanel />}

      {(view === "active" || view === "archived") && (
        <>
      <div className="flex flex-col sm:flex-row gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={`Search ${inventoryItems.length} parts by name, SKU, location, or part #…`}
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
        {categories.length > 0 && (
          <Select
            value={category}
            onValueChange={(v) => {
              setCategory(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="w-[160px]" data-testid="admin-inv-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="sm:ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} data-testid="admin-inv-export">
            <Download className="w-4 h-4" /> Export CSV
          </Button>
          {!showArchived && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void printLabelsForFiltered()}
                disabled={printingLabels}
                data-testid="admin-inv-print-labels"
              >
                {printingLabels ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Printer className="w-4 h-4" />
                )}
                Print labels ({filtered.length})
              </Button>
              <Button
                size="sm"
                onClick={() => setCreateOpen(true)}
                className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                data-testid="admin-inv-new"
              >
                <Plus className="w-4 h-4" /> New item
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {[
                "SKU",
                "Name",
                "Location",
                "Category",
                "Assigned to",
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
              const low = !i.isUntracked && i.qtyOnHand <= i.reorderPoint;
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
                      {i.photoUrl ? (
                        <span className="w-5 h-5 rounded overflow-hidden shrink-0 bg-muted">
                          <SignedPartImg path={i.photoUrl} alt="" />
                        </span>
                      ) : (
                        <Package className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="max-w-md truncate inline-block align-middle">{i.name}</span>
                      {i.isBom && (
                        <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-brand/15 text-amber-brand shrink-0">
                          BOM
                        </span>
                      )}
                      {i.isUntracked && (
                        <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                          Non-stock
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                    {i.location || "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{i.category || "—"}</td>
                  <td className="px-4 py-3 text-xs whitespace-nowrap">
                    {i.assignedVehicleId ? (
                      <span className="text-foreground">{vehicleName(i.assignedVehicleId)}</span>
                    ) : i.assignedUserId ? (
                      <span className="text-foreground">{personName(i.assignedUserId)}</span>
                    ) : (
                      <span className="text-muted-foreground italic">Spare pool</span>
                    )}
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
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-muted-foreground">
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
        </>
      )}

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
  const { vehicles, drivers, mechanics, admins, inventoryItems, bomComponents } = useData();
  const [name, setName] = useState(item.name);
  const [qty, setQty] = useState(String(item.qtyOnHand));
  const [reorder, setReorder] = useState(String(item.reorderPoint));
  const [location, setLocation] = useState(item.location);
  const [category, setCategory] = useState(item.category);
  const [manufacturer, setManufacturer] = useState(item.manufacturer);
  const [mfgPartNumber, setMfgPartNumber] = useState(item.manufacturerPartNumber);
  const [altPartNumber, setAltPartNumber] = useState(item.alternativePartNumber);
  const [supplierId, setSupplierId] = useState(item.supplierId);
  const [altSupplierId, setAltSupplierId] = useState(item.alternativeSupplierId);
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null);
  const [isUntracked, setIsUntracked] = useState(item.isUntracked);
  const [saving, setSaving] = useState(false);

  // Assignment: exactly one of unassigned/vehicle/person — mirrors the DB
  // CHECK constraint (inventory_items_assignment_exclusive) client-side so
  // the form can't even construct the invalid "both set" combination.
  const [assignMode, setAssignMode] = useState<"none" | "vehicle" | "person">(
    item.assignedVehicleId ? "vehicle" : item.assignedUserId ? "person" : "none",
  );
  const [assignVehicleId, setAssignVehicleId] = useState(item.assignedVehicleId ?? "");
  const [assignUserId, setAssignUserId] = useState(item.assignedUserId ?? "");
  const people = [...admins, ...mechanics, ...drivers];
  const [archiveBusy, setArchiveBusy] = useState(false);

  async function toggleArchive() {
    const next = !item.archived;
    setArchiveBusy(true);
    try {
      const r = await api.updateInventoryItem(item.id, { archived: next });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(next ? `${item.sku} archived` : `${item.sku} restored`);
      onSaved({ ...item, archived: next });
    } finally {
      setArchiveBusy(false);
    }
  }

  async function save() {
    const qtyN = Number(qty);
    const reorderN = Number(reorder);
    if (!name.trim() || isNaN(qtyN) || qtyN < 0 || isNaN(reorderN) || reorderN < 0) {
      toast.error("Enter a name and non-negative numbers");
      return;
    }
    if (assignMode === "vehicle" && !assignVehicleId) {
      toast.error("Pick a vehicle, or switch assignment to Unassigned");
      return;
    }
    if (assignMode === "person" && !assignUserId) {
      toast.error("Pick a person, or switch assignment to Unassigned");
      return;
    }
    const nextAssignedVehicleId = assignMode === "vehicle" ? assignVehicleId : null;
    const nextAssignedUserId = assignMode === "person" ? assignUserId : null;
    setSaving(true);
    try {
      const r = await api.updateInventoryItem(item.id, {
        name: name.trim(),
        qtyOnHand: qtyN,
        reorderPoint: reorderN,
        location,
        category,
        manufacturer,
        manufacturerPartNumber: mfgPartNumber,
        alternativePartNumber: altPartNumber,
        supplierId,
        alternativeSupplierId: altSupplierId,
        assignedVehicleId: nextAssignedVehicleId,
        assignedUserId: nextAssignedUserId,
        isUntracked,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      let photoUrl = item.photoUrl;
      if (pendingPhoto) {
        const p = await api.uploadInventoryPhoto({ itemId: item.id, dataUrl: pendingPhoto });
        if (!p.ok) {
          // The core edit already saved — a failed photo upload shouldn't
          // look like the whole save failed, just flag it separately.
          toast.error(`Saved, but photo upload failed: ${p.reason}`);
        } else {
          photoUrl = p.photoUrl;
        }
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
        location: location.trim(),
        category: category.trim(),
        manufacturer: manufacturer.trim(),
        manufacturerPartNumber: mfgPartNumber.trim(),
        alternativePartNumber: altPartNumber.trim(),
        supplierId: supplierId.trim(),
        alternativeSupplierId: altSupplierId.trim(),
        photoUrl,
        assignedVehicleId: nextAssignedVehicleId,
        assignedUserId: nextAssignedUserId,
        isUntracked,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <PhotoField
        currentPhotoUrl={item.photoUrl}
        pendingDataUrl={pendingPhoto}
        onPick={setPendingPhoto}
      />
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <Label>Untracked / non-stock part</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Consumable or one-off purchase — skip qty tracking, low-stock alerts, and PR
            reservation for this part.
          </p>
        </div>
        <Switch
          checked={isUntracked}
          onCheckedChange={setIsUntracked}
          data-testid="admin-inv-edit-untracked"
        />
      </div>
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
            disabled={isUntracked}
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
            disabled={isUntracked}
          />
        </div>
      </div>
      {!isUntracked && (
        <p className="text-xs text-muted-foreground">
          Reserved: {item.qtyReserved} (managed automatically by purchase-request approvals)
        </p>
      )}
      <div>
        <Label>Location</Label>
        <Input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. Bay 1 — Shelf A2"
          className="mt-1"
        />
      </div>
      <div>
        <Label>Category</Label>
        <Input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="e.g. Brakes, Fluids, Filters"
          className="mt-1"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Manufacturer</Label>
          <Input
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <Label>Mfg. part #</Label>
          <Input
            value={mfgPartNumber}
            onChange={(e) => setMfgPartNumber(e.target.value)}
            className="mt-1 font-mono"
          />
        </div>
      </div>
      <div>
        <Label>Alternative part #</Label>
        <Input
          value={altPartNumber}
          onChange={(e) => setAltPartNumber(e.target.value)}
          placeholder="Cross-reference part number"
          className="mt-1 font-mono"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Supplier</Label>
          <Input
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            placeholder="e.g. SUP-01"
            className="mt-1 font-mono"
          />
        </div>
        <div>
          <Label>Alt. supplier</Label>
          <Input
            value={altSupplierId}
            onChange={(e) => setAltSupplierId(e.target.value)}
            placeholder="e.g. SUP-02"
            className="mt-1 font-mono"
          />
        </div>
      </div>
      <div>
        <Label>Assigned to</Label>
        <div className="grid grid-cols-3 gap-1 mt-1.5 bg-muted rounded-md p-1">
          {(["none", "vehicle", "person"] as const).map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => setAssignMode(m)}
              className={cn(
                "h-9 rounded text-sm font-medium capitalize",
                assignMode === m
                  ? "bg-amber-brand text-amber-brand-foreground"
                  : "text-muted-foreground",
              )}
            >
              {m === "none" ? "Unassigned" : m}
            </button>
          ))}
        </div>
        {assignMode === "vehicle" && (
          <Select value={assignVehicleId} onValueChange={setAssignVehicleId}>
            <SelectTrigger className="mt-2">
              <SelectValue placeholder="Pick a vehicle" />
            </SelectTrigger>
            <SelectContent>
              {vehicles.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.id} — {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {assignMode === "person" && (
          <Select value={assignUserId} onValueChange={setAssignUserId}>
            <SelectTrigger className="mt-2">
              <SelectValue placeholder="Pick a person" />
            </SelectTrigger>
            <SelectContent>
              {people.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} ({p.role})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <BomSection
        item={item}
        allItems={inventoryItems}
        existingComponents={bomComponents.filter((c) => c.parentItemId === item.id)}
      />

      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => void printPartLabels([{ sku: item.sku, name: item.name }])}
          data-testid="admin-inv-edit-print-label"
        >
          <Printer className="w-4 h-4" /> Print label
        </Button>
        <Button
          variant="outline"
          onClick={() => void toggleArchive()}
          disabled={archiveBusy}
          className={item.archived ? "" : "text-danger hover:text-danger"}
          data-testid="admin-inv-edit-archive"
        >
          {archiveBusy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : item.archived ? (
            <ArchiveRestore className="w-4 h-4" />
          ) : (
            <Archive className="w-4 h-4" />
          )}
          {item.archived ? "Restore" : "Archive"}
        </Button>
        <Button
          onClick={() => void save()}
          disabled={saving}
          className="flex-1 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          data-testid="admin-inv-edit-save"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
        </Button>
      </div>
    </div>
  );
}

const NO_COMPONENT = "__pick__";

// Client feedback: "one part number that represents many part numbers...
// when the part number is allocated the full list of parts are allocated
// and the stock is automatically adjusted... a pick list can be created
// for the stores." A BOM part's own qty_on_hand carries no real stock —
// see 20260717200000_bom_multi_part.sql — so this section is a separate
// save action from the rest of the part's fields, matching how
// Photo/Archive are already their own actions rather than folded into the
// main Save button.
function BomSection({
  item,
  allItems,
  existingComponents,
}: {
  item: Item;
  allItems: Item[];
  existingComponents: { componentItemId: string; qtyPer: number }[];
}) {
  const [enabled, setEnabled] = useState(item.isBom);
  const [rows, setRows] = useState(existingComponents);
  const [pickerId, setPickerId] = useState(NO_COMPONENT);
  const [pickerQty, setPickerQty] = useState("1");
  const [buildUnits, setBuildUnits] = useState("1");
  const [saving, setSaving] = useState(false);

  // A BOM can't contain itself or another BOM part (no nested kits — the
  // client's ask was flat "part represents many parts", not recursive).
  const pickable = allItems.filter((i) => i.id !== item.id && !i.isBom && !i.archived);

  function addRow() {
    if (pickerId === NO_COMPONENT) {
      toast.error("Pick a component");
      return;
    }
    const qty = Math.max(1, Math.floor(Number(pickerQty) || 1));
    setRows((arr) => {
      const idx = arr.findIndex((r) => r.componentItemId === pickerId);
      if (idx >= 0) {
        const copy = arr.slice();
        copy[idx] = { ...copy[idx], qtyPer: copy[idx].qtyPer + qty };
        return copy;
      }
      return [...arr, { componentItemId: pickerId, qtyPer: qty }];
    });
    setPickerId(NO_COMPONENT);
    setPickerQty("1");
  }
  function removeRow(componentItemId: string) {
    setRows((arr) => arr.filter((r) => r.componentItemId !== componentItemId));
  }

  async function saveBom() {
    if (enabled && rows.length === 0) {
      toast.error("Add at least one component, or turn the BOM toggle off");
      return;
    }
    setSaving(true);
    try {
      const r = await api.setBomComponents(item.id, enabled, rows);
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(enabled ? "BOM recipe saved" : "No longer a BOM part");
    } finally {
      setSaving(false);
    }
  }

  const componentName = (id: string) => allItems.find((i) => i.id === id)?.name ?? id;
  const componentAvailable = (id: string) => {
    const c = allItems.find((i) => i.id === id);
    return c ? c.qtyOnHand - c.qtyReserved : 0;
  };
  const buildableNow =
    rows.length === 0
      ? 0
      : Math.min(...rows.map((r) => Math.floor(componentAvailable(r.componentItemId) / r.qtyPer)));

  function printPickList() {
    const units = Math.max(1, Math.floor(Number(buildUnits) || 1));
    const rowsHtml = rows
      .map((r) => {
        const c = allItems.find((i) => i.id === r.componentItemId);
        const need = r.qtyPer * units;
        return `<tr><td>${escapeHtml(c?.name ?? r.componentItemId)}</td><td>${escapeHtml(c?.sku ?? "")}</td><td>${need}</td><td>${componentAvailable(r.componentItemId)}</td></tr>`;
      })
      .join("");
    openPrintView(
      `Pick list — ${item.name}`,
      `
      <h2 style="margin:0 0 4px 0;font-size:18px;">Pick List</h2>
      <p style="margin:0 0 16px 0;color:#666;font-size:13px;">${escapeHtml(item.name)} (${escapeHtml(item.sku)}) — building ${units} unit${units === 1 ? "" : "s"}</p>
      <table>
        <tr><td style="font-weight:600;">Part</td><td style="font-weight:600;">SKU</td><td style="font-weight:600;">Qty needed</td><td style="font-weight:600;">On hand (available)</td></tr>
        ${rowsHtml}
      </table>
      `,
    );
  }

  return (
    <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/20">
      <div className="flex items-center justify-between">
        <div>
          <Label className="cursor-pointer">Bill of Materials (BOM)</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            This part represents a kit of other parts — allocating it consumes the
            components below instead of its own count.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      {enabled && (
        <>
          {rows.length > 0 && (
            <div className="space-y-1.5">
              {rows.map((r) => (
                <div
                  key={r.componentItemId}
                  className="flex items-center justify-between text-sm p-2 rounded-md border border-border bg-card"
                >
                  <span className="truncate">{componentName(r.componentItemId)}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-xs text-muted-foreground">
                      × {r.qtyPer}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeRow(r.componentItemId)}
                      className="p-1 rounded hover:bg-danger/10 text-muted-foreground hover:text-danger"
                      aria-label={`Remove ${componentName(r.componentItemId)}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Buildable now: <span className="font-mono font-medium">{buildableNow}</span> (limited
                by the lowest-stock component)
              </p>
            </div>
          )}

          <div className="flex gap-2 items-end">
            <div className="flex-1 min-w-0">
              <Label className="text-xs">Add component</Label>
              <Select value={pickerId} onValueChange={setPickerId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Pick a part" />
                </SelectTrigger>
                <SelectContent>
                  {pickable.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.sku})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-16">
              <Label className="text-xs">Qty</Label>
              <Input
                type="number"
                min="1"
                value={pickerQty}
                onChange={(e) => setPickerQty(e.target.value)}
                className="mt-1 font-mono"
              />
            </div>
            <Button type="button" variant="outline" className="h-10" onClick={addRow}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>

          {rows.length > 0 && (
            <div className="flex gap-2 items-end pt-1">
              <div className="w-24">
                <Label className="text-xs">Units to build</Label>
                <Input
                  type="number"
                  min="1"
                  value={buildUnits}
                  onChange={(e) => setBuildUnits(e.target.value)}
                  className="mt-1 font-mono"
                />
              </div>
              <Button type="button" variant="outline" onClick={printPickList}>
                <Printer className="w-4 h-4" /> Print pick list
              </Button>
            </div>
          )}
        </>
      )}

      <Button
        type="button"
        onClick={() => void saveBom()}
        disabled={saving}
        className="w-full"
        variant="outline"
        data-testid="admin-inv-bom-save"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save BOM"}
      </Button>
    </div>
  );
}

function CreateItemForm({ onSaved }: { onSaved: (i: Item) => void }) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [qty, setQty] = useState("0");
  const [reorder, setReorder] = useState("0");
  const [location, setLocation] = useState("");
  const [category, setCategory] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [mfgPartNumber, setMfgPartNumber] = useState("");
  const [altPartNumber, setAltPartNumber] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [altSupplierId, setAltSupplierId] = useState("");
  const [pendingPhoto, setPendingPhoto] = useState<string | null>(null);
  const [isUntracked, setIsUntracked] = useState(false);
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
        location,
        category,
        manufacturer,
        manufacturerPartNumber: mfgPartNumber,
        alternativePartNumber: altPartNumber,
        supplierId,
        alternativeSupplierId: altSupplierId,
        isUntracked,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      // The new row needs an id before a photo can be attached (the storage
      // path is <itemId>/<random>.jpg), so this can only happen as a
      // follow-up call, not part of the create payload itself.
      let photoUrl = "";
      if (pendingPhoto) {
        const p = await api.uploadInventoryPhoto({ itemId: r.id, dataUrl: pendingPhoto });
        if (!p.ok) {
          toast.error(`Item added, but photo upload failed: ${p.reason}`);
        } else {
          photoUrl = p.photoUrl;
        }
      }
      toast.success(`${sku.trim()} added`);
      onSaved({
        id: r.id,
        name: name.trim(),
        sku: sku.trim(),
        qtyOnHand: Math.round(qtyN),
        qtyReserved: 0,
        reorderPoint: Math.round(reorderN),
        supplierId: supplierId.trim(),
        lastRestocked: new Date().toISOString().slice(0, 10),
        location: location.trim(),
        category: category.trim(),
        manufacturer: manufacturer.trim(),
        manufacturerPartNumber: mfgPartNumber.trim(),
        alternativePartNumber: altPartNumber.trim(),
        alternativeSupplierId: altSupplierId.trim(),
        photoUrl,
        assignedVehicleId: null,
        assignedUserId: null,
        archived: false,
        isBom: false,
        isUntracked,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <PhotoField pendingDataUrl={pendingPhoto} onPick={setPendingPhoto} />
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <Label>Untracked / non-stock part</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Consumable or one-off purchase — skip qty tracking, low-stock alerts, and PR
            reservation for this part.
          </p>
        </div>
        <Switch
          checked={isUntracked}
          onCheckedChange={setIsUntracked}
          data-testid="admin-inv-new-untracked"
        />
      </div>
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
      <div>
        <Label>Location</Label>
        <Input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. Bay 1 — Shelf A2"
          className="mt-1"
        />
      </div>
      <div>
        <Label>Category</Label>
        <Input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="e.g. Brakes, Fluids, Filters"
          className="mt-1"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Manufacturer</Label>
          <Input
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <Label>Mfg. part #</Label>
          <Input
            value={mfgPartNumber}
            onChange={(e) => setMfgPartNumber(e.target.value)}
            className="mt-1 font-mono"
          />
        </div>
      </div>
      <div>
        <Label>Alternative part #</Label>
        <Input
          value={altPartNumber}
          onChange={(e) => setAltPartNumber(e.target.value)}
          placeholder="Cross-reference part number"
          className="mt-1 font-mono"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Supplier</Label>
          <Input
            value={supplierId}
            onChange={(e) => setSupplierId(e.target.value)}
            placeholder="e.g. SUP-01"
            className="mt-1 font-mono"
          />
        </div>
        <div>
          <Label>Alt. supplier</Label>
          <Input
            value={altSupplierId}
            onChange={(e) => setAltSupplierId(e.target.value)}
            placeholder="e.g. SUP-02"
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
