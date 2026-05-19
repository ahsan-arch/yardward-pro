import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Check, AlertTriangle, Loader2, Flag } from "lucide-react";
import { useState } from "react";
import { toolChecklist } from "@/data/mockData";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/driver/tool-checklist")({
  head: () => ({ meta: [{ title: "Tool checklist — FleetOps" }] }),
  component: Page,
});

function Page() {
  const nav = useNavigate();
  const [items, setItems] = useState(toolChecklist);
  const [loading, setLoading] = useState(false);
  const flagged = items.filter(i => !i.ok).length;

  function submit() {
    setLoading(true);
    setTimeout(() => { toast.success(flagged ? `Checklist submitted · ${flagged} flagged` : "Checklist submitted"); nav({ to: "/driver" }); }, 700);
  }

  return (
    <DriverShell>
      <div className="p-4">
        <Link to="/driver" className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"><ArrowLeft className="w-4 h-4" /> Back</Link>
        <h1 className="text-xl font-bold">Tool checklist — TRK-07</h1>
        <p className="text-sm text-muted-foreground mt-1">Check each item before departing. Flag any missing or damaged tools.</p>

        <div className="mt-4 space-y-2">
          {items.map((it, i) => (
            <div key={it.name} className={cn("rounded-lg border p-3 flex items-center gap-3",
              it.ok ? "bg-card border-border" : "bg-danger/10 border-danger/30")}>
              <button onClick={() => setItems(arr => arr.map((x, idx) => idx === i ? { ...x, ok: !x.ok } : x))}
                className={cn("w-9 h-9 rounded-full grid place-items-center shrink-0 border-2",
                  it.ok ? "bg-success border-success text-success-foreground" : "border-danger text-danger")}>
                {it.ok ? <Check className="w-5 h-5" /> : <AlertTriangle className="w-5 h-5" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className={cn("font-medium", !it.ok && "text-danger")}>{it.name}</div>
                {!it.ok && <div className="text-xs text-danger font-mono uppercase mt-0.5">MISSING</div>}
              </div>
              {!it.ok && (
                <Button size="sm" variant="outline" className="border-danger text-danger hover:bg-danger/10 h-9"><Flag className="w-3 h-3" /> Flag</Button>
              )}
            </div>
          ))}
        </div>

        {flagged > 0 && (
          <div className="mt-4 p-3 bg-danger/15 border border-danger/30 rounded-lg text-danger text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> {flagged} item{flagged > 1 ? "s" : ""} flagged — management will be notified
          </div>
        )}

        <Button onClick={submit} disabled={loading} className="w-full mt-4 h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold">
          {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Submitting…</> : "Submit checklist"}
        </Button>
      </div>
    </DriverShell>
  );
}
