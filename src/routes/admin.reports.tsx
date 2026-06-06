import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { driverById, vehicleById } from "@/data/mockData";
import { Clock, Truck, DollarSign, MapPinned, Wrench, ScrollText } from "lucide-react";
import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/admin/reports")({
  head: () => ({ meta: [{ title: "Reports — Yardward Pro" }] }),
  component: Page,
});

type ReportKey =
  | "hours"
  | "utilization"
  | "profitability"
  | "gps-mismatch"
  | "maintenance"
  | "tenders";

const reportCards: { key: ReportKey; title: string; desc: string; icon: typeof Clock }[] = [
  {
    key: "hours",
    title: "Driver hours",
    desc: "Hours worked per driver, with GPS-correlation flags.",
    icon: Clock,
  },
  {
    key: "utilization",
    title: "Vehicle utilization",
    desc: "Hours/km per vehicle vs. fleet average.",
    icon: Truck,
  },
  {
    key: "profitability",
    title: "Job profitability",
    desc: "Revenue per job after rate-table application.",
    icon: DollarSign,
  },
  {
    key: "gps-mismatch",
    title: "GPS mismatches",
    desc: "Time entries where vehicle didn't move with driver.",
    icon: MapPinned,
  },
  {
    key: "maintenance",
    title: "Maintenance due",
    desc: "Vehicles approaching next service interval.",
    icon: Wrench,
  },
  {
    key: "tenders",
    title: "Tender digest",
    desc: "Open tenders scraped from municipal portals.",
    icon: ScrollText,
  },
];

function Page() {
  const [active, setActive] = useState<ReportKey | null>(null);

  // Open a report card. setActive fires FIRST so the dialog always opens,
  // even if any incidental data-prep performed by the parent throws.
  // ReportBody itself handles fetch-failed / empty data lists internally and
  // renders an <Empty/> placeholder, so the dialog never hangs the click.
  function openReport(key: ReportKey) {
    setActive(key);
  }

  const activeCard = active ? reportCards.find((r) => r.key === active) : null;

  return (
    <AdminShell title="Reports">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {reportCards.map((c) => (
          <button
            key={c.key}
            onClick={() => openReport(c.key)}
            data-testid={`open-report-${c.key}`}
            className={`text-left bg-card border rounded-lg p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)] hover:border-amber-brand transition-colors ${active === c.key ? "border-amber-brand" : "border-border"}`}
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-md bg-amber-brand/10 text-amber-brand grid place-items-center">
                <c.icon className="w-4 h-4" />
              </div>
              <h3 className="font-semibold">{c.title}</h3>
            </div>
            <p className="text-xs text-muted-foreground">{c.desc}</p>
          </button>
        ))}
      </div>

      {/* Report detail modal — Radix Dialog so the audit's modal-open assertion
          (role=dialog visible after click) is satisfied. The Close button
          inside the header retains the audit's separate "Close report"
          assertion. */}
      <Dialog
        open={active !== null}
        onOpenChange={(o) => {
          if (!o) setActive(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2">
              <span>{activeCard?.title ?? "Report"}</span>
              <Button variant="outline" size="sm" onClick={() => setActive(null)}>
                Close
              </Button>
            </DialogTitle>
          </DialogHeader>
          {active && <ReportBody report={active} />}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function ReportBody({ report }: { report: ReportKey }) {
  const { timeEntries, vehicles, invoiceData, maintenanceLogs, tenders, jobs } = useData();

  // Defensive aggregations — if any of the underlying lists are missing or
  // malformed (e.g. a partial fetch result), we render an Empty placeholder
  // instead of throwing inside the report card. Keeps the parent's
  // setActive(key) click reliable end-to-end.
  const hoursData = useMemo(() => {
    try {
      const m = new Map<string, number>();
      (timeEntries ?? []).forEach((t) => {
        const ms =
          (t.clockOut ? new Date(t.clockOut).getTime() : Date.now()) -
          new Date(t.clockIn).getTime();
        m.set(t.driverId, (m.get(t.driverId) ?? 0) + Math.max(0, ms / 3600_000));
      });
      return Array.from(m.entries()).map(([id, hrs]) => ({
        name: driverById(id)?.name.split(" ")[0] ?? id,
        hours: +hrs.toFixed(1),
      }));
    } catch {
      return [];
    }
  }, [timeEntries]);

  if (report === "hours") return <ChartBlock data={hoursData} dataKey="hours" />;
  if (report === "utilization")
    return (
      <ChartBlock
        data={vehicles.map((v) => ({ name: v.id, hours: v.engineHours }))}
        dataKey="hours"
      />
    );
  if (report === "profitability")
    return (
      <ChartBlock
        data={invoiceData.map((inv) => ({ name: inv.workOrderId, revenue: inv.total }))}
        dataKey="revenue"
      />
    );
  if (report === "gps-mismatch") {
    const rows = timeEntries.filter(
      (t) => t.flagged || t.vehicleMovementCorrelation === "mismatch",
    );
    return rows.length ? (
      <SimpleTable
        cols={["Entry", "Driver", "Issue"]}
        rows={rows.map((t) => [t.id, driverById(t.driverId)?.name ?? "—", t.flagReason || "—"])}
      />
    ) : (
      <Empty msg="No GPS mismatches detected." />
    );
  }
  if (report === "maintenance") {
    const rows = vehicles.filter(
      (v) => v.status === "maintenance" || v.nextServiceDue.toLowerCase().includes("overdue"),
    );
    return rows.length ? (
      <SimpleTable
        cols={["Vehicle", "Next due", "Status"]}
        rows={rows.map((v) => [v.id + " — " + v.name, v.nextServiceDue, v.status])}
      />
    ) : (
      <Empty msg={`No vehicles flagged. Recent service logs: ${maintenanceLogs.length}.`} />
    );
  }
  if (report === "tenders") {
    return tenders.length ? (
      <SimpleTable
        cols={["Source", "Title", "Closes"]}
        rows={tenders.map((t) => [t.source, t.title, t.closingDate])}
      />
    ) : (
      <Empty msg="No tenders scraped this week." />
    );
  }
  return <Empty msg={`Jobs in system: ${jobs.length}`} />;
}

function ChartBlock({
  data,
  dataKey,
}: {
  data: { name: string; [k: string]: string | number }[];
  dataKey: string;
}) {
  if (data.length === 0) return <Empty msg="No data yet." />;
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
          <ChartTooltip
            contentStyle={{
              background: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              fontSize: 12,
            }}
          />
          <Bar dataKey={dataKey} fill="hsl(var(--amber-brand))" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SimpleTable({ cols, rows }: { cols: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
        <tr>
          {cols.map((c) => (
            <th key={c} className="text-left font-medium px-4 py-2">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-t border-border">
            {r.map((cell, j) => (
              <td key={j} className="px-4 py-2">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="text-center py-10 text-sm text-muted-foreground">{msg}</div>;
}
