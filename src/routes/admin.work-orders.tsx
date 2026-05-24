import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Link } from "@tanstack/react-router";
import { workOrderDisplay } from "@/data/mockData";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { useState } from "react";
import { Check, X, MapPin } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/work-orders")({
  head: () => ({ meta: [{ title: "Work Orders — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { workOrders } = useData();
  const { user } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const filtered = workOrders.filter((w) => (tab === "all" ? true : w.status === tab));
  const woRaw = workOrders.find((w) => w.id === openId) || null;
  const wo = woRaw ? workOrderDisplay(woRaw) : null;

  async function approve(id: string) {
    await api.approveWorkOrder(id, user.id);
    toast.success(`${id} approved · invoice draft created`);
    nav({ to: "/admin/invoices/$workOrderId", params: { workOrderId: id } });
  }
  async function reject(id: string) {
    await api.rejectWorkOrder(id, "Rejected by admin");
    toast.error(`${id} rejected`);
  }

  return (
    <AdminShell title="Work Orders">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="pending">Pending Approval</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="rejected">Rejected</TabsTrigger>
        </TabsList>
        <TabsContent value={tab} className="mt-4">
          <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
            <table className="w-full text-sm min-w-[700px]">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  {["WO #", "Job", "Client", "Driver", "Submitted", "Status", "Actions"].map(
                    (h) => (
                      <th key={h} className="text-left font-medium px-4 py-3">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {filtered.map((w) => {
                  const d = workOrderDisplay(w);
                  return (
                    <tr
                      key={w.id}
                      className="border-t border-border hover:bg-muted/30 cursor-pointer"
                      onClick={() => setOpenId(w.id)}
                    >
                      <td className="px-4 py-3 font-mono text-xs font-medium text-amber-brand">
                        {w.id}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{d.job}</td>
                      <td className="px-4 py-3">{d.client}</td>
                      <td className="px-4 py-3">{d.driver}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {d.submitted}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={d.status} />
                      </td>
                      <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                        {w.status === "pending" ? (
                          <div className="flex gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 border-success text-success hover:bg-success/10"
                              onClick={() => approve(w.id)}
                            >
                              <Check className="w-3 h-3" /> Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 border-danger text-danger hover:bg-danger/10"
                              onClick={() => reject(w.id)}
                            >
                              <X className="w-3 h-3" /> Reject
                            </Button>
                          </div>
                        ) : w.status === "approved" ? (
                          <Link
                            to="/admin/invoices/$workOrderId"
                            params={{ workOrderId: w.id }}
                            className="text-xs text-amber-brand hover:underline"
                          >
                            View invoice data
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {wo && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <span className="font-mono">{wo.id}</span>
                  <span className="text-muted-foreground">|</span>
                  <span className="font-mono text-sm">{wo.job}</span>
                </SheetTitle>
                <div>
                  <StatusBadge status={wo.status} />
                </div>
              </SheetHeader>
              <div className="space-y-5 mt-6">
                <Section title="Job details">
                  <Row k="Client" v={wo.client} />
                  <Row k="Location" v={wo.location} />
                  <Row k="Date" v="14 May 2025" />
                  <Row k="Driver" v={wo.driver} />
                  <Row k="Truck" v="TRK-07" />
                </Section>
                <Section title="Work performed">
                  <p className="text-sm text-foreground/90">{wo.workPerformed}</p>
                </Section>
                <Section title="Load / Dump details">
                  <Row k="Load type" v={wo.loadType} />
                  <Row k="Weight" v={wo.weight} />
                  <Row k="Dump site" v={wo.dumpSite} />
                </Section>
                <Section title="Foreman signature">
                  <div className="border border-border rounded-md bg-muted/20 p-4 h-28 relative">
                    <svg viewBox="0 0 200 60" className="w-full h-full text-foreground/80">
                      <path
                        d="M5 40 Q 20 10 40 35 T 80 30 Q 100 20 120 38 T 160 32 Q 180 25 195 40"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </div>
                  <p className="text-xs font-mono text-muted-foreground mt-2">
                    Signed on-site — 14 May 2025, 14:32
                  </p>
                </Section>
                <Section title="GPS + timestamp">
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="w-4 h-4 text-success" />
                    <span className="font-mono text-xs">
                      Form submitted at 14:32 from 88 York Ave
                    </span>
                    <span className="text-success text-xs">GPS ✓</span>
                  </div>
                </Section>
                <div className="space-y-2 pt-2">
                  <Button
                    className="w-full h-11 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold"
                    onClick={() => woRaw && approve(woRaw.id)}
                  >
                    Approve &amp; generate invoice data
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full h-11 border-danger text-danger hover:bg-danger/10"
                    onClick={() => woRaw && reject(woRaw.id)}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </AdminShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-sm py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}
