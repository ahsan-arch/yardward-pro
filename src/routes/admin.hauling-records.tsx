// Hauling records imported from Formstack (dump forms / bills of lading).
//
// Data lands in formstack_submissions via the formstack-import edge function;
// this page is read + sync-trigger only. Each client has its own Formstack
// form (EHS Dump Form, Brass Inc. Hauling Record, ...), so the primary
// filter is by form. Field layouts differ per form — the detail sheet
// renders the standardized label/value pairs rather than fixed columns.

import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { api, type FormstackSubmissionRow } from "@/lib/api";
import type { DumpLog } from "@/types/domain";
import { useData } from "@/contexts/DataContext";
import { useApp } from "@/contexts/AppContext";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  RefreshCw,
  Search,
  FlaskConical,
  AlertCircle,
  Download,
  Printer,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { toCsv, downloadCsv, openPrintView, escapeHtml } from "@/lib/csv";

export const Route = createFileRoute("/admin/hauling-records")({
  head: () => ({ meta: [{ title: "Hauling records — Engage Hydrovac CRM" }] }),
  component: Page,
});

const PAGE_SIZE = 50;

// Internal (EHS staff) recipients notified on every client-portal submission
// — the "John / yard guy / Nick get a text" list from the requirements.
// Per-client recipients (gate guard, receiving facility) are edited on the
// client itself (Clients → Dump-form portal).
function InternalNotifyEditor() {
  const [sms, setSms] = useState("");
  const [emails, setEmails] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.fetchPortalNotifySettings();
        setSms(r.sms.join("\n"));
        setEmails(r.emails.join("\n"));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load notify settings");
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function save() {
    setBusy(true);
    try {
      const r = await api.updatePortalNotifySettings({
        sms: sms.split("\n"),
        emails: emails.split("\n"),
      });
      if (r.ok) toast.success("Internal notification recipients saved");
      else toast.error(r.reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Internal notifications</h3>
        <p className="text-xs text-muted-foreground">
          EHS staff notified on every client-portal submission (in addition to the per-client
          recipients set on each client).
        </p>
      </div>
      {!loaded ? (
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">SMS numbers (E.164, one per line)</Label>
              <Textarea
                value={sms}
                onChange={(e) => setSms(e.target.value)}
                rows={3}
                className="mt-1 font-mono text-xs"
                placeholder={"+14165550100"}
                data-testid="internal-notify-sms"
              />
            </div>
            <div>
              <Label className="text-xs">Emails (one per line)</Label>
              <Textarea
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                rows={3}
                className="mt-1 font-mono text-xs"
                placeholder={"yard@engagehydrovac.com"}
                data-testid="internal-notify-emails"
              />
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void save()}
            disabled={busy}
            data-testid="internal-notify-save"
          >
            Save recipients
          </Button>
        </>
      )}
    </div>
  );
}

type SyncSummary = {
  dryRun: boolean;
  totalFetched: number;
  totalUpserted: number;
  failedForms: Array<{ formName: string; error: string }>;
  durationMs: number;
};

function Page() {
  // "formstack" = imported history (synced via formstack-import);
  // "app" = native dump_logs captured by drivers in /driver/dump-log.
  const [source, setSource] = useState<"formstack" | "app">("formstack");
  const { drivers, clients } = useData();
  const { user } = useApp();
  const driverName = (id: string) => drivers.find((d) => d.id === id)?.name ?? id.slice(0, 8);
  const clientName = (id: string | null) =>
    (id && clients.find((c) => c.id === id)?.name) || "Unknown client";
  const [approving, setApproving] = useState<string | null>(null);

  async function approve(id: string) {
    setApproving(id);
    try {
      const r = await api.approveDumpLog({ id, approverName: user.name });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success("Disposal approved");
      setDumpRows((rows) =>
        rows.map((x) =>
          x.id === id
            ? {
                ...x,
                status: "approved",
                approvedBy: user.name,
                approvedAt: new Date().toISOString(),
              }
            : x,
        ),
      );
    } finally {
      setApproving(null);
    }
  }
  const [dumpRows, setDumpRows] = useState<DumpLog[]>([]);
  const [dumpTotal, setDumpTotal] = useState(0);
  const [dumpPage, setDumpPage] = useState(0);
  const [rows, setRows] = useState<FormstackSubmissionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<
    Array<{ formId: number; formName: string; submissionCount: number }>
  >([]);
  const [formId, setFormId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [openRow, setOpenRow] = useState<FormstackSubmissionRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, fx] = await Promise.all([
        api.fetchFormstackSubmissions({
          formId: formId ?? undefined,
          search: search || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
        api.fetchFormstackFormFacets(),
      ]);
      setRows(list.rows);
      setTotal(list.total);
      setFacets(fx);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load hauling records");
    } finally {
      setLoading(false);
    }
  }, [formId, search, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDumpLogs = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.fetchDumpLogs({ limit: PAGE_SIZE, offset: dumpPage * PAGE_SIZE });
      setDumpRows(r.rows);
      setDumpTotal(r.total);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load app hauling records");
    } finally {
      setLoading(false);
    }
  }, [dumpPage]);

  useEffect(() => {
    if (source === "app") void loadDumpLogs();
  }, [source, loadDumpLogs]);

  async function runSync(dryRun: boolean) {
    setSyncing(true);
    setSyncSummary(null);
    try {
      // The edge function caps each invocation at ~100s of work and returns
      // partial=true with the forms it didn't reach. Loop until everything
      // is covered — per-form high-water marks make each round idempotent.
      const totals = { fetched: 0, upserted: 0, durationMs: 0 };
      const failedForms: Array<{ formName: string; error: string }> = [];
      let formIds: number[] | undefined;
      const MAX_ROUNDS = 25;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const r = await api.importFromFormstack({ dryRun, formIds });
        if (!r.ok) {
          toast.error(r.reason);
          if (round === 0) return;
          break; // keep what earlier rounds accomplished visible
        }
        totals.fetched += r.totalFetched;
        totals.upserted += r.totalUpserted;
        totals.durationMs += r.durationMs;
        failedForms.push(
          ...r.forms
            .filter((f) => f.error)
            .map((f) => ({ formName: f.formName, error: f.error ?? "" })),
        );
        if (!r.partial || !r.remainingFormIds?.length) break;
        formIds = r.remainingFormIds;
        toast.info(`Sync continuing — ${r.remainingFormIds.length} forms left…`, {
          duration: 4000,
        });
      }
      setSyncSummary({
        dryRun,
        totalFetched: totals.fetched,
        totalUpserted: totals.upserted,
        failedForms,
        durationMs: totals.durationMs,
      });
      if (dryRun) {
        toast.success(`Dry run: ${totals.fetched} new submissions would be imported`);
      } else {
        toast.success(`Imported ${totals.upserted} submissions`);
        setPage(0);
        await load();
      }
    } finally {
      setSyncing(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [exporting, setExporting] = useState(false);

  // CSV export — pages through everything matching the current view. When a
  // single Formstack form is selected, its field labels become columns (all
  // rows share a schema); across all forms the summary column stands in.
  async function exportCsv() {
    setExporting(true);
    try {
      const EXPORT_CAP = 20000;
      if (source === "app") {
        const all: DumpLog[] = [];
        for (let off = 0; off < EXPORT_CAP; off += 200) {
          const r = await api.fetchDumpLogs({ limit: 200, offset: off });
          all.push(...r.rows);
          if (all.length >= r.total) break;
        }
        const csv = toCsv(
          [
            "Code",
            "Logged",
            "Source",
            "Client",
            "Driver",
            "Truck",
            "Load",
            "Quantity",
            "Weight",
            "From",
            "To",
            "Status",
            "Approved by",
            "GPS lat",
            "GPS lng",
          ],
          all.map((r) => [
            r.submissionCode,
            r.loggedAt,
            r.source,
            r.clientId ? clientName(r.clientId) : "",
            r.source === "client-portal" ? r.submittedName : driverName(r.driverId ?? ""),
            r.truckNumber || r.vehicleId || "",
            r.loadType,
            r.quantity,
            r.weight,
            r.location,
            r.receivingSite,
            r.status,
            r.approvedBy,
            r.gpsLat,
            r.gpsLng,
          ]),
        );
        downloadCsv(`hauling-records-app-${new Date().toISOString().slice(0, 10)}.csv`, csv);
        toast.success(`Exported ${all.length} records`);
      } else {
        const all: FormstackSubmissionRow[] = [];
        for (let off = 0; off < EXPORT_CAP; off += 200) {
          const r = await api.fetchFormstackSubmissions({
            formId: formId ?? undefined,
            search: search || undefined,
            limit: 200,
            offset: off,
          });
          all.push(...r.rows);
          if (all.length >= r.total) break;
        }
        if (formId) {
          // Single form: union of field labels becomes the column set.
          const labels: string[] = [];
          for (const row of all) {
            for (const f of row.data) {
              const l = (f.label ?? f.field ?? "").toString();
              if (l && !labels.includes(l)) labels.push(l);
            }
          }
          const csv = toCsv(
            ["Submission ID", "Submitted", "Form", ...labels],
            all.map((r) => [
              r.submissionId,
              r.submittedAt,
              r.formName,
              ...labels.map((l) => {
                const f = r.data.find((x) => (x.label ?? x.field ?? "").toString() === l);
                return (f?.displayValue ?? "").toString();
              }),
            ]),
          );
          downloadCsv(`formstack-${formId}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
        } else {
          const csv = toCsv(
            ["Submission ID", "Submitted", "Form", "Summary"],
            all.map((r) => [r.submissionId, r.submittedAt, r.formName, r.summary]),
          );
          downloadCsv(`formstack-all-${new Date().toISOString().slice(0, 10)}.csv`, csv);
        }
        toast.success(`Exported ${all.length} submissions`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  // Branded print view ("PDF with our logo") for a single record.
  function printFormstackRow(r: FormstackSubmissionRow) {
    const rows = r.data
      .filter((f) => (f.displayValue ?? "").toString().trim())
      .map(
        (f) =>
          `<tr><td>${escapeHtml((f.label ?? f.field ?? "").toString())}</td><td>${escapeHtml((f.displayValue ?? "").toString())}</td></tr>`,
      )
      .join("");
    openPrintView(
      `${r.formName} — ${r.submissionId}`,
      `<h2 style="margin:0 0 4px 0;font-size:18px;">${escapeHtml(r.formName)}</h2>
       <p style="margin:0 0 16px 0;color:#666;font-size:13px;">Submission ${r.submissionId} · ${r.submittedAt ? new Date(r.submittedAt).toLocaleString() : ""}</p>
       <table>${rows}</table>`,
    );
  }

  function printDumpRow(r: DumpLog) {
    const fields: Array<[string, string]> = [
      ["Confirmation code", r.submissionCode ?? "—"],
      ["Submitted", new Date(r.loggedAt).toLocaleString()],
      ["Company", r.clientId ? clientName(r.clientId) : "Engage Hydrovac Services"],
      ["Driver", r.source === "client-portal" ? r.submittedName : driverName(r.driverId ?? "")],
      ["Truck", r.truckNumber || r.vehicleId || "—"],
      ["Load type", r.loadType],
      ["Quantity", r.quantity || "—"],
      ["Weight", r.weight || "—"],
      ["Loading location", r.location],
      ["Receiving site", r.receivingSite || "—"],
      ["GPS", r.gpsLat != null && r.gpsLng != null ? `${r.gpsLat}, ${r.gpsLng}` : "—"],
      ["Status", r.status === "approved" ? `Approved by ${r.approvedBy ?? ""}` : r.status],
      ...(r.notes ? ([["Notes", r.notes]] as Array<[string, string]>) : []),
    ];
    openPrintView(
      `Hauling record ${r.submissionCode ?? r.id}`,
      `<h2 style="margin:0 0 16px 0;font-size:18px;">Dump / Load Form</h2>
       <table>${fields.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</table>`,
    );
  }

  return (
    <AdminShell title="Hauling records">
      <div className="space-y-4">
        <Tabs value={source} onValueChange={(v) => setSource(v as "formstack" | "app")}>
          <TabsList>
            <TabsTrigger value="formstack" data-testid="hauling-tab-formstack">
              Formstack history
            </TabsTrigger>
            <TabsTrigger value="app" data-testid="hauling-tab-app">
              App entries
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {source === "app" ? (
          <>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm text-muted-foreground flex-1">
                Hauling records submitted by drivers in the app (Forms → Hauling record) and by
                client drivers via their portal links. New records land here — Formstack is only the
                historical archive.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void exportCsv()}
                disabled={exporting || loading}
                data-testid="hauling-export-app"
              >
                {exporting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span className="ml-1">Export CSV</span>
              </Button>
            </div>
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Logged</th>
                    <th className="px-3 py-2 font-medium">Code</th>
                    <th className="px-3 py-2 font-medium">Client / Driver</th>
                    <th className="px-3 py-2 font-medium">Truck</th>
                    <th className="px-3 py-2 font-medium">Load</th>
                    <th className="px-3 py-2 font-medium">Qty / Weight</th>
                    <th className="px-3 py-2 font-medium">From → To</th>
                    <th className="px-3 py-2 font-medium">GPS</th>
                    <th className="px-3 py-2 font-medium">Yard sign-off</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                        <Loader2 className="w-5 h-5 animate-spin inline" />
                      </td>
                    </tr>
                  ) : dumpRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">
                        No app-submitted hauling records yet. Staff create them under Forms →
                        Hauling record; client drivers submit via their portal links (Clients →
                        Dump-form portal).
                      </td>
                    </tr>
                  ) : (
                    dumpRows.map((r) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                          {new Date(r.loggedAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-amber-brand">
                          {r.submissionCode ?? "—"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {r.source === "client-portal" ? (
                            <>
                              <span className="font-medium">{clientName(r.clientId)}</span>
                              <span className="text-muted-foreground"> · {r.submittedName}</span>
                            </>
                          ) : (
                            driverName(r.driverId ?? "")
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                          {r.truckNumber || r.vehicleId || "—"}
                        </td>
                        <td className="px-3 py-2">{r.loadType}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {[r.quantity, r.weight].filter(Boolean).join(" / ") || "—"}
                        </td>
                        <td className="px-3 py-2 max-w-md truncate text-muted-foreground">
                          {r.location}
                          {r.receivingSite ? ` → ${r.receivingSite}` : ""}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {r.gpsLat != null && r.gpsLng != null ? (
                            <a
                              href={`https://maps.google.com/?q=${r.gpsLat},${r.gpsLng}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-amber-brand hover:underline"
                            >
                              map
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => printDumpRow(r)}
                            className="inline-flex mr-2 text-muted-foreground hover:text-foreground align-middle"
                            title="Print / Save PDF"
                            data-testid={`hauling-print-${r.submissionCode ?? r.id}`}
                          >
                            <Printer className="w-3.5 h-3.5" />
                          </button>
                          {r.status === "approved" ? (
                            <span className="text-xs text-success" title={r.approvedAt ?? ""}>
                              ✓ {r.approvedBy ?? "approved"}
                            </span>
                          ) : r.source === "client-portal" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={approving === r.id}
                              onClick={() => void approve(r.id)}
                              data-testid={`hauling-approve-${r.submissionCode ?? r.id}`}
                            >
                              {approving === r.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                "Approve disposal"
                              )}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {dumpTotal} record{dumpTotal === 1 ? "" : "s"}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={dumpPage === 0 || loading}
                  onClick={() => setDumpPage((p) => Math.max(0, p - 1))}
                >
                  Prev
                </Button>
                <span>
                  Page {dumpPage + 1} / {Math.max(1, Math.ceil(dumpTotal / PAGE_SIZE))}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(dumpPage + 1) * PAGE_SIZE >= dumpTotal || loading}
                  onClick={() => setDumpPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
            <InternalNotifyEditor />
          </>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-48">
                <Search className="w-4 h-4 absolute left-2.5 top-2.5 text-muted-foreground" />
                <Input
                  placeholder="Search summary / form name…"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  className="pl-8"
                  data-testid="hauling-search"
                />
              </div>
              <Select
                value={formId === null ? "all" : String(formId)}
                onValueChange={(v) => {
                  setFormId(v === "all" ? null : Number(v));
                  setPage(0);
                }}
              >
                <SelectTrigger className="w-72" data-testid="hauling-form-filter">
                  <SelectValue placeholder="All forms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    All forms ({facets.reduce((a, f) => a + f.submissionCount, 0)})
                  </SelectItem>
                  {facets.map((f) => (
                    <SelectItem key={f.formId} value={String(f.formId)}>
                      {f.formName} ({f.submissionCount})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={() => void runSync(true)}
                disabled={syncing}
                data-testid="hauling-dry-run"
              >
                {syncing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FlaskConical className="w-4 h-4" />
                )}
                <span className="ml-1">Dry run</span>
              </Button>
              <Button
                onClick={() => void runSync(false)}
                disabled={syncing}
                data-testid="hauling-sync"
                className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
              >
                {syncing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                <span className="ml-1">Sync from Formstack</span>
              </Button>
              <Button
                variant="outline"
                onClick={() => void exportCsv()}
                disabled={exporting || loading}
                data-testid="hauling-export-formstack"
                title={
                  formId
                    ? "Exports the selected form with its full field columns"
                    : "Select a single form to export full field columns"
                }
              >
                {exporting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                <span className="ml-1">Export CSV</span>
              </Button>
            </div>

            {/* Sync result panel */}
            {syncSummary && (
              <div
                className="bg-muted/40 border border-border rounded-md p-3 text-sm space-y-1"
                data-testid="hauling-sync-summary"
              >
                <p>
                  {syncSummary.dryRun ? "Dry run — nothing written. " : ""}
                  Fetched <span className="font-semibold">{syncSummary.totalFetched}</span> new
                  submission{syncSummary.totalFetched === 1 ? "" : "s"}
                  {!syncSummary.dryRun && (
                    <>
                      , imported <span className="font-semibold">{syncSummary.totalUpserted}</span>
                    </>
                  )}{" "}
                  in {(syncSummary.durationMs / 1000).toFixed(1)}s.
                </p>
                {syncSummary.failedForms.map((f) => (
                  <p key={f.formName} className="text-danger text-xs flex items-start gap-1">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    {f.formName}: {f.error}
                  </p>
                ))}
              </div>
            )}

            {/* Table */}
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Submitted</th>
                    <th className="px-3 py-2 font-medium">Form</th>
                    <th className="px-3 py-2 font-medium">Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-8 text-center text-muted-foreground">
                        <Loader2 className="w-5 h-5 animate-spin inline" />
                      </td>
                    </tr>
                  ) : rows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-8 text-center text-muted-foreground">
                        No hauling records yet. Click{" "}
                        <span className="font-medium">Sync from Formstack</span> to import (use Dry
                        run first to preview).
                      </td>
                    </tr>
                  ) : (
                    rows.map((r) => (
                      <tr
                        key={r.id}
                        className="border-t border-border hover:bg-muted/30 cursor-pointer"
                        onClick={() => setOpenRow(r)}
                        data-testid={`hauling-row-${r.submissionId}`}
                      >
                        <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                          {r.submittedAt ? new Date(r.submittedAt).toLocaleString() : "—"}
                        </td>
                        <td className="px-3 py-2 max-w-56 truncate">{r.formName}</td>
                        <td className="px-3 py-2 max-w-xl truncate text-muted-foreground">
                          {r.summary || "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {total} record{total === 1 ? "" : "s"}
                {formId !== null || search ? " (filtered)" : ""}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0 || loading}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Prev
                </Button>
                <span>
                  Page {page + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page + 1 >= totalPages || loading}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Detail sheet */}
      <Sheet open={!!openRow} onOpenChange={(o) => !o && setOpenRow(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>
              {openRow?.formName}
              <span className="block text-xs font-normal text-muted-foreground mt-1">
                Submission {openRow?.submissionId} ·{" "}
                {openRow?.submittedAt ? new Date(openRow.submittedAt).toLocaleString() : "no date"}
              </span>
            </SheetTitle>
          </SheetHeader>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => openRow && printFormstackRow(openRow)}
            data-testid="formstack-print"
          >
            <Printer className="w-4 h-4" /> Print / Save PDF
          </Button>
          <div className="mt-4 space-y-3">
            {(openRow?.data ?? []).map((f, i) => {
              const value = (f.displayValue ?? "").toString().trim();
              if (!value) return null;
              return (
                <div key={f.field ?? i} className="border-b border-border pb-2">
                  <div className="text-xs text-muted-foreground">{f.label ?? f.field}</div>
                  <div className="text-sm whitespace-pre-wrap">{value}</div>
                </div>
              );
            })}
            {(openRow?.data ?? []).every((f) => !(f.displayValue ?? "").toString().trim()) && (
              <p className="text-sm text-muted-foreground">
                No field data captured for this submission.
              </p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </AdminShell>
  );
}
