import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Check,
  X,
  Package,
  ShoppingCart,
  Truck,
  Plus,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { InventoryCheckSnapshot, InventoryItem, PurchaseRequest } from "@/types/domain";

const urgencies: ("low" | "medium" | "high")[] = ["low", "medium", "high"];

export const Route = createFileRoute("/admin/purchase-requests")({
  head: () => ({ meta: [{ title: "Purchase requests — Engage Hydrovac CRM" }] }),
  component: Page,
});

// Mirror the fuzzy match the api layer does so the detail sheet can render
// "we reserved 1 of N on hand at <sku>" without re-querying. Kept here (not
// shared from api.ts) because the API helper is purely internal and the UI
// only needs the LOOKUP, not the reservation write.
function findMatchedInventory(
  pr: PurchaseRequest,
  inventory: InventoryItem[],
): InventoryItem | null {
  const needle = pr.item.trim().toLowerCase();
  if (!needle) return null;
  const candidates = inventory.filter(
    (it) =>
      it.name.toLowerCase().includes(needle) ||
      needle.includes(it.name.toLowerCase()) ||
      it.sku.toLowerCase().includes(needle) ||
      needle.includes(it.sku.toLowerCase()),
  );
  if (candidates.length === 0) return null;
  // Same "shortest-name = tightest match" heuristic the api uses.
  return candidates.slice().sort((a, b) => a.name.length - b.name.length)[0];
}

