import { createFileRoute, Link } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Plus, ShoppingCart, Package } from "lucide-react";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/mechanic/purchase-requests")({
  head: () => ({ meta: [{ title: "Purchase requests — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { purchaseRequests, inventoryItems } = useData();
  const { user } = useAuth();
  const [tab, setTab] = useState<"mine" | "all">("mine");
  const [openId, setOpenId] = useState<string | null>(null);

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
        <Link
          to="/mechanic"
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-amber-brand text-amber-brand-foreground text-sm font-semibold hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> New request
        </Link>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["PR #", "Item", "Cost", "Urgency", "Created", "Status"].map((h) => (
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
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
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
