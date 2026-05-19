import { createFileRoute, Link } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { Button } from "@/components/ui/button";
import { ClipboardList, Wrench, Notebook, Package, Play } from "lucide-react";

export const Route = createFileRoute("/driver/")({
  head: () => ({ meta: [{ title: "Driver — FleetOps" }] }),
  component: Home,
});

const tiles = [
  { label: "Start-of-day form", icon: ClipboardList, to: "/driver/start-of-day", bg: "bg-navy text-navy-foreground" },
  { label: "Tool checklist", icon: Wrench, to: "/driver/tool-checklist", bg: "bg-muted text-foreground" },
  { label: "Job log", icon: Notebook, to: "/driver/forms", bg: "bg-navy text-navy-foreground" },
  { label: "Dump / load form", icon: Package, to: "/driver/work-order", bg: "bg-muted text-foreground" },
];

function Home() {
  return (
    <DriverShell>
      <div className="p-4 space-y-4">
        <div className="bg-card border border-border rounded-xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Wed · 14 May · 06:48</div>
          <h1 className="text-2xl font-bold mt-1">Good morning, Tom</h1>
          <div className="mt-3 p-3 rounded-lg bg-muted/40 border border-border">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">Today's job</div>
            <div className="font-semibold mt-0.5">JOB-041 — Maple City Council</div>
            <div className="text-sm text-muted-foreground">14 River Rd</div>
            <div className="mt-2 flex gap-4 text-xs font-mono">
              <span><span className="text-muted-foreground">Start </span>07:00</span>
              <span><span className="text-muted-foreground">Truck </span>TRK-07</span>
            </div>
          </div>
          <Button className="w-full mt-4 h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold">
            <Play className="w-5 h-5 fill-current" /> Start shift
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {tiles.map(t => (
            <Link key={t.label} to={t.to} className={`${t.bg} border border-border rounded-xl p-4 aspect-square flex flex-col justify-between hover:scale-[0.98] transition-transform`}>
              <t.icon className="w-7 h-7" />
              <div className="text-sm font-semibold leading-tight">{t.label}</div>
            </Link>
          ))}
        </div>

        <Button variant="outline" className="w-full h-14 border-2 font-semibold">End of day</Button>
      </div>
    </DriverShell>
  );
}
