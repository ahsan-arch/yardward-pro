import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Search, Bug, AlertTriangle, Clock, Flame, Inbox, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, USE_SUPABASE } from "@/lib/supabase";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/errors")({
  head: () => ({ meta: [{ title: "Error log — Yardward Pro" }] }),
  component: Page,
});

type Severity = "info" | "warn" | "error" | "critical";
type Source = "frontend" | "edge_function" | "database" | "integration" | "driver_app";

type ProfileLite = { name: string | null; email: string | null } | null;

type ErrorRow = {
  id: string;
  created_at: string;
  source: Source | string;
  severity: Severity | string;
  error_code: string;
  message: string;
  stack: string | null;
  user_id: string | null;
  session_id: string | null;
  url: string | null;
  user_agent: string | null;
  function_name: string | null;
  context: unknown;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
  profiles?: ProfileLite;
};

// Row shape returned from public.dead_letter_submissions. The table is written
// by offline-queue.ts when a queued submission exhausts MAX_RETRIES; the admin
// view surfaces these so a human can decide to requeue, edit upstream, or
// just leave the row for forensics.
type DeadLetterRow = {
  id: string;
  kind: string;
  payload: unknown;
  queued_at: string;
  retry_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  moved_to_dead_letter_at: string;
  user_id: string | null;
  profiles?: ProfileLite;
};

const SEVERITIES: Array<Severity | "all"> = ["all", "info", "warn", "error", "critical"];
const SOURCES: Array<Source | "all"> = [
  "all",
  "frontend",
  "edge_function",
  "integration",
  "driver_app",
];

const severityStyles: Record<string, string> = {
  info: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  warn: "bg-amber-brand/15 text-amber-brand border-amber-brand/30",
  error: "bg-danger/15 text-danger border-danger/30",
  critical: "bg-danger/20 text-danger border-danger/40 animate-pulse",
};

const sourceLabel: Record<string, string> = {
  frontend: "Frontend",
  edge_function: "Edge function",
  database: "Database",
  integration: "Integration",
  driver_app: "Driver app",
};

// Mock error_log rows used when Supabase isn't wired up. Kept small but
// covers a couple of severities + sources so the filters have something
// meaningful to operate on.
const MOCK_ERROR_ROWS: ErrorRow[] = [
  {
    id: "ERR-MOCK-1",
    created_at: new Date(Date.now() - 35 * 60_000).toISOString(),
    source: "frontend",
    severity: "error",
    error_code: "MOCK_RENDER",
    message: "TypeError reading 'name' of undefined in DriverCard",
    stack: "at DriverCard (driver-card.tsx:42:18)\nat renderWithHooks (...)",
    user_id: "U-1",
    session_id: "S-abc",
    url: "/admin/drivers",
    user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/124",
    function_name: null,
    context: { route: "/admin/drivers", driverId: "D-99" },
    resolved_at: null,
    resolved_by: null,
    resolution_notes: null,
    profiles: { name: "Alex Chen", email: "alex@fleetops.co" },
  },
  {
    id: "ERR-MOCK-2",
    created_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
    source: "edge_function",
    severity: "critical",
    error_code: "QBO_PUSH_TIMEOUT",
    message: "Edge function qbo-push timed out after 30s",
    stack: null,
    user_id: null,
    session_id: null,
    url: null,
    user_agent: null,
    function_name: "qbo-push",
    context: { periodStart: "2026-05-18", periodEnd: "2026-05-25" },
    resolved_at: null,
    resolved_by: null,
    resolution_notes: null,
    profiles: null,
  },
];

// Mock dead_letter_submissions rows used when Supabase isn't wired up so
// the Requeue admin flow is exercisable without a backend.
const MOCK_DLQ_ROWS: DeadLetterRow[] = [
  {
    id: "DLQ-MOCK-1",
    kind: "tool_checklist",
    payload: {
      kind: "start_of_shift",
      driverId: "D-04",
      items: [
        { id: "wrench-15mm", status: "missing" },
        { id: "tape-measure", status: "ok" },
      ],
      submittedAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    },
    queued_at: new Date(Date.now() - 25 * 3600_000).toISOString(),
    retry_count: 5,
    last_error: "Network request failed (offline)",
    last_attempt_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
    moved_to_dead_letter_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
    user_id: "U-2",
    profiles: { name: "Sam Patel", email: "sam@fleetops.co" },
  },
];

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function formatContext(ctx: unknown): string {
  try {
    return JSON.stringify(ctx ?? {}, null, 2);
  } catch {
    return String(ctx);
  }
}

