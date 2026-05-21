import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { useData } from "@/contexts/DataContext";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Wrench, Play, CheckCircle2, Package } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/mechanic/work-orders")({
  head: () => ({ meta: [{ title: "Workshop work orders — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { vehicles } = useData();
  const workOrders = vehicles
    .filter((v) => v.status === "maintenance")
    .map((v) => ({
      id: `MWO-${v.id}`,
      vehicleId: v.id,
      vehicleName: v.name,
      issue: v.id === "TRK-14" ? "Brake pad wear on rear axle" : "Hydraulic seep at boom cylinder",
      priority: v.id === "TRK-14" ? "High" : "Medium",
      reportedBy: "Tom Morrison",
      status: "in-progress",
      partsNeeded:
        v.id === "TRK-14" ? ["Brake pads — HD set", "Brake fluid 1L"] : ["Hydraulic seal kit"],
    }));
  const [openId, setOpenId] = useState<string | null>(null);
  const open = workOrders.find((w) => w.id === openId);

  return (
    <MechanicShell title="Work orders assigned to me">
      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["MWO #", "Vehicle", "Issue", "Priority", "Reported by", "Status"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {workOrders.map((w) => (
              <tr
                key={w.id}
                className="border-t border-border hover:bg-muted/30 cursor-pointer"
                onClick={() => setOpenId(w.id)}
              >
                <td className="px-4 py-3 font-mono text-xs font-medium text-amber-brand">{w.id}</td>
                <td className="px-4 py-3">
                  <span className="font-mono text-xs">{w.vehicleId}</span> — {w.vehicleName}
                </td>
                <td className="px-4 py-3">{w.issue}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={w.priority} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">{w.reportedBy}</td>
                <td className="px-4 py-3">
                  <StatusBadge status="Pending" />
                </td>
              </tr>
            ))}
            {workOrders.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No work orders in the workshop queue.
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
                  <Wrench className="w-4 h-4" />
                  <span className="font-mono">{open.id}</span>
                </SheetTitle>
              </SheetHeader>
              <div className="space-y-5 mt-6">
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                    Vehicle
                  </div>
                  <div className="font-medium mt-0.5">
                    {open.vehicleId} — {open.vehicleName}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                    Issue
                  </div>
                  <p className="text-sm mt-1">{open.issue}</p>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
                    Parts needed
                  </div>
                  <ul className="space-y-1">
                    {open.partsNeeded.map((p) => (
                      <li
                        key={p}
                        className="text-sm flex items-center gap-2 bg-muted/30 rounded px-2 py-1.5"
                      >
                        <Package className="w-3.5 h-3.5 text-muted-foreground" /> {p}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-2 pt-2">
                  <Button
                    onClick={() => toast.success("Work started")}
                    className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                  >
                    <Play className="w-4 h-4" /> Start work
                  </Button>
                  <Button
                    onClick={() => toast.success("Work completed")}
                    variant="outline"
                    className="w-full border-success text-success hover:bg-success/10"
                  >
                    <CheckCircle2 className="w-4 h-4" /> Mark complete
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </MechanicShell>
  );
}
