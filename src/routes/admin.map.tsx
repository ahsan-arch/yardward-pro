import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { VehicleMap } from "@/components/crm/VehicleMap";
import { useState } from "react";

export const Route = createFileRoute("/admin/map")({
  head: () => ({ meta: [{ title: "Live vehicle map — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { vehicles } = useData();
  const [focusVehicleId, setFocusVehicleId] = useState<string | null>(null);

  return (
    <AdminShell title="Live vehicle map">
      <div
        className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden"
        data-testid="admin-map-page"
      >
        <VehicleMap
          vehicles={vehicles}
          height="calc(100vh - 220px)"
          autoRefreshMs={30_000}
          interactive
          showSidebar
          showStatsBar
          focusVehicleId={focusVehicleId}
          onVehicleClick={(id) => setFocusVehicleId(id)}
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Pins refresh every 30 seconds from Geotab. Click a vehicle in the sidebar to zoom in, or
        click a pin for details.
      </p>
    </AdminShell>
  );
}
