import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";

export const Route = createFileRoute("/mechanic/work-orders")({
  head: () => ({ meta: [{ title: "Work orders assigned to me — FleetOps CRM" }] }),
  component: () => (
    <MechanicShell title="Work orders assigned to me">
      <div className="bg-card border border-border rounded-lg p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <h2 className="font-semibold text-lg">Work orders assigned to me</h2>
        <p className="text-sm text-muted-foreground mt-2">This module is wired into the workshop navigation.</p>
      </div>
    </MechanicShell>
  ),
});
