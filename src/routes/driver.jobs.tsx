import { createFileRoute, Link } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { clientById, vehicleById } from "@/data/mockData";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { ArrowLeft, MapPin, Clock, Truck, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/driver/jobs")({
  head: () => ({ meta: [{ title: "My jobs — FleetOps" }] }),
  component: Page,
});

function Page() {
  const { jobs } = useData();
  const { user } = useAuth();
  const [tab, setTab] = useState<"today" | "upcoming" | "past">("today");

  const mine = useMemo(
    () =>
      jobs.filter(
        (j) =>
          // Drafts are admin-private — drivers must never see them, even when
          // they're the assigned driver. This is the hard guarantee Shayne asked for.
          j.status !== "draft" &&
          (j.driverId === user.id || user.id.startsWith("D-")),
      ),
    [jobs, user.id],
  );
  const today = new Date().toISOString().slice(0, 10);
  const grouped = useMemo(() => {
    const t = mine.filter((j) => j.scheduledAt.slice(0, 10) === today || j.status === "active");
    const u = mine.filter((j) => j.scheduledAt.slice(0, 10) > today && j.status !== "completed");
    const p = mine.filter(
      (j) =>
        j.status === "completed" || (j.scheduledAt.slice(0, 10) < today && j.status !== "active"),
    );
    return { today: t, upcoming: u, past: p };
  }, [mine, today]);

  return (
    <DriverShell>
      <div className="p-4">
        <Link
          to="/driver"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <h1 className="text-xl font-bold">My jobs</h1>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mt-4">
          <TabsList className="w-full">
            <TabsTrigger value="today" className="flex-1">
              Today ({grouped.today.length})
            </TabsTrigger>
            <TabsTrigger value="upcoming" className="flex-1">
              Upcoming ({grouped.upcoming.length})
            </TabsTrigger>
            <TabsTrigger value="past" className="flex-1">
              Past ({grouped.past.length})
            </TabsTrigger>
          </TabsList>
          {(["today", "upcoming", "past"] as const).map((k) => (
            <TabsContent key={k} value={k} className="mt-4 space-y-3">
              {grouped[k].length === 0 ? (
                <EmptyState label={k} />
              ) : (
                grouped[k].map((j) => <JobCard key={j.id} job={j} canStart={k === "today"} />)
              )}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </DriverShell>
  );
}

function JobCard({
  job,
  canStart,
}: {
  job: ReturnType<typeof useData>["jobs"][number];
  canStart: boolean;
}) {
  const c = clientById(job.clientId);
  const v = vehicleById(job.vehicleId);
  const dt = new Date(job.scheduledAt);
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(job.location.address)}`;
  const statusLabel = job.status.charAt(0).toUpperCase() + job.status.slice(1);
  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-xs text-amber-brand">{job.id}</div>
          <div className="font-semibold mt-0.5">{c?.name ?? "—"}</div>
        </div>
        <StatusBadge status={statusLabel} />
      </div>
      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="font-mono">
            {dt.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
          <span>{job.location.address}</span>
        </div>
        <div className="flex items-center gap-2">
          <Truck className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="font-mono text-xs">
            {v?.id ?? "—"} · {v?.name ?? ""}
          </span>
        </div>
      </div>
      {job.notes && (
        <p className="text-xs text-muted-foreground mt-3 border-t border-border/50 pt-2">
          {job.notes}
        </p>
      )}
      <div className="flex gap-2 mt-4">
        <a
          href={mapsHref}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 h-10 rounded-md border border-border text-sm font-medium grid place-items-center hover:bg-muted/50"
        >
          <span className="inline-flex items-center gap-1.5">
            <ExternalLink className="w-3.5 h-3.5" /> Open in Maps
          </span>
        </a>
        {canStart && (
          <Link
            to="/driver/work-order"
            className="flex-1 h-10 rounded-md bg-amber-brand text-amber-brand-foreground text-sm font-bold grid place-items-center hover:bg-amber-brand/90"
          >
            Start
          </Link>
        )}
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="text-center py-12 text-sm text-muted-foreground">No {label} jobs.</div>;
}
