import { createFileRoute, Link } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { Button } from "@/components/ui/button";
import { ClipboardList, Wrench, Notebook, Package, Play } from "lucide-react";
import { useMemo } from "react";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { clientById, vehicleById } from "@/data/mockData";

export const Route = createFileRoute("/driver/")({
  head: () => ({ meta: [{ title: "Driver — Yardward Pro" }] }),
  component: Home,
});

const tiles = [
  {
    label: "Start-of-day form",
    icon: ClipboardList,
    to: "/driver/start-of-day",
    bg: "bg-navy text-navy-foreground",
  },
  {
    label: "Tool checklist",
    icon: Wrench,
    to: "/driver/tool-checklist",
    bg: "bg-muted text-foreground",
  },
  { label: "Job log", icon: Notebook, to: "/driver/forms", bg: "bg-navy text-navy-foreground" },
  {
    label: "Dump / load form",
    icon: Package,
    to: "/driver/work-order",
    bg: "bg-muted text-foreground",
  },
];

function Home() {
  const { jobs } = useData();
  const { user } = useAuth();
  // Drafts are admin-private — they must never surface on a driver's home feed.
  // Pick the next non-draft job assigned to this driver (or the next non-draft
  // job overall in the seeded mock data, so the UX still demos cleanly).
  const todaysJob = useMemo(() => {
    const visible = jobs.filter((j) => j.status !== "draft");
    const mine = visible.filter((j) => j.driverId === user.id);
    const pool = mine.length ? mine : visible;
    return [...pool].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] ?? null;
  }, [jobs, user.id]);
  const todaysClient = todaysJob ? clientById(todaysJob.clientId) : null;
  const todaysVehicle = todaysJob ? vehicleById(todaysJob.vehicleId) : null;
  const todaysTime = todaysJob
    ? todaysJob.scheduledAt.slice(11, 16)
    : "--:--";

  return (
    <DriverShell>
      <div className="p-4 space-y-4">
        <div className="bg-card border border-border rounded-xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
            Wed · 14 May · 06:48
          </div>
          <h1 className="text-2xl font-bold mt-1">
            Good morning, {user.name.split(" ")[0] || "driver"}
          </h1>
          <div className="mt-3 p-3 rounded-lg bg-muted/40 border border-border">
            <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Today's job
            </div>
            {todaysJob ? (
              <>
                <div className="font-semibold mt-0.5">
                  {todaysJob.id} — {todaysClient?.name ?? "—"}
                </div>
                <div className="text-sm text-muted-foreground">
                  {todaysJob.location.address || "TBD"}
                </div>
                <div className="mt-2 flex gap-4 text-xs font-mono">
                  <span>
                    <span className="text-muted-foreground">Start </span>
                    {todaysTime}
                  </span>
                  <span>
                    <span className="text-muted-foreground">Truck </span>
                    {todaysVehicle?.id ?? "—"}
                  </span>
                </div>
              </>
            ) : (
              <div className="text-sm text-muted-foreground mt-0.5">
                No published jobs yet.
              </div>
            )}
          </div>
          <Button className="w-full mt-4 h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold">
            <Play className="w-5 h-5 fill-current" /> Start shift
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {tiles.map((t) => (
            <Link
              key={t.label}
              to={t.to}
              className={`${t.bg} border border-border rounded-xl p-4 aspect-square flex flex-col justify-between hover:scale-[0.98] transition-transform`}
            >
              <t.icon className="w-7 h-7" />
              <div className="text-sm font-semibold leading-tight">{t.label}</div>
            </Link>
          ))}
        </div>

        <Button variant="outline" className="w-full h-14 border-2 font-semibold">
          End of day
        </Button>
      </div>
    </DriverShell>
  );
}
