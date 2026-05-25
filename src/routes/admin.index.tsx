import { createFileRoute, Link } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { activityFeed, jobDisplay } from "@/data/mockData";
import { useData } from "@/contexts/DataContext";
import { Briefcase, Users, ClipboardCheck, AlertTriangle, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { VehicleMap } from "@/components/crm/VehicleMap";

export const Route = createFileRoute("/admin/")({
  head: () => ({ meta: [{ title: "Dashboard — FleetOps CRM" }] }),
  component: Dashboard,
});

const stats = [
  { label: "Active Jobs Today", value: "8", icon: Briefcase, badge: "Live", tone: "success" },
  { label: "Drivers On Site", value: "6 / 9", icon: Users, badge: "67%", tone: "muted" },
  {
    label: "Pending Work Orders",
    value: "3",
    icon: ClipboardCheck,
    badge: "Needs review",
    tone: "warning",
  },
  {
    label: "Flagged Submissions",
    value: "1",
    icon: AlertTriangle,
    badge: "Urgent",
    tone: "danger",
  },
];

const toneClass: Record<string, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-amber-brand/15 text-amber-brand",
  danger: "bg-danger/15 text-danger",
  muted: "bg-muted text-muted-foreground",
};

function Dashboard() {
  const { jobs, vehicles } = useData();
  const todays = jobs
    .map(jobDisplay)
    .filter((j) => j.day === 1)
    .slice(0, 6);
  const dotColor: Record<string, string> = {
    positive: "bg-success",
    pending: "bg-amber-brand",
    flag: "bg-danger",
  };

  return (
    <AdminShell title="Dashboard">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          >
            <div className="flex items-start justify-between">
              <s.icon className="w-5 h-5 text-muted-foreground" />
              <span
                className={cn(
                  "text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded",
                  toneClass[s.tone],
                )}
              >
                {s.badge}
              </span>
            </div>
            <div className="mt-3 text-3xl font-bold font-mono">{s.value}</div>
            <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Live fleet map preview */}
      <div className="mt-6 bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div>
            <h2 className="font-semibold">Live fleet map</h2>
            <p className="text-xs text-muted-foreground font-mono">Geotab · auto-refreshes</p>
          </div>
          <Link
            to="/admin/map"
            className="text-xs text-amber-brand hover:underline flex items-center gap-1"
          >
            Open full map <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        <VehicleMap
          vehicles={vehicles}
          height="280px"
          autoRefreshMs={60_000}
          interactive
          showSidebar={false}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Schedule table */}
        <div className="xl:col-span-2 bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div>
              <h2 className="font-semibold">Today's Schedule</h2>
              <p className="text-xs text-muted-foreground font-mono">Wed · 14 May 2025</p>
            </div>
            <Link
              to="/admin/schedule"
              className="text-xs text-amber-brand hover:underline flex items-center gap-1"
            >
              View all <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Job ID</th>
                  <th className="text-left font-medium px-4 py-2.5">Client</th>
                  <th className="text-left font-medium px-4 py-2.5 hidden md:table-cell">
                    Location
                  </th>
                  <th className="text-left font-medium px-4 py-2.5">Driver</th>
                  <th className="text-left font-medium px-4 py-2.5 hidden lg:table-cell">Truck</th>
                  <th className="text-left font-medium px-4 py-2.5">Status</th>
                  <th className="text-left font-medium px-4 py-2.5 hidden sm:table-cell">Time</th>
                </tr>
              </thead>
              <tbody>
                {todays.map((j) => (
                  <tr key={j.id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-4 py-3 font-mono text-xs font-medium">{j.id}</td>
                    <td className="px-4 py-3">{j.client}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-muted-foreground">
                      {j.location}
                    </td>
                    <td className="px-4 py-3">{j.driver}</td>
                    <td className="px-4 py-3 hidden lg:table-cell font-mono text-xs">{j.truck}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell font-mono">{j.time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Activity feed */}
        <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4">
          <h2 className="font-semibold mb-4">Recent Activity</h2>
          <div className="relative pl-5">
            <div className="absolute left-1.5 top-1 bottom-1 w-px bg-border" />
            {activityFeed.map((e, i) => (
              <div key={i} className="relative pb-4 last:pb-0">
                <div
                  className={cn(
                    "absolute -left-[14px] top-1 w-2.5 h-2.5 rounded-full ring-2 ring-card",
                    dotColor[e.type],
                  )}
                />
                <div className="text-xs font-mono text-muted-foreground">{e.time}</div>
                <div className="text-sm mt-0.5">{e.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
