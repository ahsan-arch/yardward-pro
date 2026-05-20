import { createFileRoute } from "@tanstack/react-router";
import { MechanicShell } from "@/components/layout/MechanicLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { mechanicWorkOrders } from "@/data/mockData";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { Play, Loader2, AlertCircle } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/mechanic/")({
  head: () => ({ meta: [{ title: "Mechanic — FleetOps CRM" }] }),
  component: Page,
});

const urgencies: ("low" | "medium" | "high")[] = ["low", "medium", "high"];

function Page() {
  const { purchaseRequests } = useData();
  const { user } = useAuth();
  const [urgency, setUrgency] = useState<"low" | "medium" | "high">("medium");
  const [checkInv, setCheckInv] = useState(true);
  const [item, setItem] = useState("");
  const [reason, setReason] = useState("");
  const [cost, setCost] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!item || !reason || !cost) { toast.error("Fill all required fields"); return; }
    setLoading(true);
    try {
      await api.submitPurchaseRequest({
        mechanicId: user.id, item, reason, estimatedCost: +cost, urgency,
        inventoryCheckedAt: checkInv ? new Date().toISOString() : null,
        approvedBy: null, supplierId: null,
      });
      toast.success("Purchase request sent for approval");
      setItem(""); setReason(""); setCost("");
    } finally { setLoading(false); }
  }

  return (
    <MechanicShell title="Workshop dashboard">
      <div className="mb-6">
        <h2 className="text-lg font-semibold">Welcome back, Jamie</h2>
        <p className="text-sm text-muted-foreground">2 active work orders · 1 PO pending approval</p>
      </div>

      <section className="mb-8">
        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Active work orders assigned</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {mechanicWorkOrders.map((w, i) => (
            <div key={i} className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex items-start justify-between gap-2">
                <div className="font-mono text-sm font-bold text-navy bg-navy/10 dark:bg-navy/40 dark:text-amber-brand px-2 py-1 rounded">{w.vehicle}</div>
                <StatusBadge status={w.priority} />
              </div>
              <p className="text-sm mt-3">{w.issue}</p>
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
                <span className="text-xs text-muted-foreground">Reported by <span className="font-medium text-foreground">{w.reportedBy}</span></span>
                <Button size="sm" className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"><Play className="w-3 h-3" /> Start work</Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-lg p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <h3 className="font-semibold mb-4">New purchase request</h3>
          <form onSubmit={submit} className="space-y-3">
            <div><Label>Item needed</Label><Input value={item} onChange={e => setItem(e.target.value)} placeholder="e.g. Brake pad set" className="mt-1.5" /></div>
            <div><Label>Reason / job reference</Label><Textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} className="mt-1.5" /></div>
            <div><Label>Estimated cost</Label><Input inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} placeholder="0.00" className="mt-1.5 font-mono" /></div>
            <div>
              <Label>Urgency</Label>
              <div className="grid grid-cols-3 gap-1 mt-1.5 bg-muted rounded-md p-1">
                {urgencies.map(u => (
                  <button type="button" key={u} onClick={() => setUrgency(u)}
                    className={cn("h-10 rounded text-sm font-medium capitalize", urgency === u ? "bg-amber-brand text-amber-brand-foreground" : "text-muted-foreground")}>{u}</button>
                ))}
              </div>
            </div>
            <div className="flex items-start justify-between gap-3 p-3 bg-muted/40 rounded-lg border border-border">
              <div className="flex-1">
                <Label className="cursor-pointer">Check inventory first</Label>
                <p className="text-xs text-muted-foreground mt-1">System will check existing stock before routing for approval</p>
              </div>
              <Switch checked={checkInv} onCheckedChange={setCheckInv} />
            </div>
            <Button type="submit" disabled={loading} className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold h-11">
              {loading ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</> : "Submit for approval"}
            </Button>
          </form>
        </div>

        <div className="bg-card border border-border rounded-lg p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <h3 className="font-semibold mb-1">PO approval status</h3>
          <p className="text-xs text-muted-foreground mb-4">Recent requests</p>
          <div className="space-y-2">
            {purchaseRequests.map((p) => (
              <div key={p.id} className="flex items-center gap-3 p-3 rounded-md border border-border bg-muted/20">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{p.item}</div>
                  <div className="text-xs font-mono text-muted-foreground">${p.estimatedCost} · {new Date(p.createdAt).toLocaleDateString()}</div>
                </div>
                <StatusBadge status={p.status} />
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 p-2 rounded">
            <AlertCircle className="w-3.5 h-3.5" /> Approved POs are auto-ordered from preferred suppliers.
          </div>
        </div>
      </section>
    </MechanicShell>
  );
}
