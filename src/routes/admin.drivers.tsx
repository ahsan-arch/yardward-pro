import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { drivers } from "@/data/mockData";
import { Phone, Award } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/drivers")({
  head: () => ({ meta: [{ title: "Drivers — FleetOps CRM" }] }),
  component: () => (
    <AdminShell title="Drivers">
      <div className="flex gap-2 mb-4">
        <Input placeholder="Search drivers…" className="max-w-sm" />
        <Button className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 ml-auto">Add driver</Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {drivers.map(d => (
          <div key={d.id} className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-navy text-navy-foreground grid place-items-center font-bold">{d.initials}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold">{d.name}</div>
                <div className="text-xs font-mono text-muted-foreground">{d.id}</div>
              </div>
              <span className="bg-success/15 text-success text-[10px] font-mono uppercase px-2 py-1 rounded">Active</span>
            </div>
            <div className="mt-4 pt-4 border-t border-border space-y-1.5 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground"><Phone className="w-3.5 h-3.5" /><span className="font-mono text-xs">{d.phone}</span></div>
              <div className="flex items-center gap-2 text-muted-foreground"><Award className="w-3.5 h-3.5" /><span className="text-xs">License: {d.license}</span></div>
            </div>
          </div>
        ))}
      </div>
    </AdminShell>
  ),
});
