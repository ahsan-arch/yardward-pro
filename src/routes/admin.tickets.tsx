import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { driverById } from "@/data/mockData";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/tickets")({
  head: () => ({ meta: [{ title: "Tickets — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { ticketPhotos } = useData();
  const [tab, setTab] = useState<"awaiting" | "entered" | "all">("awaiting");
  const [openId, setOpenId] = useState<string | null>(null);

  const list = ticketPhotos.filter((p) =>
    tab === "all"
      ? true
      : tab === "awaiting"
        ? p.status === "awaiting-entry"
        : p.status === "entered",
  );
  const open = openId ? ticketPhotos.find((p) => p.id === openId) : null;
  const [weight, setWeight] = useState("");
  const [location, setLocation] = useState("");

  function commit() {
    if (!weight || !location) {
      toast.error("Fill weight and location");
      return;
    }
    toast.success(`${open?.id} updated · ${weight}t at ${location}`);
    setOpenId(null);
    setWeight("");
    setLocation("");
  }

  return (
    <AdminShell title="Ticket photos">
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-4">
        <TabsList>
          <TabsTrigger value="awaiting">
            Awaiting entry ({ticketPhotos.filter((p) => p.status === "awaiting-entry").length})
          </TabsTrigger>
          <TabsTrigger value="entered">Entered</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {list.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setOpenId(p.id);
              setWeight(p.weight?.toString() ?? "");
              setLocation(p.location ?? "");
            }}
            className="text-left bg-card border border-border rounded-lg overflow-hidden hover:border-amber-brand transition-colors"
          >
            <img
              src={p.photoUrl}
              alt="ticket"
              className="w-full aspect-[3/4] object-cover bg-muted"
            />
            <div className="p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-amber-brand">{p.jobId}</span>
                <StatusBadge status={p.status === "entered" ? "Entered" : "Awaiting entry"} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {driverById(p.driverId)?.name ?? "—"}
              </div>
              <div className="mt-2 text-xs flex justify-between">
                <span>
                  Weight: <span className="font-mono">{p.weight ? `${p.weight}t` : "—"}</span>
                </span>
                <span className="font-mono text-muted-foreground">{p.uploadedAt.slice(0, 10)}</span>
              </div>
            </div>
          </button>
        ))}
        {list.length === 0 && (
          <p className="col-span-full text-center py-12 text-sm text-muted-foreground">
            No tickets in this view.
          </p>
        )}
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-base">{open.id}</SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-4">
                <img
                  src={open.photoUrl}
                  alt="ticket"
                  className="w-full rounded-lg border border-border"
                />
                <div className="text-sm flex justify-between">
                  <span className="text-muted-foreground">Job</span>
                  <span className="font-mono">{open.jobId}</span>
                </div>
                <div className="text-sm flex justify-between">
                  <span className="text-muted-foreground">Driver</span>
                  <span>{driverById(open.driverId)?.name}</span>
                </div>
                <div>
                  <Label>Weight (tonnes)</Label>
                  <Input
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    className="font-mono"
                  />
                </div>
                <div>
                  <Label>Dump location</Label>
                  <Input value={location} onChange={(e) => setLocation(e.target.value)} />
                </div>
                <Button
                  onClick={commit}
                  className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                >
                  Save entry
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </AdminShell>
  );
}
