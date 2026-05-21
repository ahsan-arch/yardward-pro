import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { driverById } from "@/data/mockData";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Flag, MapPin } from "lucide-react";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/admin/timesheets")({
  head: () => ({ meta: [{ title: "Timesheets — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { timeEntries } = useData();
  const [tab, setTab] = useState<"all" | "flagged" | "active">("all");

  const rows = useMemo(
    () =>
      timeEntries
        .filter((t) => (tab === "all" ? true : tab === "flagged" ? t.flagged : !t.clockOut))
        .sort((a, b) => b.clockIn.localeCompare(a.clockIn)),
    [timeEntries, tab],
  );

  return (
    <AdminShell title="Timesheets">
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-4">
        <TabsList>
          <TabsTrigger value="all">All ({timeEntries.length})</TabsTrigger>
          <TabsTrigger value="active">
            Active ({timeEntries.filter((t) => !t.clockOut).length})
          </TabsTrigger>
          <TabsTrigger value="flagged">
            Flagged ({timeEntries.filter((t) => t.flagged).length})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {[
                "Entry",
                "Driver",
                "Clock in",
                "Clock out",
                "Hours",
                "GPS correlation",
                "Status",
              ].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const hours = t.clockOut
                ? (
                    (new Date(t.clockOut).getTime() - new Date(t.clockIn).getTime()) /
                    3600_000
                  ).toFixed(2)
                : "—";
              const corr = t.vehicleMovementCorrelation;
              return (
                <tr
                  key={t.id}
                  className={`border-t border-border ${t.flagged ? "bg-danger/5" : ""}`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{t.id}</td>
                  <td className="px-4 py-3">{driverById(t.driverId)?.name ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {new Date(t.clockIn).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {t.clockOut ? (
                      new Date(t.clockOut).toLocaleString()
                    ) : (
                      <span className="text-amber-brand">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono">{hours}</td>
                  <td className="px-4 py-3">
                    {corr === "matches" && (
                      <span className="inline-flex items-center gap-1 text-success text-xs">
                        <MapPin className="w-3 h-3" /> Matches
                      </span>
                    )}
                    {corr === "mismatch" && (
                      <span className="inline-flex items-center gap-1 text-danger text-xs">
                        <Flag className="w-3 h-3" /> Mismatch
                      </span>
                    )}
                    {corr === "pending" && (
                      <span className="text-xs text-muted-foreground">Pending</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {t.flagged ? (
                      <span title={t.flagReason}>
                        <StatusBadge status="Flagged" />
                      </span>
                    ) : (
                      <StatusBadge status="OK" />
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No timesheets in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
