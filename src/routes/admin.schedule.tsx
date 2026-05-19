import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Filter, Loader2 } from "lucide-react";
import { useState } from "react";
import { drivers, trucks, jobs, clients } from "@/data/mockData";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/schedule")({
  head: () => ({ meta: [{ title: "Schedule — FleetOps CRM" }] }),
  component: Page,
});

const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const statusBorder: Record<string, string> = {
  Active: "border-l-success", Scheduled: "border-l-amber-brand", Completed: "border-l-muted-foreground/40", Delayed: "border-l-danger",
};

function Page() {
  const [open, setOpen] = useState(true);
  const [saving, setSaving] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setTimeout(() => { setSaving(false); setOpen(false); toast.success("Job JOB-044 created · SMS sent to driver"); }, 800);
  }

  return (
    <AdminShell title="Schedule">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between mb-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground"><Filter className="w-4 h-4" /> Filters:</div>
          <Select><SelectTrigger className="w-[150px] h-9"><SelectValue placeholder="Date range" /></SelectTrigger>
            <SelectContent><SelectItem value="week">This week</SelectItem><SelectItem value="next">Next week</SelectItem></SelectContent></Select>
          <Select><SelectTrigger className="w-[140px] h-9"><SelectValue placeholder="Driver" /></SelectTrigger>
            <SelectContent>{drivers.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent></Select>
          <Select><SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="Truck" /></SelectTrigger>
            <SelectContent>{trucks.map(t => <SelectItem key={t.id} value={t.id}>{t.id}</SelectItem>)}</SelectContent></Select>
          <Select><SelectTrigger className="w-[120px] h-9"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="active">Active</SelectItem><SelectItem value="scheduled">Scheduled</SelectItem></SelectContent></Select>
        </div>
        <Button onClick={() => setOpen(true)} className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90">
          <Plus className="w-4 h-4" /> Create new job
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <div className="min-w-[900px]">
          <div className="grid grid-cols-[160px_repeat(7,minmax(0,1fr))] border-b border-border bg-muted/40">
            <div className="p-3 text-xs uppercase font-medium tracking-wider text-muted-foreground">Driver</div>
            {days.map(d => <div key={d} className="p-3 text-xs uppercase font-medium tracking-wider text-muted-foreground border-l border-border">{d}</div>)}
          </div>
          {drivers.map(driver => (
            <div key={driver.id} className="grid grid-cols-[160px_repeat(7,minmax(0,1fr))] border-b border-border">
              <div className="p-3 flex items-center gap-2 bg-muted/20">
                <div className="w-8 h-8 rounded-full bg-navy text-navy-foreground grid place-items-center text-xs font-bold">{driver.initials}</div>
                <div className="text-sm font-medium truncate">{driver.name}</div>
              </div>
              {days.map((_, di) => {
                const job = jobs.find(j => j.driver === driver.name && j.day === di);
                return (
                  <div key={di} className="p-2 border-l border-border min-h-[80px] group">
                    {job ? (
                      <div className={cn("border-l-4 bg-background border border-border rounded-md p-2 text-xs shadow-sm", statusBorder[job.status])}>
                        <div className="font-semibold truncate">{job.client}</div>
                        <div className="font-mono text-[10px] text-muted-foreground mt-0.5">{job.time} · {job.truck}</div>
                      </div>
                    ) : (
                      <button className="w-full h-full min-h-[60px] rounded-md opacity-0 group-hover:opacity-100 hover:bg-muted/50 flex items-center justify-center text-muted-foreground transition-opacity">
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create new job</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label>Job ID</Label>
              <Input value="JOB-044" readOnly className="font-mono bg-muted" />
            </div>
            <div>
              <Label>Client</Label>
              <Select defaultValue={clients[0]}><SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{clients.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
            </div>
            <div>
              <Label>Location / Site address</Label>
              <Input placeholder="e.g. 14 River Rd" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Date</Label><Input type="date" /></div>
              <div><Label>Start time</Label><Input type="time" /></div>
            </div>
            <div>
              <Label>Assign driver</Label>
              <Select><SelectTrigger><SelectValue placeholder="Choose driver" /></SelectTrigger>
                <SelectContent>{drivers.map(d => <SelectItem key={d.id} value={d.id}>{d.initials} — {d.name}</SelectItem>)}</SelectContent></Select>
            </div>
            <div>
              <Label>Assign truck</Label>
              <Select><SelectTrigger><SelectValue placeholder="Choose truck" /></SelectTrigger>
                <SelectContent>{trucks.map(t => <SelectItem key={t.id} value={t.id}>{t.id} — {t.name}</SelectItem>)}</SelectContent></Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea placeholder="Site contact, gate code, etc." rows={3} />
            </div>
            <Button type="submit" disabled={saving} className="w-full h-11 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold">
              {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</> : "Create job + notify driver"}
            </Button>
            <p className="text-xs text-center text-muted-foreground">An SMS will be sent to the assigned driver automatically</p>
          </form>
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}
