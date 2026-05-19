import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { jobs } from "@/data/mockData";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowUpDown } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/admin/jobs")({
  head: () => ({ meta: [{ title: "Jobs — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const [sort, setSort] = useState<{ k: keyof typeof jobs[0]; dir: 1 | -1 }>({ k: "id", dir: 1 });
  const sorted = [...jobs].sort((a, b) => (a[sort.k] > b[sort.k] ? 1 : -1) * sort.dir);
  const toggle = (k: any) => setSort(s => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : 1 }));

  return (
    <AdminShell title="Jobs">
      <div className="flex gap-2 mb-4">
        <Input placeholder="Search jobs…" className="max-w-sm" />
        <Button className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 ml-auto">New job</Button>
      </div>
      <div className="bg-card border border-border rounded-lg overflow-x-auto shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>{(["id","client","location","driver","truck","status","time"] as const).map(c => (
              <th key={c} className="text-left font-medium px-4 py-3"><button onClick={() => toggle(c)} className="flex items-center gap-1 hover:text-foreground">{c} <ArrowUpDown className="w-3 h-3" /></button></th>
            ))}</tr>
          </thead>
          <tbody>
            {sorted.map(j => (
              <tr key={j.id} className="border-t border-border hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">{j.id}</td>
                <td className="px-4 py-3">{j.client}</td>
                <td className="px-4 py-3 text-muted-foreground">{j.location}</td>
                <td className="px-4 py-3">{j.driver}</td>
                <td className="px-4 py-3 font-mono text-xs">{j.truck}</td>
                <td className="px-4 py-3"><StatusBadge status={j.status} /></td>
                <td className="px-4 py-3 font-mono">{j.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
