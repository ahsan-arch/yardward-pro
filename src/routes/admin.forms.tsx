import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Input } from "@/components/ui/input";
import { driverById, vehicleById, jobById, clientById } from "@/data/mockData";
import {
  MapPin,
  Flag,
  Search,
  AlertTriangle,
  ClipboardCheck,
  Wrench,
  ScrollText,
  Sun,
} from "lucide-react";
import { useMemo, useState } from "react";

export const Route = createFileRoute("/admin/forms")({
  head: () => ({ meta: [{ title: "Forms & Submissions — FleetOps CRM" }] }),
  component: Page,
});

type Tab = "all" | "tool" | "wo" | "time" | "ticket" | "inspection";

type Row = {
  id: string;
  type: "Tool checklist" | "Work order" | "Time entry" | "Ticket photo" | "Vehicle inspection";
  driver: string;
  context: string;
  submittedAt: string;
  gpsOk: boolean;
  flagged: boolean;
  status: string;
};

function Page() {
  const { toolChecklistSubmissions, workOrders, timeEntries, ticketPhotos, vehicleInspections } =
    useData();
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [openRow, setOpenRow] = useState<Row | null>(null);

  const rows: Row[] = useMemo(() => {
    const tcs = toolChecklistSubmissions.map<Row>((s) => ({
      id: s.id,
      type: "Tool checklist",
      driver: driverById(s.driverId)?.name ?? "—",
      context: vehicleById(s.vehicleId)?.id ?? s.vehicleId,
      submittedAt: s.submittedAt,
      gpsOk: !!(s.gpsLat && s.gpsLng),
      flagged: s.items.some((i) => i.status !== "ok"),
      status: s.items.some((i) => i.status !== "ok") ? "Flagged" : "Clean",
    }));
    const wos = workOrders.map<Row>((w) => ({
      id: w.id,
      type: "Work order",
      driver: driverById(w.driverId)?.name ?? "—",
      context: w.jobId,
      submittedAt: w.submittedAt,
      gpsOk: !!w.gpsCapture,
      flagged: w.siteIssues,
      status:
        w.status === "pending" ? "Pending" : w.status === "approved" ? "Approved" : "Rejected",
    }));
    const tes = timeEntries.map<Row>((t) => ({
      id: t.id,
      type: "Time entry",
      driver: driverById(t.driverId)?.name ?? "—",
      context: t.clockOut ? "Shift completed" : "Shift active",
      submittedAt: t.clockIn,
      gpsOk: !!t.gpsClockIn,
      flagged: t.flagged,
      status:
        t.vehicleMovementCorrelation === "mismatch"
          ? "Mismatch"
          : t.vehicleMovementCorrelation === "matches"
            ? "OK"
            : "Pending",
    }));
    const tps = ticketPhotos.map<Row>((p) => ({
      id: p.id,
      type: "Ticket photo",
      driver: driverById(p.driverId)?.name ?? "—",
      context: p.jobId,
      submittedAt: p.uploadedAt,
      gpsOk: !!p.location,
      flagged: p.status === "awaiting-entry",
      status: p.status === "entered" ? "Entered" : "Awaiting entry",
    }));
    const inspections = vehicleInspections.map<Row>((ins) => ({
      id: ins.id,
      type: "Vehicle inspection",
      driver: driverById(ins.driverId)?.name ?? "—",
      context: ins.vehicleId,
      submittedAt: ins.submittedAt,
      gpsOk: !!ins.gpsCapture,
      flagged: ins.flagged,
      status: ins.flagged ? "Flagged" : "Clean",
    }));
    return [...tcs, ...wos, ...tes, ...tps, ...inspections].sort((a, b) =>
      b.submittedAt.localeCompare(a.submittedAt),
    );
  }, [toolChecklistSubmissions, workOrders, timeEntries, ticketPhotos, vehicleInspections]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        const matchTab =
          tab === "all"
            ? true
            : tab === "tool"
              ? r.type === "Tool checklist"
              : tab === "wo"
                ? r.type === "Work order"
                : tab === "time"
                  ? r.type === "Time entry"
                  : tab === "ticket"
                    ? r.type === "Ticket photo"
                    : r.type === "Vehicle inspection";
        const matchSearch =
          search === "" ||
          r.driver.toLowerCase().includes(search.toLowerCase()) ||
          r.context.toLowerCase().includes(search.toLowerCase()) ||
          r.id.toLowerCase().includes(search.toLowerCase());
        return matchTab && matchSearch;
      }),
    [rows, tab, search],
  );

  const typeIcon = (t: Row["type"]) => {
    if (t === "Tool checklist") return <Wrench className="w-3.5 h-3.5" />;
    if (t === "Work order") return <ClipboardCheck className="w-3.5 h-3.5" />;
    if (t === "Time entry") return <Sun className="w-3.5 h-3.5" />;
    if (t === "Vehicle inspection") return <ClipboardCheck className="w-3.5 h-3.5" />;
    return <ScrollText className="w-3.5 h-3.5" />;
  };

  return (
    <AdminShell title="Forms & Submissions">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="all">All ({rows.length})</TabsTrigger>
          <TabsTrigger value="tool">Tool checklists</TabsTrigger>
          <TabsTrigger value="wo">Work orders</TabsTrigger>
          <TabsTrigger value="time">Time entries</TabsTrigger>
          <TabsTrigger value="ticket">Ticket photos</TabsTrigger>
          <TabsTrigger value="inspection">Inspections</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="relative max-w-sm my-4">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by driver, context or ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["Submitted", "Type", "Driver", "Context", "GPS", "Flagged", "Status"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={`${r.type}-${r.id}`}
                className="border-t border-border hover:bg-muted/30 cursor-pointer"
                onClick={() => setOpenRow(r)}
              >
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {new Date(r.submittedAt).toLocaleString()}
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    {typeIcon(r.type)} {r.type}
                  </span>
                </td>
                <td className="px-4 py-3">{r.driver}</td>
                <td className="px-4 py-3 font-mono text-xs">{r.context}</td>
                <td className="px-4 py-3">
                  {r.gpsOk ? (
                    <span className="inline-flex items-center gap-1 text-success text-xs">
                      <MapPin className="w-3 h-3" /> ✓
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {r.flagged ? (
                    <span className="inline-flex items-center gap-1 text-danger text-xs">
                      <Flag className="w-3 h-3" /> Flagged
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No submissions match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openRow} onOpenChange={(o) => !o && setOpenRow(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {openRow && <FormDetail row={openRow} />}
        </SheetContent>
      </Sheet>
    </AdminShell>
  );
}

function FormDetail({ row }: { row: Row }) {
  const {
    toolChecklistSubmissions,
    workOrders,
    timeEntries,
    ticketPhotos,
    tools,
    vehicleInspections,
  } = useData();
  let body: React.ReactNode = null;

  if (row.type === "Tool checklist") {
    const s = toolChecklistSubmissions.find((x) => x.id === row.id);
    if (s)
      body = (
        <div className="space-y-2 text-sm">
          {s.items.map((it) => {
            const tool = tools.find((t) => t.id === it.toolId);
            return (
              <div key={it.toolId} className="flex justify-between py-1 border-b border-border/50">
                <span>{tool?.name ?? it.toolId}</span>
                <span
                  className={`text-xs font-mono uppercase ${it.status === "ok" ? "text-success" : it.status === "damaged" ? "text-amber-brand" : "text-danger"}`}
                >
                  {it.status}
                </span>
              </div>
            );
          })}
        </div>
      );
  } else if (row.type === "Work order") {
    const w = workOrders.find((x) => x.id === row.id);
    const j = w ? jobById(w.jobId) : undefined;
    if (w)
      body = (
        <div className="space-y-3 text-sm">
          <Field k="Job" v={w.jobId} />
          <Field k="Client" v={j ? (clientById(j.clientId)?.name ?? "—") : "—"} />
          <Field k="Work performed" v={w.workPerformed} />
          <Field k="Load" v={`${w.loadType} · ${w.weightTonnes}t`} />
          <Field k="Dump site" v={w.dumpSite} />
          {w.siteIssues && (
            <div className="p-2 rounded bg-danger/10 text-danger text-xs">
              Site issue: {w.siteIssuesNote || "no note"}
            </div>
          )}
        </div>
      );
  } else if (row.type === "Time entry") {
    const t = timeEntries.find((x) => x.id === row.id);
    if (t)
      body = (
        <div className="space-y-3 text-sm">
          <Field k="Clock in" v={new Date(t.clockIn).toLocaleString()} />
          <Field k="Clock out" v={t.clockOut ? new Date(t.clockOut).toLocaleString() : "—"} />
          <Field k="Correlation" v={t.vehicleMovementCorrelation} />
          {t.flagged && (
            <div className="p-2 rounded bg-danger/10 text-danger text-xs">{t.flagReason}</div>
          )}
        </div>
      );
  } else if (row.type === "Ticket photo") {
    const p = ticketPhotos.find((x) => x.id === row.id);
    if (p)
      body = (
        <div className="space-y-3 text-sm">
          <img src={p.photoUrl} alt="ticket" className="w-full rounded border border-border" />
          <Field k="Job" v={p.jobId} />
          <Field k="Weight" v={p.weight ? `${p.weight}t` : "Not entered"} />
          <Field k="Location" v={p.location ?? "Not entered"} />
        </div>
      );
  } else {
    const ins = vehicleInspections.find((x) => x.id === row.id);
    if (ins)
      body = (
        <div className="space-y-3 text-sm">
          <Field k="Vehicle" v={ins.vehicleId} />
          <Field
            k="Submitted at"
            v={new Date(ins.submittedAt).toLocaleString()}
          />
          {ins.geotabSnapshot && (
            <Field
              k="Geotab match"
              v={`${ins.geotabSnapshot.distanceMeters}m from vehicle`}
            />
          )}
          <div>
            <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-1">
              Checklist
            </div>
            {ins.items.map((it) => (
              <div
                key={it.name}
                className="flex justify-between py-1 border-b border-border/50 text-xs"
              >
                <span>{it.name}</span>
                <span
                  className={`font-mono uppercase ${it.status === "ok" ? "text-success" : "text-danger"}`}
                >
                  {it.status}
                </span>
              </div>
            ))}
          </div>
          {ins.notes && (
            <div className="p-2 rounded bg-muted/40 text-xs">{ins.notes}</div>
          )}
        </div>
      );
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-mono text-base">{row.id}</SheetTitle>
      </SheetHeader>
      <div className="mt-4 space-y-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {row.gpsOk && (
            <span className="inline-flex items-center gap-1 text-success">
              <MapPin className="w-3 h-3" /> GPS captured
            </span>
          )}
          {row.flagged && (
            <span className="inline-flex items-center gap-1 text-danger">
              <AlertTriangle className="w-3 h-3" /> Flagged
            </span>
          )}
        </div>
        {body}
      </div>
    </>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
        {k}
      </div>
      <div className="mt-0.5">{v}</div>
    </div>
  );
}