// Cap how much of a DLQ payload we render in the admin Sheet — some payloads
// (e.g. job-create with embedded photo data-URIs) can be megabytes and would
// stall the page if dumped into a <pre> verbatim.
const MAX_PAYLOAD_BYTES = 50_000;
function previewPayload(p: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(p, null, 2);
  } catch {
    s = String(p);
  }
  if (s.length <= MAX_PAYLOAD_BYTES) return s;
  return (
    s.slice(0, MAX_PAYLOAD_BYTES) +
    "\n\n... [truncated — " +
    (s.length - MAX_PAYLOAD_BYTES).toLocaleString() +
    " more bytes]"
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  tone: "muted" | "warning" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "bg-danger/15 text-danger"
      : tone === "warning"
        ? "bg-amber-brand/15 text-amber-brand"
        : "bg-muted text-muted-foreground";
  return (
    <div className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="flex items-start justify-between">
        <Icon className="w-5 h-5 text-muted-foreground" />
        <span
          className={cn(
            "text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded",
            toneClass,
          )}
        >
          {label.split(" ")[0]}
        </span>
      </div>
      <div className="mt-3 text-3xl font-bold font-mono">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] uppercase font-mono font-semibold px-1.5 py-0.5 rounded border",
        severityStyles[severity] || "bg-muted text-muted-foreground border-border",
      )}
    >
      {severity}
    </span>
  );
}

function Page() {
  // The two-tab layout lets admins triage both server-logged errors (error_log)
  // AND queued submissions that exhausted retries (dead_letter_submissions) in
  // one place. Before this, the DLQ rows were invisible — the OfflineBanner
  // "Review failures" link pointed here but only error_log was queried, so
  // poisoned offline submissions silently piled up.
  return (
    <AdminShell title="Error log">
      <Tabs defaultValue="errors" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="errors" data-testid="tab-errors">
            Errors
          </TabsTrigger>
          <TabsTrigger value="dlq" data-testid="tab-dlq">
            Dead-letter queue
          </TabsTrigger>
        </TabsList>
        <TabsContent value="errors">
          <ErrorsTab />
        </TabsContent>
        <TabsContent value="dlq">
          <DeadLetterTab />
        </TabsContent>
      </Tabs>
    </AdminShell>
  );
}

