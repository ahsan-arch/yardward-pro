import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { driverById } from "@/data/mockData";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MapPin, Wrench, Fuel, Truck, Calendar, Activity } from "lucide-react";
import { api } from "@/lib/api";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/vehicles/$id")({
  head: () => ({ meta: [{ title: "Vehicle detail — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { id } = useParams({ from: "/admin/vehicles/$id" });
  const { vehicles, maintenanceLogs, fuelLogs, tools } = useData();
  const v = vehicles.find((x) => x.id === id);
  const [tele, setTele] = useState<{ lat: number; lng: number; capturedAt: string } | null>(null);

  useEffect(() => {
    if (v) api.fetchGeotabLocation(v.id).then(setTele);
  }, [v]);

  if (!v)
    return (
      <AdminShell title="Vehicle">
        <div className="text-center py-12">
          <p className="text-sm text-muted-foreground">Vehicle not found.</p>
          <Link
            to="/admin/vehicles"
            className="inline-flex items-center gap-1 mt-3 text-amber-brand text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Back to vehicles
          </Link>
        </div>
      </AdminShell>
    );

  const logs = maintenanceLogs.filter((l) => l.vehicleId === v.id);
  const fuel = fuelLogs.filter((f) => f.vehicleId === v.id);
  const assignedTools = tools.filter((t) => t.vehicleId === v.id);
  const driver = driverById(v.driverId);

  return (
    <AdminShell title={`${v.id} — ${v.name}`}>
      <Link
        to="/admin/vehicles"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Back to vehicles
      </Link>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <Card>
          <SectionLabel icon={Truck}>Profile</SectionLabel>
          <div className="space-y-1.5 text-sm">
            <Row k="Plate" v={v.plate} mono />
            <Row k="Year" v={`${v.year}`} />
            <Row k="Type" v={v.type} />
            <Row k="VIN" v={v.vin} mono />
            <Row k="Driver" v={driver?.name ?? "Unassigned"} />
          </div>
          <div className="mt-3">
            <StatusBadge
              status={
                v.status === "operational"
                  ? "Operational"
                  : v.status === "maintenance"
                    ? "In maintenance"
                    : "Out of service"
              }
            />
          </div>
        </Card>

        <Card>
          <SectionLabel icon={Activity}>Geotab telematics</SectionLabel>
          <div className="space-y-1.5 text-sm">
            <Row k="Odometer" v={`${v.odometer.toLocaleString()} km`} mono />
            <Row k="Engine hours" v={`${v.engineHours.toLocaleString()}h`} mono />
            <Row k="Last service" v={v.lastService} />
            <Row k="Next service" v={v.nextServiceDue} />
            {tele && <Row k="Last GPS" v={`${tele.lat.toFixed(4)}, ${tele.lng.toFixed(4)}`} mono />}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() =>
              api
                .fetchGeotabLocation(v.id)
                .then(setTele)
                .then(() => toast.success("Refreshed from Geotab"))
            }
          >
            <MapPin className="w-3.5 h-3.5" /> Refresh location
          </Button>
        </Card>

        <Card>
          <SectionLabel icon={Wrench}>Tools assigned</SectionLabel>
          {assignedTools.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No tools assigned.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {assignedTools.map((t) => (
                <li key={t.id} className="flex items-center justify-between">
                  <span>{t.name}</span>
                  <span
                    className={`text-xs font-mono uppercase ${t.condition === "ok" ? "text-success" : t.condition === "damaged" ? "text-amber-brand" : "text-danger"}`}
                  >
                    {t.condition}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <SectionLabel icon={Wrench}>Maintenance log</SectionLabel>
          <Button
            size="sm"
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            onClick={() => toast.info("Use mechanic → Maintenance to add log")}
          >
            Schedule service
          </Button>
        </div>
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No maintenance history yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left font-medium px-3 py-2">Date</th>
                <th className="text-left font-medium px-3 py-2">Type</th>
                <th className="text-left font-medium px-3 py-2">Mileage</th>
                <th className="text-left font-medium px-3 py-2">By</th>
                <th className="text-left font-medium px-3 py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Calendar className="w-3 h-3 inline -mt-0.5 mr-1" />
                    {l.date}
                  </td>
                  <td className="px-3 py-2">{l.type}</td>
                  <td className="px-3 py-2 font-mono">{l.mileage.toLocaleString()}</td>
                  <td className="px-3 py-2 text-muted-foreground">{l.performedBy}</td>
                  <td className="px-3 py-2 font-mono">${l.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="mt-4">
        <Card>
          <SectionLabel icon={Fuel}>Fuel log</SectionLabel>
          {fuel.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No fuel entries yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Date</th>
                  <th className="text-left font-medium px-3 py-2">Gallons</th>
                  <th className="text-left font-medium px-3 py-2">Cost</th>
                  <th className="text-left font-medium px-3 py-2">Location</th>
                  <th className="text-left font-medium px-3 py-2">Driver</th>
                </tr>
              </thead>
              <tbody>
                {fuel.map((f) => (
                  <tr key={f.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{f.date}</td>
                    <td className="px-3 py-2 font-mono">{f.gallons}</td>
                    <td className="px-3 py-2 font-mono">${f.cost}</td>
                    <td className="px-3 py-2">{f.location}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {driverById(f.driverId)?.name ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </AdminShell>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-4">
      {children}
    </div>
  );
}
function SectionLabel({ children, icon: Icon }: { children: React.ReactNode; icon: typeof Truck }) {
  return (
    <h3 className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-3 flex items-center gap-1.5">
      <Icon className="w-3 h-3" />
      {children}
    </h3>
  );
}
function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className={mono ? "font-mono text-xs" : ""}>{v}</span>
    </div>
  );
}
