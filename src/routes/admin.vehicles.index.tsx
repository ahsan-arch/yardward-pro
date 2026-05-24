import { createFileRoute, Link } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Search, AlertTriangle, Truck as TruckIcon, Upload } from "lucide-react";
import { trucks } from "@/data/mockData";
import { cn } from "@/lib/utils";
import { useRef } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/vehicles/")({
  head: () => ({ meta: [{ title: "Vehicles — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const fileRef = useRef<HTMLInputElement>(null);

  function onCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const rows = text.split(/\r?\n/).filter(Boolean).length - 1;
      toast.success(`Parsed ${rows} rows from Fleetio CSV (mock import — would add to DB)`);
    };
    reader.readAsText(f);
    e.target.value = "";
  }

  return (
    <AdminShell title="Vehicles">
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search by ID, name, driver…" className="pl-9" />
        </div>
        <Select>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="truck">Truck</SelectItem>
            <SelectItem value="trailer">Trailer</SelectItem>
            <SelectItem value="equipment">Equipment</SelectItem>
          </SelectContent>
        </Select>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={onCsv} />
        <Button variant="outline" onClick={() => fileRef.current?.click()} className="sm:ml-auto">
          <Upload className="w-4 h-4" /> Import from Fleetio
        </Button>
        <Button className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90">
          <Plus className="w-4 h-4" /> Add vehicle
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {trucks.map((t) => (
          <div
            key={t.id}
            className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-hidden"
          >
            {t.status === "In maintenance" && (
              <div className="bg-amber-brand/15 text-amber-brand text-xs font-medium px-4 py-2 flex items-center gap-2 border-b border-amber-brand/20">
                <AlertTriangle className="w-3.5 h-3.5" /> In maintenance — scheduled work in
                progress
              </div>
            )}
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-md bg-navy text-navy-foreground grid place-items-center">
                    <TruckIcon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-mono text-xs font-bold text-navy bg-navy/10 px-2 py-0.5 rounded inline-block dark:bg-navy/30 dark:text-amber-brand">
                      {t.id}
                    </div>
                    <div className="font-semibold mt-1">{t.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.year} · {t.type}
                    </div>
                  </div>
                </div>
                <span
                  className={cn(
                    "text-[10px] font-mono uppercase px-2 py-1 rounded",
                    t.status === "Operational"
                      ? "bg-success/15 text-success"
                      : "bg-amber-brand/15 text-amber-brand",
                  )}
                >
                  {t.status === "Operational" ? "● Operational" : "● Maintenance"}
                </span>
              </div>

              <div className="mt-4 pt-4 border-t border-border flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-amber-brand text-amber-brand-foreground grid place-items-center text-[10px] font-bold">
                  {t.driver === "Unassigned"
                    ? "?"
                    : t.driver
                        .split(" ")
                        .map((n) => n[0])
                        .join("")}
                </div>
                <div className="text-sm">
                  <div className="text-[10px] uppercase font-mono text-muted-foreground">
                    Driver
                  </div>
                  <div
                    className={cn(
                      "font-medium",
                      t.driver === "Unassigned" && "text-muted-foreground italic",
                    )}
                  >
                    {t.driver}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <Stat k="Odometer" v={t.odometer ? `${t.odometer.toLocaleString()} km` : "—"} />
                <Stat k="Engine hours" v={`${t.hours.toLocaleString()} hrs`} />
                <Stat k="Last service" v={t.lastService} />
                <Stat k="Next service due" v={t.nextDue} />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2">
                <Link
                  to="/admin/vehicles/$id"
                  params={{ id: t.id }}
                  className="h-9 rounded-md border border-border text-xs font-medium grid place-items-center hover:bg-muted/50"
                >
                  View details
                </Link>
                <Button variant="outline" size="sm">
                  Add record
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </AdminShell>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-mono text-muted-foreground">{k}</div>
      <div className="font-mono text-xs font-medium">{v}</div>
    </div>
  );
}
