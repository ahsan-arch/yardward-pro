import { createFileRoute, Link } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/driver/jobs")({
  head: () => ({ meta: [{ title: "My jobs — FleetOps" }] }),
  component: () => (
    <DriverShell>
      <div className="p-4">
        <Link to="/driver" className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"><ArrowLeft className="w-4 h-4" /> Back</Link>
        <h1 className="text-xl font-bold">My jobs</h1>
        <p className="text-sm text-muted-foreground mt-2">This screen is wired into the driver tabs.</p>
      </div>
    </DriverShell>
  ),
});
