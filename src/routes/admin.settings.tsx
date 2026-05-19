import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";

export const Route = createFileRoute("/admin/settings")({
  head: () => ({ meta: [{ title: "Settings — FleetOps CRM" }] }),
  component: () => (
    <AdminShell title="Settings">
      <div className="bg-card border border-border rounded-lg p-8 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <h2 className="font-semibold text-lg">Settings module</h2>
        <p className="text-sm text-muted-foreground mt-2">This module is wired into the navigation. Detailed views will appear here.</p>
      </div>
    </AdminShell>
  ),
});