function ErrorsTab() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState<Source | "all">("all");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [showResolved, setShowResolved] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!USE_SUPABASE || !supabase) {
      // Mock-mode rows so admins (and e2e) can exercise the resolve flow
      // without a live Supabase. Filters are applied client-side in the
      // filteredRows useMemo below, so mock and real rows funnel through
      // the same predicate set.
      setRows(MOCK_ERROR_ROWS);
      return;
    }
    setLoading(true);
    const sb = supabase as unknown as {
      from: (t: string) => {
        select: (columns: string) => {
          order: (col: string, opts: { ascending: boolean }) => any;
        };
      };
    };

    // Always query the error_log table directly. The unresolved_errors view
    // does not carry FK metadata, so the profiles embed below would fail with
    // "Could not find a relationship between unresolved_errors and profiles".
    // Filtering happens client-side (see filteredRows) so the search box and
    // source/severity selectors stay responsive without a round trip per
    // keystroke, and mock-mode behaves identically.
    const query: any = sb
      .from("error_log")
      .select("*, profiles!error_log_user_id_fkey(name, email)")
      .order("created_at", { ascending: false });

    const { data, error } = await query;
    if (error) {
      toast.error(`Failed to load errors: ${error.message}`);
      setRows([]);
    } else {
      setRows((data ?? []) as ErrorRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const current = useMemo(
    () => (openId ? rows.find((r) => r.id === openId) ?? null : null),
    [openId, rows],
  );

  useEffect(() => {
    setResolutionNotes(current?.resolution_notes ?? "");
  }, [current?.id, current?.resolution_notes]);

  // Client-side filter pipeline. Runs against whatever rows the loader pulled
  // (mock fixtures or live Supabase). Keeps mock-mode and real-mode behaviour
  // identical, and makes the search box / selectors / show-resolved toggle
  // feel instantaneous instead of waiting on a refetch per keystroke.
  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showResolved && r.resolved_at) return false;
      if (source !== "all" && r.source !== source) return false;
      if (severity !== "all" && r.severity !== severity) return false;
      if (needle) {
        const hay =
          (r.message ?? "").toLowerCase() +
          " " +
          (r.error_code ?? "").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, search, source, severity, showResolved]);

  const stats = useMemo(() => {
    const unresolved = rows.filter((r) => !r.resolved_at).length;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const last24h = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff).length;
    const critical = rows.filter((r) => r.severity === "critical" && !r.resolved_at).length;
    return { unresolved, last24h, critical };
  }, [rows]);

  async function markResolved(id: string) {
    // Mock-mode path: there's no Supabase to write to, but the operator
    // still clicked "Mark resolved", so we optimistically drop the row
    // from the local view and emit a success toast. This keeps the UI
    // exercised in tests / demos without pretending we hit a real DB.
    if (!USE_SUPABASE || !supabase) {
      setRows((prev) => prev.filter((r) => r.id !== id));
      setOpenId(null);
      toast.success("Error marked resolved (mock)");
      return;
    }
    if (!user?.id) {
      toast.error("Not signed in");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.resolveError(id, resolutionNotes || null);
      if (!result.ok) {
        toast.error(`Could not resolve: ${result.reason}`);
        return;
      }
      // Real-write success path: toast unconditionally before refreshing
      // so the operator gets immediate feedback even if the subsequent
      // reload fetch is slow or itself throws.
      toast.success("Error marked resolved");
      setOpenId(null);
      load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not resolve: ${msg}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <StatCard
          label="Unresolved errors"
          value={stats.unresolved}
          icon={Bug}
          tone={stats.unresolved > 0 ? "warning" : "muted"}
        />
        <StatCard
          label="Last 24 hours"
          value={stats.last24h}
          icon={Clock}
          tone={stats.last24h > 0 ? "warning" : "muted"}
        />
        <StatCard
          label="Critical (unresolved)"
          value={stats.critical}
          icon={Flame}
          tone={stats.critical > 0 ? "danger" : "muted"}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search message…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        <Select value={source} onValueChange={(v) => setSource(v as Source | "all")}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "all" ? "All sources" : sourceLabel[s] ?? s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={severity} onValueChange={(v) => setSeverity(v as Severity | "all")}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "all" ? "All severities" : s.charAt(0).toUpperCase() + s.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2 px-3 rounded-md border border-border bg-card">
          <Switch
            id="show-resolved"
            checked={showResolved}
            onCheckedChange={setShowResolved}
          />
          <Label htmlFor="show-resolved" className="text-xs cursor-pointer">
            Show resolved
          </Label>
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]" data-testid="error-log-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["Created", "Source", "Severity", "Code", "Message", "User", "Status", ""].map(
                (h) => (
                  <th key={h} className="text-left font-medium px-4 py-3">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((r) => {
              const isResolved = !!r.resolved_at;
              const profileName = r.profiles?.name ?? r.profiles?.email ?? "—";
              return (
                <tr
                  key={r.id}
                  data-testid="error-log-row"
                  data-error-id={r.id}
                  onClick={() => setOpenId(r.id)}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                >
                  <td className="px-4 py-3 font-mono text-xs">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {sourceLabel[r.source] ?? r.source}
                  </td>
                  <td className="px-4 py-3">
                    <SeverityBadge severity={r.severity} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {r.error_code}
                  </td>
                  <td className="px-4 py-3">{truncate(r.message, 80)}</td>
                  <td className="px-4 py-3 text-xs">{profileName}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "text-[10px] uppercase font-mono px-1.5 py-0.5 rounded",
                        isResolved
                          ? "bg-success/15 text-success"
                          : "bg-amber-brand/15 text-amber-brand",
                      )}
                    >
                      {isResolved ? "Resolved" : "Open"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {!isResolved && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          // Stop the row's onClick from also opening the
                          // sheet — the inline resolve action is meant to
                          // be a one-click triage from the table.
                          e.stopPropagation();
                          markResolved(r.id);
                        }}
                        data-testid={`mark-resolved-${r.id}`}
                        disabled={submitting}
                      >
                        Mark resolved
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filteredRows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  {loading
                    ? "Loading…"
                    : showResolved
                      ? "No errors match the current filters."
                      : "No unresolved errors. All clear."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {current && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Bug className="w-4 h-4 text-amber-brand" />
                  <span className="font-mono text-xs">{current.error_code}</span>
                  <SeverityBadge severity={current.severity} />
                </SheetTitle>
                <div className="text-[10px] font-mono text-muted-foreground">
                  {new Date(current.created_at).toLocaleString()} ·{" "}
                  {sourceLabel[current.source] ?? current.source}
                </div>
              </SheetHeader>

              <div className="space-y-5 mt-6">
                <Section title="Message">
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">
                    {current.message}
                  </p>
                </Section>

                {current.stack && (
                  <Section title="Stack trace">
                    <pre className="text-[11px] font-mono bg-muted/40 border border-border rounded-md p-3 overflow-x-auto max-h-72">
                      {current.stack}
                    </pre>
                  </Section>
                )}

                <Section title="Context">
                  <pre className="text-[11px] font-mono bg-muted/40 border border-border rounded-md p-3 overflow-x-auto max-h-60">
                    {formatContext(current.context)}
                  </pre>
                </Section>

                <Section title="User">
                  <Row k="Name" v={current.profiles?.name ?? "—"} />
                  <Row k="Email" v={current.profiles?.email ?? "—"} />
                  <Row k="User ID" v={current.user_id ?? "—"} mono />
                  <Row k="Session" v={current.session_id ?? "—"} mono />
                </Section>

                <Section title="Origin">
                  <Row k="Function" v={current.function_name ?? "—"} mono />
                  <Row k="URL" v={current.url ?? "—"} mono />
                  <Row
                    k="User agent"
                    v={current.user_agent ? truncate(current.user_agent, 60) : "—"}
                    mono
                  />
                </Section>

                {current.resolved_at ? (
                  <Section title="Resolution">
                    <Row
                      k="Resolved at"
                      v={new Date(current.resolved_at).toLocaleString()}
                      mono
                    />
                    <Row k="Resolved by" v={current.resolved_by ?? "—"} mono />
                    {current.resolution_notes && (
                      <p className="text-sm text-foreground/90 mt-2 whitespace-pre-wrap">
                        {current.resolution_notes}
                      </p>
                    )}
                  </Section>
                ) : (
                  <Section title="Resolve">
                    <Label htmlFor="resolution-notes" className="text-xs">
                      Resolution notes
                    </Label>
                    <Textarea
                      id="resolution-notes"
                      placeholder="Briefly describe the fix or root cause…"
                      value={resolutionNotes}
                      onChange={(e) => setResolutionNotes(e.target.value)}
                      className="mt-2 min-h-[90px]"
                    />
                    <Button
                      className="w-full mt-3 h-10 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold"
                      onClick={() => markResolved(current.id)}
                      disabled={submitting}
                    >
                      {submitting ? "Saving…" : "Mark resolved"}
                    </Button>
                  </Section>
                )}

                {!USE_SUPABASE && (
                  <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded-md p-3">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      Supabase is not configured. Connect VITE_SUPABASE_URL to load real
                      error_log data.
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

// =============================================================================
// Dead-letter queue tab — surfaces public.dead_letter_submissions rows so the
// OfflineBanner's "Review failures" link actually shows the failures. Each row
// is a payload that exhausted offline-queue retries and was moved to the DLQ
// by api.moveToDeadLetter; clicking opens a Sheet with the full payload + a
// Requeue action that drops the item back into the local offline queue.
// =============================================================================
function DeadLetterTab() {
  const [rows, setRows] = useState<DeadLetterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [requeueing, setRequeueing] = useState(false);

  const load = useCallback(async () => {
    if (!USE_SUPABASE || !supabase) {
      // Mock-mode rows so the DLQ tab has something to act on without
      // a real Supabase connection (e2e + demo + designer review).
      setRows(MOCK_DLQ_ROWS);
      return;
    }
    setLoading(true);
    const { data, error } = await supabase
      .from("dead_letter_submissions")
      .select("*, profiles!dead_letter_submissions_user_id_fkey(name, email)")
      .order("moved_to_dead_letter_at", { ascending: false })
      .limit(100);
    if (error) {
      toast.error(`Failed to load dead-letter queue: ${error.message}`);
      setRows([]);
    } else {
      setRows((data ?? []) as unknown as DeadLetterRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const current = useMemo(
    () => (openId ? rows.find((r) => r.id === openId) ?? null : null),
    [openId, rows],
  );

  async function requeue(id: string) {
    // Mock-mode shortcut: api.requeueDeadLetter returns
    // { ok: false, reason: "supabase unavailable" } when supabase is
    // off, which would surface as a toast.error. For the in-memory
    // path we treat the click as success — the row is removed locally
    // and the operator gets a success toast so the UI is exercisable.
    if (!USE_SUPABASE || !supabase) {
      setRows((prev) => prev.filter((r) => r.id !== id));
      setOpenId(null);
      toast.success("Requeued (mock) — will retry on next flush");
      return;
    }
    setRequeueing(true);
    try {
      const result = await api.requeueDeadLetter(id);
      if (result.ok) {
        toast.success("Requeued — will retry on next flush");
        setOpenId(null);
        load();
      } else {
        toast.error(`Requeue failed: ${result.reason}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Requeue failed: ${msg}`);
    } finally {
      setRequeueing(false);
    }
  }

  if (!loading && rows.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-10 text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <Inbox className="w-8 h-8 mx-auto text-success mb-3" />
        <div className="text-sm font-semibold">
          All systems clear — no dead-letter submissions.
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          When a queued submission exhausts its retries it lands here for review.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]" data-testid="dlq-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {[
                "Moved to DLQ",
                "Kind",
                "Retries",
                "Last error",
                "Queued at",
                "User",
                "",
              ].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const profileName = r.profiles?.name ?? r.profiles?.email ?? "—";
              return (
                <tr
                  key={r.id}
                  data-testid="dlq-row"
                  data-dlq-id={r.id}
                  onClick={() => setOpenId(r.id)}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                >
                  <td className="px-4 py-3 font-mono text-xs">
                    {new Date(r.moved_to_dead_letter_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs font-mono">{r.kind}</td>
                  <td className="px-4 py-3 font-mono text-xs">{r.retry_count}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {truncate(r.last_error ?? "—", 80)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {new Date(r.queued_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-xs">{profileName}</td>
                  <td className="px-4 py-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        // Inline requeue from the row so admins can act
                        // without opening the sheet for every payload.
                        e.stopPropagation();
                        requeue(r.id);
                      }}
                      data-testid="dlq-requeue"
                      disabled={requeueing}
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Requeue
                    </Button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  {loading ? "Loading…" : "No rows."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {current && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Inbox className="w-4 h-4 text-amber-brand" />
                  <span className="font-mono text-xs">{current.kind}</span>
                  <span className="text-[10px] uppercase font-mono bg-danger/15 text-danger border border-danger/30 px-1.5 py-0.5 rounded">
                    {current.retry_count} retries
                  </span>
                </SheetTitle>
                <div className="text-[10px] font-mono text-muted-foreground">
                  moved {new Date(current.moved_to_dead_letter_at).toLocaleString()}
                </div>
              </SheetHeader>

              <div className="space-y-5 mt-6">
                <Section title="Timestamps">
                  <Row k="Queued at" v={new Date(current.queued_at).toLocaleString()} mono />
                  <Row
                    k="Last attempt"
                    v={
                      current.last_attempt_at
                        ? new Date(current.last_attempt_at).toLocaleString()
                        : "—"
                    }
                    mono
                  />
                  <Row
                    k="Moved to DLQ"
                    v={new Date(current.moved_to_dead_letter_at).toLocaleString()}
                    mono
                  />
                </Section>

                <Section title="User">
                  <Row k="Name" v={current.profiles?.name ?? "—"} />
                  <Row k="Email" v={current.profiles?.email ?? "—"} />
                  <Row k="User ID" v={current.user_id ?? "—"} mono />
                </Section>

                {current.last_error && (
                  <Section title="Last error">
                    <pre className="text-[11px] font-mono bg-muted/40 border border-border rounded-md p-3 overflow-x-auto max-h-72 whitespace-pre-wrap break-words">
                      {current.last_error}
                    </pre>
                  </Section>
                )}

                <Section title="Payload">
                  <pre className="text-[11px] font-mono bg-muted/40 border border-border rounded-md p-3 overflow-x-auto max-h-72">
                    {previewPayload(current.payload)}
                  </pre>
                </Section>

                <Section title="Actions">
                  <Button
                    className="w-full h-10 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold"
                    onClick={() => requeue(current.id)}
                    disabled={requeueing}
                    data-testid="dlq-requeue"
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    {requeueing ? "Requeueing…" : "Requeue"}
                  </Button>
                  <p className="text-[10px] text-muted-foreground mt-2">
                    Drops the payload back into the offline queue with
                    retryCount=0 and removes this row.
                  </p>
                </Section>

                {!USE_SUPABASE && (
                  <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded-md p-3">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      Supabase is not configured. Connect VITE_SUPABASE_URL to
                      load real dead_letter_submissions data.
                    </span>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
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

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm py-1">
      <span className="text-muted-foreground shrink-0">{k}</span>
      <span
        className={cn(
          "font-medium text-right break-all",
          mono && "font-mono text-xs",
        )}
      >
        {v}
      </span>
    </div>
  );
}
