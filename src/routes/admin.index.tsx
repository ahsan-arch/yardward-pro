import { createFileRoute, Link } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { jobDisplay } from "@/data/mockData";
import { useData } from "@/contexts/DataContext";
import { Briefcase, Users, ClipboardCheck, AlertTriangle, ArrowUpRight, Ticket, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { VehicleMap } from "@/components/crm/VehicleMap";
import { useEffect, useMemo, useRef } from "react";
import type { TimeEntry, Notification } from "@/types/domain";

export const Route = createFileRoute("/admin/")({
  head: () => ({ meta: [{ title: "Dashboard — Yardward Pro" }] }),
  component: Dashboard,
});

type Stat = {
  label: string;
  value: string;
  icon: typeof Briefcase;
  badge: string;
  tone: string;
  href?: string;
};

const baseStats: Stat[] = [
  { label: "Active Jobs Today", value: "8", icon: Briefcase, badge: "Live", tone: "success" },
  { label: "Drivers On Site", value: "6 / 9", icon: Users, badge: "67%", tone: "muted" },
  {
    label: "Pending Work Orders",
    value: "3",
    icon: ClipboardCheck,
    badge: "Needs review",
    tone: "warning",
  },
];

const toneClass: Record<string, string> = {
  success: "bg-success/15 text-success",
  warning: "bg-amber-brand/15 text-amber-brand",
  danger: "bg-danger/15 text-danger",
  muted: "bg-muted text-muted-foreground",
};

// Sums hours per driver across all time entries whose clock-in falls within
// the current ISO week (Mon 00:00 -> next Mon 00:00). Active entries (no
// clock-out) count up to "now". Returns a sorted descending list.
function weeklyHoursByDriver(
  entries: TimeEntry[],
  now: Date = new Date(),
): { driverId: string; hours: number }[] {
  const day = now.getDay(); // 0=Sun..6=Sat
  // ISO week starts Monday — Sunday = 0 maps to -6, every other day to 1-day.
  const daysSinceMon = day === 0 ? 6 : day - 1;
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - daysSinceMon);
  const weekStartMs = weekStart.getTime();
  const weekEndMs = weekStartMs + 7 * 24 * 3600_000;

  const byDriver = new Map<string, number>();
  for (const t of entries) {
    const inMs = new Date(t.clockIn).getTime();
    if (inMs >= weekEndMs) continue;
    const outMs = t.clockOut ? new Date(t.clockOut).getTime() : now.getTime();
    if (outMs < weekStartMs) continue;
    // Clip to the current week so a multi-day entry only counts its in-week
    // portion (rare, but otherwise it skews OT calcs).
    const clippedIn = Math.max(inMs, weekStartMs);
    const clippedOut = Math.min(outMs, weekEndMs);
    const hrs = Math.max(0, (clippedOut - clippedIn) / 3600_000);
    byDriver.set(t.driverId, (byDriver.get(t.driverId) ?? 0) + hrs);
  }
  return Array.from(byDriver.entries())
    .map(([driverId, hours]) => ({ driverId, hours }))
    .sort((a, b) => b.hours - a.hours);
}

// LocalStorage key used to dedupe per-driver per-ISO-week overtime alerts so
// a page reload doesn't spam the notification feed.
const OT_ALERT_DEDUP_KEY = "fo:ot-alert-dedup:v1";

function isoWeekKey(d: Date = new Date()): string {
  const day = d.getDay();
  const daysSinceMon = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(d.getDate() - daysSinceMon);
  return monday.toISOString().slice(0, 10);
}

function readOtDedup(): Record<string, true> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(OT_ALERT_DEDUP_KEY);
    return raw ? (JSON.parse(raw) as Record<string, true>) : {};
  } catch {
    return {};
  }
}

function writeOtDedup(map: Record<string, true>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OT_ALERT_DEDUP_KEY, JSON.stringify(map));
  } catch {
    /* quota or disabled */
  }
}

