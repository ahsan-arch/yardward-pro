import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/driver/work-order")({
  head: () => ({ meta: [{ title: "New work order — FleetOps" }] }),
  component: Page,
});

function Page() {
  const nav = useNavigate();
  const [work, setWork] = useState("");
  const [load, setLoad] = useState("");
  const [weight, setWeight] = useState("");
  const [dump, setDump] = useState("");
  const [issues, setIssues] = useState(false);
  const [hasSig, setHasSig] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d")!; ctx.strokeStyle = "#0F1C2E"; ctx.lineWidth = 2; ctx.lineCap = "round";
  }, []);

  function pos(e: any) {
    const c = canvasRef.current!; const r = c.getBoundingClientRect();
    const t = e.touches?.[0] || e; return { x: (t.clientX - r.left) * (c.width / r.width), y: (t.clientY - r.top) * (c.height / r.height) };
  }
  function start(e: any) { drawing.current = true; const ctx = canvasRef.current!.getContext("2d")!; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); }
  function move(e: any) { if (!drawing.current) return; e.preventDefault?.(); const ctx = canvasRef.current!.getContext("2d")!; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); setHasSig(true); }
  function end() { drawing.current = false; }
  function clear() { const c = canvasRef.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); setHasSig(false); }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!work.trim()) errs.work = "Required";
    if (!load) errs.load = "Required";
    if (!weight || isNaN(+weight)) errs.weight = "Enter valid weight";
    if (!dump.trim()) errs.dump = "Required";
    if (!hasSig) errs.sig = "Signature required";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setLoading(true);
    setTimeout(() => { toast.success("Work order submitted for approval"); nav({ to: "/driver" }); }, 800);
  }

  return (
    <DriverShell>
      <div className="p-4">
        <Link to="/driver" className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"><ArrowLeft className="w-4 h-4" /> Back</Link>
        <h1 className="text-xl font-bold">New work order</h1>
        <p className="text-sm text-muted-foreground">JOB-041 — Maple City Council</p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <Label>Work performed</Label>
            <Textarea value={work} onChange={e => setWork(e.target.value)} rows={5} placeholder="Describe the work completed on site..." className={cn("mt-1.5 text-base", err.work && "border-danger")} />
            {err.work && <p className="text-xs text-danger mt-1">{err.work}</p>}
          </div>
          <div>
            <Label>Load type</Label>
            <Select value={load} onValueChange={setLoad}>
              <SelectTrigger className={cn("h-12 mt-1.5", err.load && "border-danger")}><SelectValue placeholder="Select load type" /></SelectTrigger>
              <SelectContent>{["Mixed fill","Clean fill","Concrete","Asphalt","Green waste","Other"].map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>Load weight (tonnes)</Label>
            <Input inputMode="decimal" value={weight} onChange={e => setWeight(e.target.value)} className={cn("h-12 mt-1.5 font-mono text-base", err.weight && "border-danger")} />
            {err.weight && <p className="text-xs text-danger mt-1">{err.weight}</p>}
          </div>
          <div>
            <Label>Dump site location</Label>
            <Input value={dump} onChange={e => setDump(e.target.value)} className={cn("h-12 mt-1.5", err.dump && "border-danger")} />
          </div>
          <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg border border-border">
            <Label>Any site issues?</Label>
            <Switch checked={issues} onCheckedChange={setIssues} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label>Foreman signature</Label>
              <button type="button" onClick={clear} className="text-xs text-amber-brand">Clear</button>
            </div>
            <div className={cn("border-2 border-dashed rounded-lg bg-card relative", err.sig ? "border-danger" : "border-border")}>
              <canvas ref={canvasRef} width={600} height={200} className="w-full h-[200px] touch-none rounded-lg"
                onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
                onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
              {!hasSig && <div className="absolute inset-0 grid place-items-center pointer-events-none text-muted-foreground text-sm">Ask foreman to sign here</div>}
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">Have the site foreman sign on your device</p>
            {err.sig && <p className="text-xs text-danger mt-1">{err.sig}</p>}
          </div>

          <Button type="submit" disabled={loading} className="w-full h-14 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 text-base font-bold">
            {loading ? <><Loader2 className="w-5 h-5 animate-spin" /> Submitting…</> : "Submit work order"}
          </Button>
        </form>
      </div>
    </DriverShell>
  );
}
