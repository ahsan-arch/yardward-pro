import { createFileRoute, Link } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { ArrowLeft, Sun, Wrench, ClipboardList, Truck, Moon, ChevronRight } from "lucide-react";

export const Route = createFileRoute("/driver/forms")({
  head: () => ({ meta: [{ title: "Forms — FleetOps" }] }),
  component: Page,
});

const tiles = [
  {
    to: "/driver/start-of-day",
    label: "Start of day",
    desc: "Odometer, fuel, vehicle condition",
    icon: Sun,
  },
  {
    to: "/driver/tool-checklist",
    label: "Tool checklist",
    desc: "Verify all required tools",
    icon: Wrench,
  },
  {
    to: "/driver/job-log",
    label: "Job log",
    desc: "Log details for current job",
    icon: ClipboardList,
  },
  {
    to: "/driver/work-order",
    label: "Dump / load",
    desc: "Submit work order on site",
    icon: Truck,
  },
  {
    to: "/driver/end-of-day",
    label: "End of day",
    desc: "Final odometer, summary, sign-off",
    icon: Moon,
  },
];

function Page() {
  const { toolChecklistSubmissions, workOrders, timeEntries } = useData();
  const { user } = useAuth();
  const recent = [
    ...toolChecklistSubmissions
      .filter((s) => s.driverId === user.id)
      .map((s) => ({ id: s.id, type: "Tool checklist", at: s.submittedAt })),
    ...workOrders
      .filter((w) => w.driverId === user.id)
      .map((w) => ({ id: w.id, type: "Work order", at: w.submittedAt })),
    ...timeEntries
      .filter((t) => t.driverId === user.id)
      .map((t) => ({ id: t.id, type: t.clockOut ? "End of day" : "Start of day", at: t.clockIn })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 5);

  return (
    <DriverShell>
      <div className="p-4">
        <Link
          to="/driver"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <h1 className="text-xl font-bold">Forms</h1>
        <p className="text-sm text-muted-foreground mt-1">Daily forms and submissions.</p>

        <div className="grid grid-cols-1 gap-2.5 mt-4">
          {tiles.map((t) => (
            <Link
              key={t.to}
              to={t.to}
              className="flex items-center gap-3 bg-card border border-border rounded-xl p-4 hover:border-amber-brand transition-colors active:scale-[0.99]"
            >
              <div className="w-11 h-11 rounded-lg bg-amber-brand/10 text-amber-brand grid place-items-center">
                <t.icon className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <div className="font-semibold">{t.label}</div>
                <div className="text-xs text-muted-foreground">{t.desc}</div>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </Link>
          ))}
        </div>

        <div className="mt-6">
          <h2 className="text-sm font-semibold mb-2">Recent submissions</h2>
          {recent.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-3">
              No submissions yet today.
            </div>
          ) : (
            <div className="space-y-1.5">
              {recent.map((r) => (
                <div
                  key={`${r.type}-${r.id}`}
                  className="flex items-center justify-between text-sm bg-muted/30 rounded-md px-3 py-2"
                >
                  <span>{r.type}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {new Date(r.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DriverShell>
  );
}
