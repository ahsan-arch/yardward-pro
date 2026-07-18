import { createFileRoute, Link } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { Play, AlertCircle, Package, ClipboardCheck, ShoppingCart, Wrench } from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/mechanic/")({
  head: () => ({ meta: [{ title: "Mechanic — Engage Hydrovac CRM" }] }),
  component: Page,
});

const toneClass: Record<string, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-amber-brand/15 text-amber-brand",
  danger: "bg-danger/15 text-danger",
  muted: "bg-muted text-muted-foreground",
};

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

  // Workshop-wide counts (not scoped to "me") so the landing page reads as an
  // actual overview dashboard rather than a single mechanic's to-do list —
  // client feedback flagged the old page as being "a New Purchase Request"
  // form first and a dashboard never. Read-only here; no permission change.
  const openWorkOrdersAll = useMemo(
    () => maintenanceWorkOrders.filter((w) => w.status === "in_progress" || w.status === "queued"),
    [maintenanceWorkOrders],
  );
  const lowStockItems = useMemo(
    () => inventoryItems.filter((i) => !i.archived && i.qtyOnHand <= i.reorderPoint).slice(0, 5),
    [inventoryItems],
  );
  const recentRequests = useMemo(() => purchaseRequests.slice(0, 5), [purchaseRequests]);

  const stats: { label: string; value: string; icon: typeof ClipboardCheck; badge: string; tone: string; href: string }[] = [
    {
      label: "My active work orders",
      value: String(myActiveMwos.length),
      icon: Wrench,
      badge: myActiveMwos.length > 0 ? "In progress" : "None",
      tone: myActiveMwos.length > 0 ? "warning" : "muted",
      href: "/mechanic/work-orders",
    },
    {
      label: "My POs pending approval",
      value: String(myPendingPos),
      icon: ShoppingCart,
      badge: myPendingPos > 0 ? "Awaiting" : "All clear",
      tone: myPendingPos > 0 ? "warning" : "muted",
      href: "/mechanic/purchase-requests",
    },
    {
      label: "Open work orders (workshop)",
      value: String(openWorkOrdersAll.length),
      icon: ClipboardCheck,
      badge: "All mechanics",
      tone: "muted",
      href: "/mechanic/work-orders",
    },
    {
      label: "Parts at/below reorder point",
      value: String(
        inventoryItems.filter((i) => !i.archived && i.qtyOnHand <= i.reorderPoint).length,
      ),
      icon: Package,
      badge: lowStockItems.length > 0 ? "Needs restock" : "All clear",
      tone: lowStockItems.length > 0 ? "danger" : "muted",
      href: "/mechanic/inventory",
    },
  ];

  return (
    <MechanicShell title="Workshop dashboard">
      <div className="mb-6">
        <h2 className="text-lg font-semibold">
          Welcome back, {user.name.split(" ")[0] || "Mechanic"}
        </h2>
        <p className="text-sm text-muted-foreground">Workshop overview · {new Date().toLocaleDateString("en-CA", { weekday: "long", day: "2-digit", month: "short" })}</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-8">
        {stats.map((s) => (
          <Link
            key={s.label}
            to={s.href}
            className="block hover:opacity-95 transition-opacity"
            data-testid={`stat-${s.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`}
          >
            <div className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] h-full">
              <div className="flex items-start justify-between">
                <s.icon className="w-5 h-5 text-muted-foreground" />
                <span
                  className={cn(
                    "text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded",
                    toneClass[s.tone],
                  )}
                >
                  {s.badge}
                </span>
              </div>
              <div className="mt-3 text-3xl font-bold font-mono">{s.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
            </div>
          </Link>
        ))}
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
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold">PO approval status</h3>
            <Link to="/mechanic/purchase-requests" className="text-xs text-amber-brand hover:underline">
              View all
            </Link>
          </div>
          <p className="text-xs text-muted-foreground mb-4">Recent requests, all mechanics</p>
          <div className="space-y-2">
            {recentRequests.map((p) => (
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
            {recentRequests.length === 0 && (
              <p className="text-sm text-muted-foreground italic">No purchase requests yet.</p>
            )}
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded">
            <AlertCircle className="w-3.5 h-3.5" /> Approved POs are auto-ordered from preferred
            suppliers.
          </div>
        </div>

        <div className="bg-card border border-border rounded-lg p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold">Parts needing restock</h3>
            <Link to="/mechanic/inventory" className="text-xs text-amber-brand hover:underline">
              View inventory
            </Link>
          </div>
          <p className="text-xs text-muted-foreground mb-4">At or below reorder point</p>
          <div className="space-y-2">
            {lowStockItems.map((i) => (
              <div
                key={i.id}
                className="flex items-center gap-2 p-3 rounded-md border border-danger/40 bg-danger/10"
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
            {lowStockItems.length === 0 && (
              <p className="text-sm text-muted-foreground italic">
                Nothing at or below its reorder point.
              </p>
            )}
          </div>
        </div>
      </section>
    </MechanicShell>
  );
}
