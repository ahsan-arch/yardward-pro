import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { Play, Loader2, AlertCircle, Package, AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { InventoryCheckSnapshot, InventoryItem } from "@/types/domain";

export const Route = createFileRoute("/mechanic/")({
  head: () => ({ meta: [{ title: "Mechanic — Yardward Pro" }] }),
  component: Page,
});

const urgencies: ("low" | "medium" | "high")[] = ["low", "medium", "high"];

function Page() {
  const { purchaseRequests, inventoryItems, maintenanceWorkOrders, vehicles, drivers } = useData();
  const { user } = useAuth();

  // Live work orders assigned to this mechanic, with vehicle + driver context
  // resolved against the live Supabase arrays (no mock seed).
  const myActiveMwos = useMemo(() => {
    return maintenanceWorkOrders
      .filter(
        (w) =>
          w.assignedMechanicId === user.id && (w.status === "in_progress" || w.status === "queued"),
      )
      .slice(0, 6)
      .map((w) => {
        const v = vehicles.find((x) => x.id === w.vehicleId);
        const reporter = drivers.find((x) => x.id === w.reportedBy);
        return {
          id: w.id,
          vehicle: v?.id ?? w.vehicleId,
          vehicleName: v?.name ?? "",
          issue: w.issueDescription,
          priority: w.priority,
          reportedBy: reporter?.name ?? "—",
        };
      });
  }, [maintenanceWorkOrders, user.id, vehicles, drivers]);

  const myPendingPos = useMemo(
    () => purchaseRequests.filter((p) => p.mechanicId === user.id && p.status === "pending").length,
    [purchaseRequests, user.id],
  );
  const [urgency, setUrgency] = useState<"low" | "medium" | "high">("medium");
  const [checkInv, setCheckInv] = useState(true);
  const [item, setItem] = useState("");
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
    return inventoryItems.filter(
      (i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q),
    );
  }, [checkInv, item, inventoryItems]);

  // qty_on_hand > 0 on any match is the "wait, we already have stock" signal.
  // We surface a confirm-style warning inside the form so the mechanic has to
  // actively override before we'll send the PR up the chain.
  const hasStock = matches.some((m) => m.qtyOnHand > 0);

  // Reset the override the moment the typed item changes — otherwise a
  // mechanic could override stock for "brake pads", then re-type a different
  // part and skip the warning entirely.
  function handleItemChange(next: string) {
    setItem(next);
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
      setItem("");
      setReason("");
      setCost("");
      setOverrodeStock(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Submit failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <MechanicShell title="Workshop dashboard">
      <div className="mb-6">
        <h2 className="text-lg font-semibold">
          Welcome back, {user.name.split(" ")[0] || "Mechanic"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {myActiveMwos.length} active work order{myActiveMwos.length === 1 ? "" : "s"}
          {" · "}
          {myPendingPos} PO{myPendingPos === 1 ? "" : "s"} pending approval
        </p>
      </div>

      <section className="mb-8">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Active work orders assigned
        </h3>
        {myActiveMwos.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            No active work orders. Check the queue at /mechanic/work-orders to claim a new one.
          </p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {myActiveMwos.map((w) => (
              <div
                key={w.id}
                className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-mono text-sm font-bold text-navy bg-navy/10 dark:bg-navy/40 dark:text-amber-brand px-2 py-1 rounded">
                    {w.vehicle}
                  </div>
                  <StatusBadge status={w.priority} />
                </div>
                <p className="text-sm mt-3">{w.issue}</p>
                <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
                  <span className="text-xs text-muted-foreground">
                    Reported by <span className="font-medium text-foreground">{w.reportedBy}</span>
                  </span>
                  <Button
                    size="sm"
                    className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                  >
                    <Play className="w-3 h-3" /> Start work
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-lg p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <h3 className="font-semibold mb-4">New purchase request</h3>
          <form onSubmit={submit} className="space-y-3">
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
        </div>

        <div className="bg-card border border-border rounded-lg p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <h3 className="font-semibold mb-1">PO approval status</h3>
          <p className="text-xs text-muted-foreground mb-4">Recent requests</p>
          <div className="space-y-2">
            {purchaseRequests.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 p-3 rounded-md border border-border bg-muted/20"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{p.item}</div>
                  <div className="text-xs font-mono text-muted-foreground">
                    ${p.estimatedCost} · {new Date(p.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <StatusBadge status={p.status} />
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded">
            <AlertCircle className="w-3.5 h-3.5" /> Approved POs are auto-ordered from preferred
            suppliers.
          </div>
        </div>
      </section>
    </MechanicShell>
  );
}
