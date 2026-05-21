import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Check, X, Package, ShoppingCart } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/purchase-requests")({
  head: () => ({ meta: [{ title: "Purchase requests — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { purchaseRequests, inventoryItems, mechanics } = useData();
  const { user } = useAuth();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected" | "ordered" | "all">(
    "pending",
  );
  const [openId, setOpenId] = useState<string | null>(null);

  const filtered = useMemo(
    () => purchaseRequests.filter((p) => (tab === "all" ? true : p.status === tab)),
    [purchaseRequests, tab],
  );
  const open = openId ? purchaseRequests.find((p) => p.id === openId) : null;
  const inventoryMatch = open
    ? inventoryItems.find((i) =>
        i.name.toLowerCase().includes(open.item.toLowerCase().split(" —")[0]),
      )
    : null;

  async function approve(id: string) {
    await api.approvePurchaseRequest(id, user.id);
    toast.success(`${id} approved`);
  }
  async function reject(id: string) {
    toast.error(`${id} rejected (mock)`);
  }

  return (
    <AdminShell title="Purchase requests">
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="pending">
            Pending ({purchaseRequests.filter((p) => p.status === "pending").length})
          </TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
          <TabsTrigger value="ordered">Ordered</TabsTrigger>
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
                    <StatusBadge status={p.status.charAt(0).toUpperCase() + p.status.slice(1)} />
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {p.status === "pending" ? (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-success text-success hover:bg-success/10"
                          onClick={() => approve(p.id)}
                        >
                          <Check className="w-3 h-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 border-danger text-danger hover:bg-danger/10"
                          onClick={() => reject(p.id)}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
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

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <ShoppingCart className="w-4 h-4" />
                  <span className="font-mono">{open.id}</span>
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
                <div className="border border-border rounded-md p-3 bg-muted/30">
                  <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
                    Inventory check
                  </div>
                  {inventoryMatch ? (
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
                      No matching SKU — supplier order needed.
                    </div>
                  )}
                </div>
                {open.status === "pending" && (
                  <div className="space-y-2 pt-2">
                    <Button
                      className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                      onClick={() => approve(open.id)}
                    >
                      Approve &amp; order
                    </Button>
                    <Button
                      variant="outline"
                      className="w-full border-danger text-danger hover:bg-danger/10"
                      onClick={() => reject(open.id)}
                    >
                      Reject
                    </Button>
                  </div>
                )}
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