function Dashboard() {
  const { jobs, vehicles, clients, timeEntries, appSettings, drivers, notifications, pushNotification } =
    useData();

  // Most-recent 10 notifications drive the activity feed. We sort defensively
  // (the realtime channel upserts in arbitrary order) and slice — no mock.
  const recentNotifs = useMemo(
    () =>
      [...notifications]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10),
    [notifications],
  );

  function notifTypeColor(type: string): string {
    if (type === "alert") return "bg-danger";
    if (type === "approval") return "bg-amber-brand";
    if (type === "job") return "bg-info";
    return "bg-success";
  }
  function relativeTimeLabel(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }
  // Track which driver/week pairs we've already alerted on across renders.
  // Ref keeps the value stable for the effect while still being writeable.
  const alertedRef = useRef<Record<string, true>>(readOtDedup());

  // Drafts shouldn't surface on the dashboard — they aren't published to drivers
  // and the today's-jobs tile is meant to mirror what's actually live.
  const todays = jobs
    .filter((j) => j.status !== "draft")
    .map(jobDisplay)
    .filter((j) => j.day === 1)
    .slice(0, 6);
  const lowTicketClients = clients
    .filter((c) => c.tickets.enabled && c.tickets.balance <= c.tickets.threshold)
    .sort((a, b) => a.tickets.balance - b.tickets.balance);

  // OT computation — memo so we don't recompute on unrelated state changes.
  const weekly = useMemo(() => weeklyHoursByDriver(timeEntries), [timeEntries]);
  const approachingOt = useMemo(
    () => weekly.filter((w) => w.hours >= appSettings.overtimeWarningHours),
    [weekly, appSettings.overtimeWarningHours],
  );
  const exceededOt = useMemo(
    () => weekly.filter((w) => w.hours >= appSettings.overtimeAlertHours),
    [weekly, appSettings.overtimeAlertHours],
  );
  const approachingDriverIds = approachingOt.map((w) => w.driverId).join(",");

  // Fire an admin notification per driver per ISO week — dedup'd via
  // localStorage so a refresh doesn't re-notify on every mount.
  useEffect(() => {
    if (!exceededOt.length) return;
    const weekKey = isoWeekKey();
    let mutated = false;
    for (const w of exceededOt) {
      const key = `${weekKey}:${w.driverId}`;
      if (alertedRef.current[key]) continue;
      alertedRef.current[key] = true;
      mutated = true;
      const driver = drivers.find((d) => d.id === w.driverId);
      const note: Notification = {
        id: `NOTIF-OT-${weekKey}-${w.driverId}`,
        userId: "admin",
        type: "alert",
        body: `${driver?.name ?? w.driverId} hit ${w.hours.toFixed(1)}h this week (alert ${appSettings.overtimeAlertHours}h).`,
        link: `/admin/timesheets?driverIds=${w.driverId}`,
        readAt: null,
        createdAt: new Date().toISOString(),
      };
      pushNotification(note);
    }
    if (mutated) writeOtDedup(alertedRef.current);
  }, [exceededOt, drivers, appSettings.overtimeAlertHours, pushNotification]);
  const dotColor: Record<string, string> = {
    positive: "bg-success",
    pending: "bg-amber-brand",
    flag: "bg-danger",
  };

  // Pick the right tone + label for the overtime card so it tells the admin
  // at a glance whether anyone has crossed the alert threshold (red) vs
  // warning threshold (amber) vs no concerns (muted).
  const otTone = exceededOt.length > 0 ? "danger" : approachingOt.length > 0 ? "warning" : "muted";
  const otBadge =
    exceededOt.length > 0
      ? `${exceededOt.length} over ${appSettings.overtimeAlertHours}h`
      : approachingOt.length > 0
        ? "Approaching"
        : "All clear";
  const otStat: Stat = {
    label: "Drivers approaching overtime",
    value: String(approachingOt.length),
    icon: Clock,
    badge: otBadge,
    tone: otTone,
    href:
      approachingOt.length > 0
        ? `/admin/timesheets?driverIds=${encodeURIComponent(approachingDriverIds)}`
        : "/admin/timesheets",
  };
  const stats: Stat[] = [
    ...baseStats,
    otStat,
    {
      label: "Flagged Submissions",
      value: "1",
      icon: AlertTriangle,
      badge: "Urgent",
      tone: "danger",
    },
  ];

  return (
    <AdminShell title="Dashboard">
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
        {stats.map((s) => {
          const inner = (
            <div className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)] h-full">
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
          );
          return s.href ? (
            <a
              key={s.label}
              href={s.href}
              className="block hover:opacity-95 transition-opacity"
              data-testid={`stat-${s.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {inner}
            </a>
          ) : (
            <div key={s.label}>{inner}</div>
          );
        })}
      </div>

      {/* Prepaid tickets low-balance widget */}
      {lowTicketClients.length > 0 && (
        <div className="mt-6 bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden">
          <div className="flex items-center justify-between p-4 border-b border-border">
            <div className="flex items-center gap-2">
              <Ticket className="w-4 h-4 text-amber-brand" />
              <h2 className="font-semibold">Prepaid ticket balances · attention</h2>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-amber-brand/15 text-amber-brand">
                {lowTicketClients.length}
              </span>
            </div>
            <Link
              to="/admin/prepaid-tickets"
              className="text-xs text-amber-brand hover:underline flex items-center gap-1"
            >
              Manage <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-border">
            {lowTicketClients.slice(0, 4).map((c) => (
              <Link
                key={c.id}
                to="/admin/prepaid-tickets"
                className="flex items-center justify-between px-4 py-3 hover:bg-muted/30"
              >
                <div>
                  <div className="font-medium text-sm">{c.name}</div>
                  <div className="text-[10px] font-mono text-muted-foreground">
                    threshold {c.tickets.threshold} · auto-bill {c.tickets.autoBillEnabled ? "on" : "off"}
                  </div>
                </div>
                <div
                  className={cn(
                    "font-mono font-bold",
                    c.tickets.balance < 0 ? "text-danger" : "text-amber-brand",
                  )}
                >
                  {c.tickets.balance}
                  <span className="text-[10px] font-normal text-muted-foreground ml-1">tickets</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

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

        {/* Activity feed — real notifications from the DB. Falls back to a
            graceful empty state when nothing has happened yet. */}
        <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4">
          <h2 className="font-semibold mb-4">Recent activity</h2>
          {recentNotifs.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">
              No activity yet. New form submissions, job updates, and approvals
              will appear here.
            </p>
          ) : (
            <div className="relative pl-5">
              <div className="absolute left-1.5 top-1 bottom-1 w-px bg-border" />
              {recentNotifs.map((n) => (
                <div key={n.id} className="relative pb-4 last:pb-0">
                  <div
                    className={cn(
                      "absolute -left-[14px] top-1 w-2.5 h-2.5 rounded-full ring-2 ring-card",
                      notifTypeColor(n.type),
                    )}
                  />
                  <div className="text-xs font-mono text-muted-foreground">
                    {relativeTimeLabel(n.createdAt)}
                  </div>
                  <div className="text-sm mt-0.5">{n.body}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  );
}
