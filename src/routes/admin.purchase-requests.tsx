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
import { Check, X, Package, ShoppingCart, Truck } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { InventoryItem, PurchaseRequest } from "@/types/domain";

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
  const [tab, setTab] = useState<"pending" | "approved" | "rejected" | "ordered" | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  // Inline "mark ordered" form: stores the supplier order ref the admin types
  // in. Keyed by PR id so the form is local to the row that's currently being
  // ordered (which is always the one in the open sheet).
  const [orderRef, setOrderRef] = useState("");
  const [orderSubmitting, setOrderSubmitting] = useState(false);

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
      if (!res.ok) {
        // Lost the race — another admin already handled this PR. Don't toast a
        // false "approved"; tell the user the real current status.
        toast.info(`${id} was already ${res.currentStatus} by someone else`);
        return;
      }
      if (res.reservedInventory) {
        toast.success(`${id} approved · reserved 1 from stock`);
      } else {
        toast.success(`${id} approved · no stock match, place supplier order`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to approve ${id}`);
    }
  }
  async function reject(id: string) {
    try {
      const res = await api.rejectPurchaseRequest(id, user.id);
      if (!res.ok) {
        // Lost the race — another admin already handled it.
        toast.info(`${id} was already ${res.currentStatus} by someone else`);
        return;
      }
      toast.success(`${id} rejected`);
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
              {["PR #", "Mechanic", "Item", "Cost", "Urgency", "Created", "Status", "Actions"].map(
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
                <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
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
                        <div key={m.inventoryItemId} className="flex items-center gap-2 text-sm">
                          <Package className="w-3.5 h-3.5 shrink-0" />
                          <span className="flex-1 truncate">{m.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">{m.sku}</span>
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
                    approved (or beyond). When inventoryDecrementQty > 0 the
                    approval reserved 1 unit against the matched item; render
                    "Reserved X of N on hand at <sku>". When 0 (no stock at
                    approval) we tell the admin a supplier order is still
                    needed. Hidden for pending/rejected — nothing to show. */}
                {(open.status === "approved" || open.status === "ordered") && (
                  <div className="border border-border rounded-md p-3 bg-success/5">
                    <div className="text-[10px] uppercase tracking-wider font-mono text-success mb-1.5">
                      Approval result
                    </div>
                    {open.inventoryDecrementQty &&
                    open.inventoryDecrementQty > 0 &&
                    inventoryMatch ? (
                      <div className="text-sm flex items-center gap-2">
                        <Package className="w-3.5 h-3.5 shrink-0 text-success" />
                        <span>
                          Reserved <b>{open.inventoryDecrementQty}</b> of{" "}
                          <b>{inventoryMatch.qtyOnHand}</b> on hand at{" "}
                          <span className="font-mono">{inventoryMatch.sku}</span>
                        </span>
                      </div>
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
    </AdminShell>
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
