import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { Plus, ShoppingCart, Package, AlertTriangle, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { InventoryCheckSnapshot, InventoryItem } from "@/types/domain";

export const Route = createFileRoute("/mechanic/purchase-requests")({
  head: () => ({ meta: [{ title: "Purchase requests — Engage Hydrovac CRM" }] }),
  component: Page,
});

const urgencies: ("low" | "medium" | "high")[] = ["low", "medium", "high"];

function Page() {
  const { purchaseRequests, inventoryItems } = useData();
  const { user } = useAuth();
  const [tab, setTab] = useState<"mine" | "all">("mine");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const list = useMemo(
    () =>
      tab === "mine" ? purchaseRequests.filter((p) => p.mechanicId === user.id) : purchaseRequests,
    [purchaseRequests, tab, user.id],
  );

  const open = openId ? purchaseRequests.find((p) => p.id === openId) : null;
  // Legacy fallback only — when the persisted snapshot is null (rows
  // submitted before the inventory_check_result column landed) we still
  // approximate a match against live inventory so the sheet isn't empty.
  const inventoryMatch = open
    ? inventoryItems.find((i) =>
        i.name.toLowerCase().includes(open.item.toLowerCase().split(" —")[0]),
      )
    : null;

  return (
    <MechanicShell title="Purchase requests">
      <div className="flex items-center justify-between mb-4">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="mine">My requests</TabsTrigger>
            <TabsTrigger value="all">All requests</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          onClick={() => setCreating(true)}
          className="h-9 px-3 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-sm font-semibold"
        >
          <Plus className="w-4 h-4" /> New request
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["PR #", "Item", "Qty", "Cost", "Urgency", "Created", "Status"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr
                key={p.id}
                className="border-t border-border hover:bg-muted/30 cursor-pointer"
                onClick={() => setOpenId(p.id)}
              >
                <td className="px-4 py-3 font-mono text-xs font-medium text-amber-brand">{p.id}</td>
                <td className="px-4 py-3 font-medium">{p.item}</td>
                <td className="px-4 py-3 font-mono text-xs">{p.quantity}</td>
                <td className="px-4 py-3 font-mono">${p.estimatedCost}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={p.urgency.charAt(0).toUpperCase() + p.urgency.slice(1)} />
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {p.createdAt.slice(0, 10)}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={p.status.charAt(0).toUpperCase() + p.status.slice(1)} />
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No purchase requests in this list.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <ShoppingCart className="w-4 h-4" /> <span className="font-mono">{open.id}</span>
                </SheetTitle>
              </SheetHeader>
              <div className="space-y-4 mt-6">
                <Field k="Item" v={open.item} />
                <Field k="Quantity" v={String(open.quantity)} />
                <Field k="Reason" v={open.reason} />
                <Field k="Estimated cost" v={`$${open.estimatedCost}`} />
                <Field k="Urgency" v={open.urgency.toUpperCase()} />
                <Field k="Created" v={new Date(open.createdAt).toLocaleString()} />
                <div className="border border-border rounded-md p-3 bg-muted/30">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                      Inventory check
                    </div>
                    {open.inventoryCheckResult !== null && (
                      <div className="text-[10px] font-mono text-muted-foreground">
                        {open.inventoryCheckResult.length > 0
                          ? `matched ${open.inventoryCheckResult.length} item${open.inventoryCheckResult.length === 1 ? "" : "s"}`
                          : "no matches"}
                      </div>
                    )}
                  </div>
                  {open.inventoryCheckResult === null ? (
                    inventoryMatch ? (
                      <div className="text-sm flex items-center gap-2">
                        <Package className="w-3.5 h-3.5" />
                        Match found: <span className="font-mono">{inventoryMatch.sku}</span> ·{" "}
                        {inventoryMatch.qtyOnHand} on hand
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        No matching SKU. Request will go to suppliers.
                      </div>
                    )
                  ) : open.inventoryCheckResult.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      Inventory checked — no matches found at submission.
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {open.inventoryCheckResult.map((m) => (
                        <div
                          key={m.inventoryItemId}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Package className="w-3.5 h-3.5 shrink-0" />
                          <span className="flex-1 truncate">{m.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {m.sku}
                          </span>
                          <span
                            className={
                              m.qtyOnHand > 0
                                ? "text-warning font-semibold text-xs"
                                : "text-muted-foreground text-xs"
                            }
                          >
                            {m.qtyOnHand} on hand
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="border border-border rounded-md p-3 bg-muted/30">
                  <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
                    Approval chain
                  </div>
                  <div className="text-sm space-y-0.5">
                    <div>1. Mechanic submitted</div>
                    <div
                      className={open.status === "pending" ? "text-amber-brand font-medium" : ""}
                    >
                      2. {open.status === "pending" ? "Awaiting" : "Reviewed by"} management{" "}
                      {open.approvedBy && `(${open.approvedBy})`}
                    </div>
                    <div
                      className={
                        open.status === "ordered"
                          ? "text-success font-medium"
                          : "text-muted-foreground"
                      }
                    >
                      3. {open.status === "ordered" ? "Ordered" : "Order placement"}
                    </div>
                  </div>
                </div>
                {open.status === "approved" && open.supplierId && (
                  <Field k="Assigned supplier" v={open.supplierId} />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <NewRequestSheet open={creating} onOpenChange={setCreating} />
    </MechanicShell>
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

function NewRequestSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { inventoryItems } = useData();
  const { user } = useAuth();
  const [urgency, setUrgency] = useState<"low" | "medium" | "high">("medium");
  const [checkInv, setCheckInv] = useState(true);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [cost, setCost] = useState("");
  const [loading, setLoading] = useState(false);
  const [overrodeStock, setOverrodeStock] = useState(false);

  // Inline inventory search: as the mechanic types (and only when they've
  // toggled "Check inventory first" on), match against name OR sku using a
  // case-insensitive substring — the moral equivalent of `ILIKE %query%` in
  // Postgres. We don't fire a network call here; data.inventoryItems is the
  // hydrated mirror of public.inventory_items, so a memoised in-array scan is
  // both faster and keeps the form responsive offline.
  const matches: InventoryItem[] = useMemo(() => {
    if (!checkInv) return [];
    const q = item.trim().toLowerCase();
    if (q.length < 2) return [];
    // Archived (retired/superseded) parts shouldn't surface as "we already
    // have stock" — that stock isn't in active circulation anymore.
    return inventoryItems.filter(
      (i) => !i.archived && (i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)),
    );
  }, [checkInv, item, inventoryItems]);

  // Live parse of the Quantity field for the stock-correlation check below.
  // Falls back to 1 while the field is empty/invalid mid-typing so the
  // warning doesn't flicker off — submit() re-validates the real value.
  const qtyNumLive = Math.max(1, Math.floor(Number(quantity) || 1));

  // Client feedback: the old check flagged ANY on-hand stock ("we have 2")
  // without weighing it against what was actually requested ("but I need
  // 4") — no correlation. Free stock (on hand minus what's already reserved
  // for other approved PRs) has to cover the full requested quantity before
  // we treat this as "we already have enough, are you sure you want a new
  // order" and gate the override. Partial stock isn't enough to do the job,
  // so it doesn't trigger the warning — it just needs a supplier order like
  // a zero-stock item would.
  const coveringMatch = matches.find((m) => m.qtyOnHand - m.qtyReserved >= qtyNumLive);
  const hasStock = coveringMatch !== undefined;

  function reset() {
    setItem("");
    setQuantity("1");
    setReason("");
    setCost("");
    setOverrodeStock(false);
  }

  // Reset the override the moment the typed item changes — otherwise a
  // mechanic could override stock for "brake pads", then re-type a different
  // part and skip the warning entirely.
  function handleItemChange(next: string) {
    setItem(next);
    if (overrodeStock) setOverrodeStock(false);
  }

  // Same reasoning as handleItemChange — since "covers the need" now depends
  // on quantity, an override granted at qty 1 must not silently carry over
  // once the mechanic bumps it up to qty 4.
  function handleQuantityChange(next: string) {
    setQuantity(next);
    if (overrodeStock) setOverrodeStock(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!item || !reason || !cost) {
      toast.error("Fill all required fields");
      return;
    }
    const costNum = Number(cost);
    if (!Number.isFinite(costNum) || costNum < 0) {
      toast.error("Estimated cost must be a non-negative number");
      return;
    }
    const qtyNum = Math.floor(Number(quantity));
    if (!Number.isFinite(qtyNum) || qtyNum < 1) {
      toast.error("Quantity must be a whole number of 1 or more");
      return;
    }
    if (checkInv && hasStock && !overrodeStock) {
      toast.error("Inventory has matching stock — confirm override below to continue");
      return;
    }
    setLoading(true);
    try {
      // Build the snapshot we'll persist to purchase_requests.inventory_check_result.
      // null = "the mechanic skipped the check"; [] = "checked, found nothing"
      // — two distinct audit signals the admin review panel cares about.
      const inventoryCheckResult: InventoryCheckSnapshot[] | null = checkInv
        ? matches.map((m) => ({
            inventoryItemId: m.id,
            name: m.name,
            sku: m.sku,
            qtyOnHand: m.qtyOnHand,
            supplierId: m.supplierId,
          }))
        : null;
      await api.submitPurchaseRequest({
        mechanicId: user.id,
        item,
        quantity: qtyNum,
        reason,
        estimatedCost: costNum,
        urgency,
        inventoryCheckedAt: checkInv ? new Date().toISOString() : null,
        inventoryCheckResult,
        approvedBy: null,
        supplierId: null,
        // Approval-time + supplier-order bookkeeping fields — admin fills
        // these via approvePurchaseRequest / markPurchaseRequestOrdered.
        inventoryDecrementQty: null,
        orderedAt: null,
        orderedBy: null,
        supplierOrderRef: null,
      });
      toast.success("Purchase request sent for approval");
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Submit failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>New purchase request</SheetTitle>
        </SheetHeader>
        <form onSubmit={submit} className="space-y-3 mt-6">
          <div>
            <Label>Item needed</Label>
            <Input
              value={item}
              onChange={(e) => handleItemChange(e.target.value)}
              placeholder="e.g. Brake pad set"
              className="mt-1.5"
            />
            {/* Inline inventory results render right under the input — the
                closer the feedback is to the typed query, the harder it is
                for the mechanic to claim they didn't see the existing stock. */}
            {checkInv && item.trim().length >= 2 && (
              <div className="mt-2 space-y-1">
                {matches.length === 0 ? (
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5 px-1">
                    <Package className="w-3 h-3" /> No inventory matches — supplier order will be
                    needed.
                  </div>
                ) : (
                  matches.map((m) => (
                    <div
                      key={m.id}
                      className={cn(
                        "flex items-center gap-2 text-xs rounded-md px-2 py-1.5 border",
                        m.qtyOnHand > 0
                          ? "bg-warning/10 border-warning/40 text-warning-foreground"
                          : "bg-muted/40 border-border text-muted-foreground",
                      )}
                    >
                      <Package className="w-3 h-3 shrink-0" />
                      <span className="flex-1 truncate">
                        We have <strong>{m.qtyOnHand}</strong> of{" "}
                        <span className="italic">&apos;{m.name}&apos;</span> in stock at{" "}
                        <span className="font-mono">{m.supplierId}</span>
                      </span>
                      <span className="font-mono shrink-0">{m.sku}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          <div>
            <Label>Quantity</Label>
            <Input
              type="number"
              min="1"
              step="1"
              value={quantity}
              onChange={(e) => handleQuantityChange(e.target.value)}
              className="mt-1.5 font-mono w-24"
            />
          </div>
          <div>
            <Label>Reason / job reference</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1.5"
            />
          </div>
          <div>
            <Label>Estimated cost</Label>
            <Input
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="0.00"
              className="mt-1.5 font-mono"
            />
          </div>
          <div>
            <Label>Urgency</Label>
            <div className="grid grid-cols-3 gap-1 mt-1.5 bg-muted rounded-md p-1">
              {urgencies.map((u) => (
                <button
                  type="button"
                  key={u}
                  onClick={() => setUrgency(u)}
                  className={cn(
                    "h-10 rounded text-sm font-medium capitalize",
                    urgency === u
                      ? "bg-amber-brand text-amber-brand-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-start justify-between gap-3 p-3 bg-muted/40 rounded-lg border border-border">
            <div className="flex-1">
              <Label className="cursor-pointer">Check inventory first</Label>
              <p className="text-xs text-muted-foreground mt-1">
                System will check existing stock before routing for approval
              </p>
            </div>
            <Switch checked={checkInv} onCheckedChange={setCheckInv} />
          </div>
          {/* Pre-submit stock warning. Drives the gating in submit() — until
              the mechanic explicitly checks the override they can't fire a
              PR that would duplicate stock we already have on hand. */}
          {checkInv && hasStock && (
            <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 space-y-2">
              <div className="flex items-start gap-2 text-sm">
                <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium text-warning-foreground">
                    Are you sure? We have stock.
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    One or more matching items show qty on hand &gt; 0. Confirm an override if you
                    still need a fresh order (different spec, reserved for another job, etc.).
                  </p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-xs cursor-pointer pl-6">
                <input
                  type="checkbox"
                  checked={overrodeStock}
                  onChange={(e) => setOverrodeStock(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                Override — submit anyway
              </label>
            </div>
          )}
          <Button
            type="submit"
            disabled={loading || (checkInv && hasStock && !overrodeStock)}
            className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold h-11"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Submitting…
              </>
            ) : (
              "Submit for approval"
            )}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
