import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { useData } from "@/contexts/DataContext";
import { CheckCircle2, AlertTriangle, MapPin } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/inspections")({
  head: () => ({ meta: [{ title: "Vehicle inspections — Engage Hydrovac CRM" }] }),
  component: Page,
});

// Client feedback (Obvious missing): "Vehicle Inspection Menu." Admins could
// only see a computed pass/fail badge on the vehicle detail page — there was
// no way to browse the actual submitted pre-trip inspections, see which
// checklist items failed, or read a driver's notes. This reads straight from
// the already-hydrated `vehicleInspections` — no new table/migration needed.
function Page() {
  const { vehicleInspections, vehicles, drivers } = useData();
  const [query, setQuery] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  function vehicleLabel(vehicleId: string) {
    const v = vehicles.find((x) => x.id === vehicleId);
    return v ? `${v.id} — ${v.name}` : vehicleId;
  }
  function driverName(driverId: string) {
    const d = drivers.find((x) => x.id === driverId);
    return d ? d.name : driverId;
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vehicleInspections
      .filter((i) => (flaggedOnly ? i.flagged : true))
      .filter((i) =>
        q
          ? [i.id, vehicleLabel(i.vehicleId), driverName(i.driverId)].some((v) =>
              v.toLowerCase().includes(q),
            )
          : true,
      )
      .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleInspections, vehicles, drivers, query, flaggedOnly]);

  const open = openId ? vehicleInspections.find((i) => i.id === openId) ?? null : null;

  return (
    <AdminShell title="Vehicle inspections">
      <div className="flex gap-2 mb-4 items-center">
        <Input
          placeholder="Search by vehicle, driver, inspection #…"
          className="max-w-sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="inspections-search"
        />
        <button
          type="button"
          onClick={() => setFlaggedOnly((v) => !v)}
          data-testid="inspections-flagged-toggle"
          className={cn(
            "h-9 px-3 rounded-md border text-sm font-medium",
            flaggedOnly
              ? "bg-danger/10 border-danger/40 text-danger"
              : "border-border text-muted-foreground hover:bg-muted",
          )}
        >
          <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5" />
          Flagged only
        </button>
      </div>

      <div className="bg-card border border-border rounded-lg overflow-x-auto shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["Inspection #", "Vehicle", "Driver", "Submitted", "Items", "Status"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground text-sm">
                  No inspections match.
                </td>
              </tr>
            )}
            {rows.map((i) => {
              const issueCount = i.items.filter((it) => it.status === "issue").length;
              return (
                <tr
                  key={i.id}
                  data-testid="inspection-row"
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                  onClick={() => setOpenId(i.id)}
                >
                  <td className="px-4 py-3 font-mono text-xs">{i.id}</td>
                  <td className="px-4 py-3">{vehicleLabel(i.vehicleId)}</td>
                  <td className="px-4 py-3">{driverName(i.driverId)}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {new Date(i.submittedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {i.items.length - issueCount}/{i.items.length} ok
                  </td>
                  <td className="px-4 py-3">
                    {i.flagged ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold tracking-wider uppercase border bg-danger/10 text-danger border-danger/30">
                        <AlertTriangle className="w-3 h-3" /> Flagged
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold tracking-wider uppercase border bg-success/10 text-success border-success/30">
                        <CheckCircle2 className="w-3 h-3" /> Passed
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <span className="font-mono">{open.id}</span>
                  <StatusBadge status={open.flagged ? "Flagged" : "Passed"} />
                </SheetTitle>
              </SheetHeader>
              <div className="space-y-5 mt-6">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                      Vehicle
                    </div>
                    <div className="text-sm mt-0.5">{vehicleLabel(open.vehicleId)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                      Driver
                    </div>
                    <div className="text-sm mt-0.5">{driverName(open.driverId)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                      Submitted
                    </div>
                    <div className="text-sm font-mono mt-0.5">
                      {new Date(open.submittedAt).toLocaleString()}
                    </div>
                  </div>
                  {open.gpsCapture && (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                        GPS
                      </div>
                      <div className="text-xs font-mono mt-0.5 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {open.gpsCapture.lat.toFixed(4)}, {open.gpsCapture.lng.toFixed(4)}
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-2">
                    Checklist
                  </h3>
                  <ul className="space-y-1">
                    {open.items.map((it) => (
                      <li
                        key={it.name}
                        className={cn(
                          "flex items-start gap-2 text-sm rounded-md px-2 py-1.5 border",
                          it.status === "issue"
                            ? "bg-danger/5 border-danger/30"
                            : "bg-muted/20 border-border",
                        )}
                      >
                        {it.status === "issue" ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0 mt-0.5" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div>{it.name}</div>
                          {it.notes && (
                            <div className="text-xs text-muted-foreground mt-0.5">{it.notes}</div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                {open.notes && (
                  <div>
                    <h3 className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-2">
                      Driver notes
                    </h3>
                    <p className="text-sm whitespace-pre-wrap">{open.notes}</p>
                  </div>
                )}

                {open.photos.length > 0 && (
                  <div>
                    <h3 className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-2">
                      Photos
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {open.photos.map((p, idx) => (
                        <img
                          key={idx}
                          src={p}
                          alt="Inspection photo"
                          className="w-16 h-16 rounded-md object-cover border border-border"
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </AdminShell>
  );
}
