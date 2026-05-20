import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ArrowLeft, Loader2, MapPin, Check, AlertTriangle, AlertOctagon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/driver/start-of-day")({
  head: () => ({ meta: [{ title: "Start of day — FleetOps" }] }),
  component: Page,
});

const fuels = ["Empty", "1/4", "1/2", "3/4", "Full"];
const conditions = [
  { v: "ok", label: "No issues", icon: Check, color: "text-success" },
  { v: "minor", label: "Minor issue (note required)", icon: AlertTriangle, color: "text-amber-brand" },
  { v: "major", label: "Major issue (notify management)", icon: AlertOctagon, color: "text-danger" },
];

function Page() {
  const nav = useNavigate();
  const { user } = useAuth();
  const [odo, setOdo] = useState("");
  const [fuel, setFuel] = useState("3/4");
  const [cond, setCond] = useState("ok");
  const [note, setNote] = useState("");
  const [pax, setPax] = useState(false);
  const [ppe, setPpe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ odo?: string; note?: string }>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof err = {};
    if (!odo || isNaN(+odo)) errs.odo = "Enter a valid odometer reading";
    if (cond === "minor" && !note.trim()) errs.note = "Describe the issue";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    try {
      await api.submitStartOfDay({ driverId: user.id, odometer: +odo, fuelLevel: fuel, condition: cond, gps: null });
      toast.success("Start-of-day form submitted");
      nav({ to: "/driver" });
    } finally { setLoading(false); }
  }

  return (
    <DriverShell>
      <div className="p-4">
        <Link to="/driver" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-3"><ArrowLeft className="w-4 h-4" /> Back</Link>
        <h1 className="text-xl font-bold">Start of day</h1>
        <p className="text-xs font-mono text-muted-foreground">14 May 2025</p>

        <form onSubmit={submit} className="mt-5 space-y-5">
          <div>
            <Label className="text-base">Odometer reading at start</Label>
            <Input inputMode="numeric" value={odo} onChange={e => setOdo(e.target.value)} placeholder="84220" className={cn("h-14 mt-2 text-lg font-mono", err.odo && "border-danger")} />
            {err.odo && <p className="text-xs text-danger mt-1">{err.odo}</p>}
          </div>

          <div>
            <Label className="text-base">Fuel level</Label>
            <div className="grid grid-cols-5 gap-1 mt-2 bg-muted rounded-md p-1">
              {fuels.map(f => (
                <button key={f} type="button" onClick={() => setFuel(f)}
                  className={cn("h-12 rounded text-sm font-medium transition-colors", fuel === f ? "bg-amber-brand text-amber-brand-foreground" : "text-muted-foreground")}>{f}</button>
              ))}
            </div>
          </div>

          <div>
            <Label className="text-base">Vehicle condition</Label>
            <div className="space-y-2 mt-2">
              {conditions.map(c => (
                <button key={c.v} type="button" onClick={() => setCond(c.v)}
                  className={cn("w-full flex items-center gap-3 p-4 rounded-lg border-2 text-left transition-all",
                    cond === c.v ? "border-amber-brand bg-amber-brand/5" : "border-border")}>
                  <c.icon className={cn("w-5 h-5", c.color)} />
                  <span className="font-medium">{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          {cond === "minor" && (
            <div>
              <Label className="text-base">Describe the issue</Label>
              <Textarea value={note} onChange={e => setNote(e.target.value)} rows={3} className={cn("mt-2 text-base", err.note && "border-danger")} />
              {err.note && <p className="text-xs text-danger mt-1">{err.note}</p>}
            </div>
          )}

          <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg border border-border">
            <Label className="text-base">Passengers in vehicle?</Label>
            <Switch checked={pax} onCheckedChange={setPax} />
          </div>
          <div className="flex items-center justify-between p-4 bg-muted/40 rounded-lg border border-border">
            <Label className="text-base">Any personal PPE missing?</Label>
            <Switch checked={ppe} onCheckedChange={setPpe} />
          </div>

          <Button type="submit" disabled={loading} className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold">
            {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Submitting…</> : "Submit start-of-day form"}
          </Button>
          <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1"><MapPin className="w-3 h-3" /> GPS location and timestamp will be recorded on submission</p>
        </form>
      </div>
    </DriverShell>
  );
}
