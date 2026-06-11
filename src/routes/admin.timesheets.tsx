import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { driverById } from "@/data/mockData";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { toCsv, downloadCsv } from "@/lib/csv";
import { Check, Flag, MapPin, ShieldCheck, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type {
  TimeEntry,
  ToolChecklistKind,
  ToolChecklistSubmission,
  Vehicle,
  AppSettings,
} from "@/types/domain";

// Match a tool checklist submission to a timesheet row. End-of-shift must
// land between clock_in and clock_out (or after clock_in if still open).
// Start-of-shift we allow up to 6h before clock_in so a driver who walked
// the truck just before clocking in still counts.
function findChecklistForShift(
  submissions: ToolChecklistSubmission[],
  driverId: string,
  kind: ToolChecklistKind,
  clockIn: string,
  clockOut: string | null,
): ToolChecklistSubmission | undefined {
  const start = new Date(clockIn).getTime();
  const startWindow = start - 6 * 3600_000;
  const end = clockOut ? new Date(clockOut).getTime() : Number.POSITIVE_INFINITY;
  return submissions.find((s) => {
    if (s.driverId !== driverId || s.kind !== kind) return false;
    const ts = new Date(s.submittedAt).getTime();
    if (kind === "start_of_shift") return ts >= startWindow && ts <= end;
    return ts >= start && ts <= end;
  });
}

type TimesheetSearch = { driverIds?: string };

export const Route = createFileRoute("/admin/timesheets")({
  head: () => ({ meta: [{ title: "Timesheets — Engage Hydrovac CRM" }] }),
  validateSearch: (s: Record<string, unknown>): TimesheetSearch => ({
    driverIds: typeof s.driverIds === "string" ? s.driverIds : undefined,
  }),
  component: Page,
});

// ---------------------------------------------------------------------------
// Tolerance-aware flag recompute.
//
// Compares the time entry's clock-out timestamp to the vehicle's most recent
// GPS movement (lastSeenAt). If the delta exceeds the admin-configured
// tolerance we surface a tolerance-derived flag so admins can re-flag entries
// after tightening the threshold. A persisted flag always wins — admin
// overrides shouldn't be silently reverted.
// ---------------------------------------------------------------------------
export function computeEffectiveFlag(
  entry: TimeEntry,
  vehicle: Vehicle | undefined,
  settings: AppSettings,
): { flagged: boolean; reason: string; source: "persisted" | "tolerance" | "none" } {
  if (entry.flagged) {
    return { flagged: true, reason: entry.flagReason, source: "persisted" };
  }
  if (!entry.clockOut || !vehicle?.lastSeenAt) {
    return { flagged: false, reason: "", source: "none" };
  }
  const clockOutMs = new Date(entry.clockOut).getTime();
  const lastMovementMs = new Date(vehicle.lastSeenAt).getTime();
  const deltaMin = Math.abs(clockOutMs - lastMovementMs) / 60_000;
  if (deltaMin > settings.gpsToleranceMinutes) {
    return {
      flagged: true,
      reason: `Vehicle GPS last moved ${Math.round(deltaMin)}min from clock-out (tolerance ${settings.gpsToleranceMinutes}min).`,
      source: "tolerance",
    };
  }
  return { flagged: false, reason: "", source: "none" };
}

// Small visual indicator for tool checklist completion against a timesheet
// row. Falls back to a muted dash when no matching submission is found in
// the shift window so admins can spot drivers who skipped the form.
function ChecklistCell({ submission }: { submission: ToolChecklistSubmission | undefined }) {
  if (!submission) return <span className="text-muted-foreground text-xs">—</span>;
  const hasIssue = submission.items.some((i) => i.status !== "ok");
  return (
    <Link
      to="/admin/forms"
      className={`inline-flex items-center gap-1 text-xs hover:underline ${
        hasIssue ? "text-danger" : "text-success"
      }`}
      title={`${submission.id} · ${new Date(submission.submittedAt).toLocaleString()}`}
      data-testid={`checklist-link-${submission.id}`}
    >
      {hasIssue ? <Flag className="w-3 h-3" /> : <Check className="w-3 h-3" />}
      {hasIssue ? "Issues" : "OK"}
    </Link>
  );
}

// Default the QBO push dialog to the most recently-closed Sunday..Sunday week.
// We compute in local time so the YYYY-MM-DD strings the edge function sees
// line up with what the admin clicked.
function defaultPayrollWindow(): { start: string; end: string } {
  const now = new Date();
  // Sunday=0..Saturday=6. Walk back to last Sunday for periodStart, then add
  // 7 days for periodEnd (exclusive upper bound, matching the SQL filter).
  const dow = now.getDay();
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setHours(0, 0, 0, 0);
  startOfThisWeek.setDate(now.getDate() - dow);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { start: fmt(startOfLastWeek), end: fmt(startOfThisWeek) };
}

type PushResult = {
  pushed: number;
  failed: number;
  skipped: number;
  totalHours: number;
  durationMs: number;
};

// Dialog that drives api.pushPayrollToQbo. We separate "running" / "result"
// states so the operator sees the counter summary inline after a run instead
// of having to dismiss + reopen to see what happened.
function QboPayrollPushDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const defaults = useMemo(defaultPayrollWindow, []);
  const [periodStart, setPeriodStart] = useState(defaults.start);
  const [periodEnd, setPeriodEnd] = useState(defaults.end);
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<(PushResult & { dryRun: boolean }) | null>(null);

  async function run() {
    if (!periodStart || !periodEnd) {
      toast.error("Pick a start and end date");
      return;
    }
    if (periodStart >= periodEnd) {
      toast.error("Start date must be before end date");
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const r = await api.pushPayrollToQbo(periodStart, periodEnd, dryRun);
      setResult({ ...r, dryRun });
      const verb = dryRun ? "Dry run complete" : "Payroll pushed";
      toast.success(`${verb}: ${r.pushed} pushed · ${r.failed} failed · ${r.skipped} skipped`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "QBO push failed");
    } finally {
      setRunning(false);
    }
  }

  function reset() {
    setResult(null);
    setRunning(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export timesheets to QuickBooks</DialogTitle>
          <DialogDescription>
            Pushes completed time entries in the window below to QuickBooks Online as TimeActivity
            rows. Use dry run first to preview what would sync.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="qbo-period-start">Period start</Label>
              <Input
                id="qbo-period-start"
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                data-testid="qbo-period-start"
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="qbo-period-end">Period end</Label>
              <Input
                id="qbo-period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                data-testid="qbo-period-end"
                className="font-mono"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Window is half-open: clock_in in [start, end). Default is the last completed
            Sunday-to-Sunday week.
          </p>
          <div className="flex items-center justify-between border-t border-border pt-3">
            <div>
              <Label htmlFor="qbo-dry-run" className="cursor-pointer">
                Dry run
              </Label>
              <p className="text-[11px] text-muted-foreground">
                Preview only — does not call QuickBooks. Writes preview rows tagged "dryRun" to the
                audit log.
              </p>
            </div>
            <Switch
              id="qbo-dry-run"
              checked={dryRun}
              onCheckedChange={setDryRun}
              data-testid="qbo-dry-run"
            />
          </div>

          {result && (
            <div
              className="bg-muted/40 border border-border rounded-md p-3 text-sm space-y-1"
              data-testid="qbo-push-result"
            >
              <div className="font-medium">
                {result.dryRun ? "Dry run summary" : "Push summary"}
              </div>
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div>
                  <div className="text-muted-foreground">Pushed</div>
                  <div className="font-mono text-success" data-testid="qbo-pushed">
                    {result.pushed}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Failed</div>
                  <div className="font-mono text-danger" data-testid="qbo-failed">
                    {result.failed}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Skipped</div>
                  <div className="font-mono" data-testid="qbo-skipped">
                    {result.skipped}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Total hours</div>
                  <div className="font-mono" data-testid="qbo-total-hours">
                    {result.totalHours.toFixed(2)}
                  </div>
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground font-mono pt-1 border-t border-border/50">
                duration {result.durationMs}ms
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={running}
            data-testid="close-qbo-dialog"
          >
            Close
          </Button>
          <Button
            onClick={run}
            disabled={running}
            data-testid="qbo-push-run"
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            <Send className="w-4 h-4" />
            {running ? "Running…" : dryRun ? "Run dry run" : "Push to QuickBooks"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Per-driver hourly-rate editor. Rates drive the gross-pay column in the
// payroll CSV; stored on drivers.hourly_rate. Loaded fresh each open so it
// reflects the DB (DataContext's driver objects predate the rate column).
function PayRatesDialog({
  open,
  onOpenChange,
  drivers,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  drivers: Array<{ id: string; name: string }>;
}) {
  const [rates, setRates] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void api
      .fetchDriverRates()
      .then((m) => {
        const next: Record<string, string> = {};
        for (const d of drivers) next[d.id] = (m.get(d.id) ?? 0).toString();
        setRates(next);
      })
      .finally(() => setLoading(false));
  }, [open, drivers]);

  async function save(driverId: string) {
    setSavingId(driverId);
    try {
      const r = await api.updateDriverRate(driverId, Number(rates[driverId]) || 0);
      if (r.ok) toast.success("Rate saved");
      else toast.error(r.reason);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Driver pay rates</DialogTitle>
          <DialogDescription>
            Hourly rate per driver — used for the gross-pay column in the payroll CSV (overtime
            billed at 1.5× above {appSettingsOtLabel()}).
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="py-6 text-center text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-2">
            {drivers.map((d) => (
              <div key={d.id} className="flex items-center gap-2">
                <span className="flex-1 text-sm truncate">{d.name}</span>
                <span className="text-xs text-muted-foreground">$/h</span>
                <Input
                  type="number"
                  min={0}
                  step="0.25"
                  value={rates[d.id] ?? ""}
                  onChange={(e) => setRates((x) => ({ ...x, [d.id]: e.target.value }))}
                  className="w-24 h-9"
                  data-testid={`pay-rate-${d.id}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void save(d.id)}
                  disabled={savingId === d.id}
                >
                  Save
                </Button>
              </div>
            ))}
            {drivers.length === 0 && (
              <p className="text-sm text-muted-foreground">No drivers yet.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Tiny helper so the dialog can name the OT threshold without prop-drilling
// appSettings; reads the same default the export uses.
function appSettingsOtLabel(): string {
  return "the weekly overtime threshold";
}

function Page() {
  const { timeEntries, drivers, vehicles, appSettings, toolChecklistSubmissions } = useData();
  const search = useSearch({ from: "/admin/timesheets" });
  const filterDriverIds = useMemo(
    () => (search.driverIds ? search.driverIds.split(",").filter(Boolean) : null),
    [search.driverIds],
  );
  const [tab, setTab] = useState<"all" | "flagged" | "active">(filterDriverIds ? "all" : "all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [qboOpen, setQboOpen] = useState(false);
  const [ratesOpen, setRatesOpen] = useState(false);

  // Map driverId -> vehicle (current assignment) so we can compare clock-out
  // time to the vehicle's last GPS movement timestamp.
  const vehicleByDriver = useMemo(() => {
    const m = new Map<string, Vehicle>();
    for (const v of vehicles) if (v.driverId) m.set(v.driverId, v);
    return m;
  }, [vehicles]);

  const enriched = useMemo(() => {
    return timeEntries.map((t) => {
      const veh = vehicleByDriver.get(t.driverId);
      const eff = computeEffectiveFlag(t, veh, appSettings);
      return { ...t, _flagged: eff.flagged, _reason: eff.reason, _source: eff.source };
    });
  }, [timeEntries, vehicleByDriver, appSettings]);

  const rows = useMemo(
    () =>
      enriched
        .filter((t) => {
          if (filterDriverIds && !filterDriverIds.includes(t.driverId)) return false;
          if (tab === "all") return true;
          if (tab === "flagged") return t._flagged;
          return !t.clockOut;
        })
        .sort((a, b) => b.clockIn.localeCompare(a.clockIn)),
    [enriched, tab, filterDriverIds],
  );

  const flaggedCount = enriched.filter((t) => t._flagged).length;
  const activeCount = enriched.filter((t) => !t.clockOut).length;

  // Payroll CSV: per-driver weekly hours with regular/overtime split, plus a
  // per-entry detail section. Hand this file to whoever runs payroll —
  // covers the QuickBooks Workforce/Time use case without the subscription.
  async function exportPayrollCsv() {
    const closed = enriched.filter((t) => t.clockOut);
    if (closed.length === 0) {
      toast.error("No completed shifts to export");
      return;
    }
    // Per-driver hourly rates (drivers.hourly_rate) turn hours into gross
    // pay — OT at 1.5×. Rate 0 leaves the pay cells blank so the accountant
    // can spot unconfigured drivers instead of seeing a false $0.
    const rates = await api.fetchDriverRates();
    const hours = (t: (typeof closed)[number]) =>
      (new Date(t.clockOut as string).getTime() - new Date(t.clockIn).getTime()) / 3_600_000;
    // ISO week key (yyyy-Www) for the weekly OT split.
    //
    // Bucket by the shift's CIVIL date in the org timezone, not UTC. A shift
    // clocked in Sunday evening in America/Toronto is already Monday in UTC, so
    // a UTC week key would push it into the next payroll week — mis-splitting
    // regular vs overtime hours and inflating/deflating the 1.5× gross. We read
    // the local Y/M/D via Intl, then run the standard tz-free ISO-week math on
    // that civil date (treated as UTC purely as a calendar).
    const orgTz = appSettings.timezone || "America/Toronto";
    const civilParts = (iso: string) => {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: orgTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(iso));
      const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "1");
      return { y: get("year"), m: get("month"), d: get("day") };
    };
    const weekKey = (iso: string) => {
      const { y, m, d: dom } = civilParts(iso);
      const d = new Date(Date.UTC(y, m - 1, dom));
      const day = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - day + 3);
      const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      const week = 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3) / 7);
      return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    };
    const otThreshold = appSettings.overtimeAlertHours || 44;
    const byDriverWeek = new Map<
      string,
      {
        driverId: string;
        driver: string;
        week: string;
        total: number;
        entries: number;
        flagged: number;
      }
    >();
    for (const t of closed) {
      const k = `${t.driverId}|${weekKey(t.clockIn)}`;
      const name = drivers.find((d) => d.id === t.driverId)?.name ?? t.driverId;
      const cur = byDriverWeek.get(k) ?? {
        driverId: t.driverId,
        driver: name,
        week: weekKey(t.clockIn),
        total: 0,
        entries: 0,
        flagged: 0,
      };
      cur.total += hours(t);
      cur.entries += 1;
      if (t._flagged) cur.flagged += 1;
      byDriverWeek.set(k, cur);
    }
    const summary = Array.from(byDriverWeek.values()).sort(
      (a, b) => a.week.localeCompare(b.week) || a.driver.localeCompare(b.driver),
    );
    const lines: string[][] = summary.map((s) => {
      const reg = Math.min(s.total, otThreshold);
      const ot = Math.max(0, s.total - otThreshold);
      const rate = rates.get(s.driverId) ?? 0;
      const gross = rate > 0 ? reg * rate + ot * rate * 1.5 : null;
      return [
        s.week,
        s.driver,
        s.total.toFixed(2),
        reg.toFixed(2),
        ot.toFixed(2),
        rate > 0 ? rate.toFixed(2) : "",
        gross != null ? gross.toFixed(2) : "",
        String(s.entries),
        String(s.flagged),
      ];
    });
    const csv = toCsv(
      [
        "Week",
        "Driver",
        "Total hours",
        `Regular (≤${otThreshold}h/wk)`,
        "Overtime",
        "Hourly rate",
        "Gross pay (OT 1.5x)",
        "Shifts",
        "Flagged shifts",
      ],
      lines,
    );
    downloadCsv(`payroll-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    toast.success(`Payroll export: ${summary.length} driver-weeks`);
  }

  async function clearFlag(entryId: string) {
    setPendingId(entryId);
    try {
      await api.setTimeEntryFlag(entryId, false, "");
      toast.success("Flag cleared");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't clear flag");
    } finally {
      setPendingId(null);
    }
  }

  async function applyFlag(entryId: string, reason: string) {
    setPendingId(entryId);
    try {
      await api.setTimeEntryFlag(entryId, true, reason);
      toast.success("Flag persisted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't flag entry");
    } finally {
      setPendingId(null);
    }
  }

  const filteredDriverNames = filterDriverIds
    ?.map((id) => drivers.find((d) => d.id === id)?.name ?? id)
    .join(", ");

  return (
    <AdminShell title="Timesheets">
      {filterDriverIds && (
        <div className="mb-4 bg-amber-brand/10 border border-amber-brand/30 rounded-md p-3 text-sm flex items-center justify-between">
          <span>
            Filtered to <span className="font-semibold">{filteredDriverNames}</span> · approaching
            overtime
          </span>
          <a href="/admin/timesheets" className="text-xs underline">
            Clear filter
          </a>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="all">All ({enriched.length})</TabsTrigger>
            <TabsTrigger value="active">Active ({activeCount})</TabsTrigger>
            <TabsTrigger value="flagged">Flagged ({flaggedCount})</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRatesOpen(true)}
            data-testid="pay-rates-btn"
          >
            <ShieldCheck className="w-3.5 h-3.5" /> Pay rates
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void exportPayrollCsv()}
            data-testid="export-payroll-csv-btn"
          >
            <Send className="w-3.5 h-3.5" /> Payroll CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setQboOpen(true)}
            data-testid="export-to-qbo-btn"
          >
            <Send className="w-3.5 h-3.5" /> Export to QuickBooks
          </Button>
        </div>
      </div>
      <QboPayrollPushDialog open={qboOpen} onOpenChange={setQboOpen} />
      <PayRatesDialog open={ratesOpen} onOpenChange={setRatesOpen} drivers={drivers} />

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {[
                "Entry",
                "Driver",
                "Clock in",
                "Clock out",
                "Hours",
                "GPS correlation",
                "Start checklist",
                "End checklist",
                "Status",
                "Actions",
              ].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const hours = t.clockOut
                ? (
                    (new Date(t.clockOut).getTime() - new Date(t.clockIn).getTime()) /
                    3600_000
                  ).toFixed(2)
                : "—";
              const corr = t.vehicleMovementCorrelation;
              const isPending = pendingId === t.id;
              return (
                <tr
                  key={t.id}
                  className={`border-t border-border ${t._flagged ? "bg-danger/5" : ""}`}
                >
                  <td className="px-4 py-3 font-mono text-xs">{t.id}</td>
                  <td className="px-4 py-3">{driverById(t.driverId)?.name ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {new Date(t.clockIn).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {t.clockOut ? (
                      new Date(t.clockOut).toLocaleString()
                    ) : (
                      <span className="text-amber-brand">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono">{hours}</td>
                  <td className="px-4 py-3">
                    {corr === "matches" && (
                      <span className="inline-flex items-center gap-1 text-success text-xs">
                        <MapPin className="w-3 h-3" /> Matches
                      </span>
                    )}
                    {corr === "mismatch" && (
                      <span className="inline-flex items-center gap-1 text-danger text-xs">
                        <Flag className="w-3 h-3" /> Mismatch
                      </span>
                    )}
                    {corr === "pending" && (
                      <span className="text-xs text-muted-foreground">Pending</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ChecklistCell
                      submission={findChecklistForShift(
                        toolChecklistSubmissions,
                        t.driverId,
                        "start_of_shift",
                        t.clockIn,
                        t.clockOut,
                      )}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <ChecklistCell
                      submission={findChecklistForShift(
                        toolChecklistSubmissions,
                        t.driverId,
                        "end_of_shift",
                        t.clockIn,
                        t.clockOut,
                      )}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {t._flagged ? (
                      <span title={t._reason}>
                        <StatusBadge status="Flagged" />
                        {t._source === "tolerance" && (
                          <span className="ml-1 text-[10px] uppercase font-mono text-muted-foreground">
                            tol
                          </span>
                        )}
                      </span>
                    ) : (
                      <StatusBadge status="OK" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {t._flagged && t._source === "persisted" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending}
                        onClick={() => clearFlag(t.id)}
                        data-testid={`clear-flag-${t.id}`}
                      >
                        <ShieldCheck className="w-3.5 h-3.5" /> Mark resolved
                      </Button>
                    )}
                    {t._flagged && t._source === "tolerance" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isPending}
                        onClick={() => applyFlag(t.id, t._reason)}
                        data-testid={`persist-flag-${t.id}`}
                      >
                        <Flag className="w-3.5 h-3.5" /> Persist flag
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No timesheets in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