function Page() {
  const { purchaseRequests, inventoryItems, mechanics } = useData();
  const { user } = useAuth();
  // Default to "all" so the row-level affordances (Approve / Reject / Mark
  // ordered) are all reachable from a fresh page load without forcing the
  // admin to switch tabs first. Per-row buttons gate themselves on status,
  // so this only widens what's visible — it doesn't add bogus actions.
  const [tab, setTab] = useState<"pending" | "approved" | "rejected" | "ordered" | "all">(
    "all",
  );
  const [openId, setOpenId] = useState<string | null>(null);
  // Inline "mark ordered" form: stores the supplier order ref the admin types
  // in. Keyed by PR id so the form is local to the row that's currently being
  // ordered (which is always the one in the open sheet).
  const [orderRef, setOrderRef] = useState("");
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(
    () => purchaseRequests.filter((p) => (tab === "all" ? true : p.status === tab)),
    [purchaseRequests, tab],
  );
  const open = openId ? purchaseRequests.find((p) => p.id === openId) : null;
  // Live (current) matched inventory item — the post-approval qty_on_hand the
  // admin sees here reflects whatever the qty_reserved bump from approval left
  // behind, so the sheet can render "We reserved 1 of N in stock".
  const inventoryMatch = open ? findMatchedInventory(open, inventoryItems) : null;

  async function approve(id: string) {
    try {
      const res = await api.approvePurchaseRequest(id, user.id);
      if (res.reservedInventory) {
        toast.success(`${id} approved · reserved ${res.reservedInventory.qty} from stock`);
      } else if (res.matchedUntracked) {
        toast.success(`${id} approved · matched a non-stock/consumable part, no reservation needed`);
      } else {
        toast.success(`${id} approved · no stock match, place supplier order`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to approve ${id}`);
    }
  }
  async function reject(id: string) {
    try {
      // Mock-only path — no api.rejectPurchaseRequest yet, so this just
      // records the intent in the toast log. Wrapped defensively so a
      // future api wire-up automatically picks up the failure-toast path.
      toast.error(`${id} rejected (mock)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Reject failed: ${msg}`);
    }
  }
  async function markOrdered(id: string) {
    const ref = orderRef.trim();
    if (!ref) {
      toast.error("Enter the supplier order reference first");
      return;
    }
    setOrderSubmitting(true);
    try {
      await api.markPurchaseRequestOrdered(id, ref);
      toast.success(`${id} marked ordered · ref ${ref}`);
      setOrderRef("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to mark ${id} ordered`);
    } finally {
      setOrderSubmitting(false);
    }
  }

  return (
    <AdminShell title="Purchase requests">
      <div className="flex justify-end mb-3">
        <Button
          onClick={() => setCreating(true)}
          data-testid="open-new-purchase-request"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> New purchase request
        </Button>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="pending">
            Pending ({purchaseRequests.filter((p) => p.status === "pending").length})
          </TabsTrigger>
          <TabsTrigger value="approved">
            Approved ({purchaseRequests.filter((p) => p.status === "approved").length})
          </TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
          <TabsTrigger value="ordered">
            Ordered ({purchaseRequests.filter((p) => p.status === "ordered").length})
          </TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["PR #", "Mechanic", "Item", "Qty", "Cost", "Urgency", "Created", "Status", "Actions"].map(
                (h) => (
                  <th key={h} className="text-left font-medium px-4 py-3">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const m = mechanics.find((x) => x.id === p.mechanicId);
              return (
                <tr
                  key={p.id}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                  onClick={() => setOpenId(p.id)}
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium text-amber-brand">
                    {p.id}
                  </td>
                  <td className="px-4 py-3">{m?.name ?? "—"}</td>
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
                    {/* Lowercase status hits the explicit lowercase keys in
                        StatusBadge (incl. the new 'ordered' blue variant),
                        so 'ordered' gets a distinct color from 'approved'. */}
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {p.status === "pending" ? (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-success text-success hover:bg-success/10"
                          data-testid={`approve-pr-${p.id}`}
                          onClick={() => approve(p.id)}
                        >
                          <Check className="w-3 h-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-danger text-danger hover:bg-danger/10"
                          data-testid={`reject-pr-${p.id}`}
                          onClick={() => reject(p.id)}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ) : p.status === "approved" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs"
                        data-testid={`mark-ordered-pr-${p.id}`}
                        onClick={() => {
                          setOpenId(p.id);
                          setOrderRef("");
                        }}
                      >
                        <Truck className="w-3 h-3" />
                        Mark ordered
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No requests in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet
        open={!!openId}
        onOpenChange={(o) => {
          if (!o) {
            setOpenId(null);
            setOrderRef("");
          }
        }}
      >
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {open && (
            <>
              <SheetHeader>
                {/* pr-8 reserves space for the auto-rendered SheetContent close
                    X at right-4 so the ml-auto StatusBadge doesn't collide
                    with / sit behind the close icon. */}
                <SheetTitle className="flex items-center gap-2 pr-8">
                  <ShoppingCart className="w-4 h-4" />
                  <span className="font-mono">{open.id}</span>
                  <StatusBadge status={open.status} className="ml-auto" />
                </SheetTitle>
              </SheetHeader>
              <div className="space-y-4 mt-6">
                <Field k="Item" v={open.item} />
                <Field k="Quantity" v={String(open.quantity)} />
                <Field k="Reason" v={open.reason} />
                <Field k="Estimated cost" v={`$${open.estimatedCost}`} />
                <Field k="Urgency" v={open.urgency.toUpperCase()} />
                <Field
                  k="Mechanic"
                  v={mechanics.find((m) => m.id === open.mechanicId)?.name ?? "—"}
                />
                {/* Inventory check snapshot — what the mechanic actually saw at
                    submission. Three states:
                      - snapshot is null  → legacy row, fall back to live match
                      - snapshot is []     → "checked, no matches" (clear audit)
                      - snapshot has rows  → list each with the qty_on_hand
                        captured at submit time. Bold "stock available" badge
                        when any matched item had qty > 0 — that's the case
                        admins most want to flag. */}
                <div className="border border-border rounded-md p-3 bg-muted/30">
                  <div className="flex items-center justify-between mb-1.5">
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
                        <Package className="w-3.5 h-3.5" /> Match:{" "}
                        <span className="font-mono">{inventoryMatch.sku}</span> ·{" "}
                        {inventoryMatch.qtyOnHand} on hand
                        {inventoryMatch.qtyOnHand > 0 && (
                          <span className="text-success text-xs ml-auto">Use from stock</span>
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        Mechanic did not run an inventory check.
                      </div>
                    )
                  ) : open.inventoryCheckResult.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                      Mechanic checked inventory — no matches found at submission.
                    </div>
                  ) : (
                    <div className="space-y-1.5">
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
                      {open.inventoryCheckResult.some((m) => m.qtyOnHand > 0) && (
                        <div className="text-xs text-warning pt-1 border-t border-border mt-2">
                          Stock available at submit — mechanic overrode warning.
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Post-approval reservation summary — appears once the PR is
                    approved (or beyond). inventoryDecrementQty is now
                    min(available, requested) rather than a flat 1, so a PR
                    for 4 against 2 free units shows "Reserved 2 of 4
                    requested" plus a shortfall callout — the correlation the
                    client asked for ("stock says 2 but I need 4"). When
                    inventoryDecrementQty is 0 (no stock at approval) we tell
                    the admin a supplier order is still needed. Hidden for
                    pending/rejected — nothing to show. */}
                {(open.status === "approved" || open.status === "ordered") && (
                  <div className="border border-border rounded-md p-3 bg-success/5">
                    <div className="text-[10px] uppercase tracking-wider font-mono text-success mb-1.5">
                      Approval result
                    </div>
                    {open.inventoryDecrementQty && open.inventoryDecrementQty > 0 && inventoryMatch ? (
                      <>
                        <div className="text-sm flex items-center gap-2">
                          <Package className="w-3.5 h-3.5 shrink-0 text-success" />
                          <span>
                            Reserved <b>{open.inventoryDecrementQty}</b> of{" "}
                            <b>{open.quantity}</b> requested ({inventoryMatch.qtyOnHand} on hand
                            at <span className="font-mono">{inventoryMatch.sku}</span>)
                          </span>
                        </div>
                        {open.inventoryDecrementQty < open.quantity && (
                          <div className="text-xs text-warning mt-1.5 pl-5">
                            Short by {open.quantity - open.inventoryDecrementQty} — supplier
                            order still needed for the remainder.
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        No stock matched — supplier order required.
                      </div>
                    )}
                    {open.status === "ordered" && (
                      <div className="mt-2 pt-2 border-t border-border text-xs space-y-0.5 font-mono">
                        <div>
                          <span className="text-muted-foreground">Supplier ref: </span>
                          {open.supplierOrderRef ?? "—"}
                        </div>
                        {open.orderedAt && (
                          <div>
                            <span className="text-muted-foreground">Ordered: </span>
                            {open.orderedAt.slice(0, 16).replace("T", " ")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Action buttons are always rendered so the admin can flip a
                    PR through any state from the same sheet — handlers gate
                    invalid transitions and emit a toast on failure rather
                    than hiding the affordance entirely. */}
                <div className="space-y-2 pt-2">
                  <Button
                    className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                    data-testid="sheet-approve-pr"
                    onClick={() => approve(open.id)}
                  >
                    Approve &amp; reserve
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full border-danger text-danger hover:bg-danger/10"
                    data-testid="sheet-reject-pr"
                    onClick={() => reject(open.id)}
                  >
                    Reject
                  </Button>
                </div>

                {/* Mark-ordered affordance: inline confirm form with a
                    supplier-ref input + Submit button. Always rendered so the
                    sheet exposes the full PR lifecycle from one place; the
                    submit handler validates the ref string and the PR status
                    server-side so misuse just surfaces an error toast. */}
                <div className="space-y-2 pt-2 border-t border-border">
                  <label className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground block">
                    Supplier order reference
                  </label>
                  <Input
                    value={orderRef}
                    onChange={(e) => setOrderRef(e.target.value)}
                    placeholder="e.g. PO-99821 or supplier confirmation #"
                    data-testid="sheet-order-ref-input"
                  />
                  <Button
                    className="w-full gap-2"
                    disabled={orderSubmitting}
                    data-testid="sheet-mark-ordered-submit"
                    onClick={() => markOrdered(open.id)}
                  >
                    <Truck className="w-4 h-4" />
                    Mark ordered
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <NewRequestDialog open={creating} onOpenChange={setCreating} mechanics={mechanics} />
    </AdminShell>
  );
}

// Admin-side purchase request creation. Client feedback (Admin Login):
// "Purchase Orders: Cannot see any way to create a Purchase Order" — admins
// could only review/approve, never file one directly. purchase_requests.
// mechanic_id is a hard FK to `mechanics` (not any profile), so an admin
// files this on behalf of a specific mechanic/workshop rather than under
// their own id — mirrors NewRequestSheet in mechanic.purchase-requests.tsx.
function NewRequestDialog({
  open,
  onOpenChange,
  mechanics,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mechanics: { id: string; name: string }[];
}) {
  const { inventoryItems } = useData();
  const [mechanicId, setMechanicId] = useState(mechanics[0]?.id ?? "");
  const [urgency, setUrgency] = useState<"low" | "medium" | "high">("medium");
  const [checkInv, setCheckInv] = useState(true);
  const [item, setItem] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [cost, setCost] = useState("");
  const [loading, setLoading] = useState(false);
  const [overrodeStock, setOverrodeStock] = useState(false);

  const matches: InventoryItem[] = useMemo(() => {
    if (!checkInv) return [];
    const q = item.trim().toLowerCase();
    if (q.length < 2) return [];
    return inventoryItems.filter(
      (i) => !i.archived && (i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)),
    );
  }, [checkInv, item, inventoryItems]);

  const qtyNumLive = Math.max(1, Math.floor(Number(quantity) || 1));
  const coveringMatch = matches.find((m) => m.qtyOnHand - m.qtyReserved >= qtyNumLive);
  const hasStock = coveringMatch !== undefined;

  function reset() {
    setItem("");
    setQuantity("1");
    setReason("");
    setCost("");
    setOverrodeStock(false);
    setMechanicId(mechanics[0]?.id ?? "");
  }

  function handleItemChange(next: string) {
    setItem(next);
    if (overrodeStock) setOverrodeStock(false);
  }
  function handleQuantityChange(next: string) {
    setQuantity(next);
    if (overrodeStock) setOverrodeStock(false);
  }

  async function submit() {
    if (!mechanicId) {
      toast.error("Add a mechanic first — a request needs a workshop owner");
      return;
    }
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
        mechanicId,
        item,
        quantity: qtyNum,
        reason,
        estimatedCost: costNum,
        urgency,
        inventoryCheckedAt: checkInv ? new Date().toISOString() : null,
        inventoryCheckResult,
        approvedBy: null,
        supplierId: null,
        inventoryDecrementQty: null,
        orderedAt: null,
        orderedBy: null,
        supplierOrderRef: null,
      });
      toast.success("Purchase request created");
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Create failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>New purchase request</SheetTitle>
        </SheetHeader>
        <div className="space-y-3 mt-6">
          <div>
            <Label>Requesting mechanic</Label>
            {mechanics.length === 0 ? (
              <div className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-3 mt-1.5">
                No mechanics available — add one first.
              </div>
            ) : (
              <Select value={mechanicId} onValueChange={setMechanicId}>
                <SelectTrigger className="mt-1.5">
                  <SelectValue placeholder="Choose mechanic" />
                </SelectTrigger>
                <SelectContent>
                  {mechanics.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div>
            <Label>Item needed</Label>
            <Input
              value={item}
              onChange={(e) => handleItemChange(e.target.value)}
              placeholder="e.g. Brake pad set"
              className="mt-1.5"
              data-testid="new-pr-item"
            />
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
              data-testid="new-pr-quantity"
            />
          </div>
          <div>
            <Label>Reason / job reference</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="mt-1.5"
              data-testid="new-pr-reason"
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
              data-testid="new-pr-cost"
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
                    still need a fresh order.
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
            onClick={submit}
            disabled={loading || mechanics.length === 0 || (checkInv && hasStock && !overrodeStock)}
            className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold h-11"
            data-testid="submit-new-purchase-request"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Creating…
              </>
            ) : (
              "Create purchase request"
            )}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
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
