// Receivables ledger (QuickBooks-optional billing). Every invoice with its
// sent / paid state in one place, so the office tracks who owes what without
// opening QuickBooks. Summary cards (outstanding / paid / overdue-ish),
// filter, mark-paid toggle, and CSV export for the accountant.

import { createFileRoute, Link } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Download, BadgeCheck, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { toCsv, downloadCsv } from "@/lib/csv";

export const Route = createFileRoute("/admin/receivables")({
  head: () => ({ meta: [{ title: "Receivables — Yardward Pro" }] }),
  component: Page,
});

type Row = {
  id: string;
  workOrderId: string;
  clientId: string;
  kind: string;
  total: number;
  sentAt: string | null;
  sentTo: string | null;
  paidAt: string | null;
  qboSyncStatus: string;
};

function Page() {
  const { clients } = useData();
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? id;
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"all" | "unpaid" | "paid">("all");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.fetchInvoiceLedger());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load receivables");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    let outstanding = 0;
    let paid = 0;
    for (const r of rows) {
      if (r.paidAt) paid += r.total;
      else outstanding += r.total;
    }
    return { outstanding, paid };
  }, [rows]);

  const filtered = rows.filter((r) =>
    tab === "all" ? true : tab === "paid" ? !!r.paidAt : !r.paidAt,
  );

  async function togglePaid(r: Row) {
    setBusyId(r.id);
    try {
      const res = await api.markInvoicePaid(r.id, !r.paidAt);
      if (!res.ok) {
        toast.error(res.reason);
        return;
      }
      setRows((xs) =>
        xs.map((x) =>
          x.id === r.id ? { ...x, paidAt: r.paidAt ? null : new Date().toISOString() } : x,
        ),
      );
    } finally {
      setBusyId(null);
    }
  }

  function exportCsv() {
    const csv = toCsv(
      ["Invoice", "Work order", "Client", "Kind", "Total", "Sent", "Sent to", "Paid", "QBO"],
      filtered.map((r) => [
        r.id,
        r.workOrderId,
        clientName(r.clientId),
        r.kind,
        r.total.toFixed(2),
        r.sentAt ?? "",
        r.sentTo ?? "",
        r.paidAt ?? "",
        r.qboSyncStatus,
      ]),
    );
    downloadCsv(`receivables-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    toast.success(`Exported ${filtered.length} invoices`);
  }

  return (
    <AdminShell title="Receivables">
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              Outstanding
            </div>
            <div className="text-2xl font-bold font-mono text-danger">
              ${totals.outstanding.toFixed(2)}
            </div>
          </div>
          <div className="bg-card border border-border rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Paid</div>
            <div className="text-2xl font-bold font-mono text-success">
              ${totals.paid.toFixed(2)}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="all">All ({rows.length})</TabsTrigger>
              <TabsTrigger value="unpaid">
                Unpaid ({rows.filter((r) => !r.paidAt).length})
              </TabsTrigger>
              <TabsTrigger value="paid">Paid ({rows.filter((r) => r.paidAt).length})</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={loading}>
            <Download className="w-4 h-4" /> Export CSV
          </Button>
        </div>

        <div className="bg-card border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Invoice</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium text-right">Total</th>
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin inline" />
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                    No invoices. Approve a work order to generate one, then email it from the
                    invoice page.
                  </td>
                </tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        to="/admin/invoices/$workOrderId"
                        params={{ workOrderId: r.workOrderId }}
                        className="text-amber-brand hover:underline inline-flex items-center gap-1"
                      >
                        {r.workOrderId} <ExternalLink className="w-3 h-3" />
                      </Link>
                    </td>
                    <td className="px-3 py-2">{clientName(r.clientId)}</td>
                    <td className="px-3 py-2 text-right font-mono font-medium">
                      ${r.total.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {r.sentAt ? new Date(r.sentAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {r.paidAt ? (
                        <span className="text-xs text-success">
                          Paid {new Date(r.paidAt).toLocaleDateString()}
                        </span>
                      ) : (
                        <span className="text-xs text-danger">Unpaid</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant={r.paidAt ? "outline" : "default"}
                        className={
                          r.paidAt
                            ? "h-7 text-xs"
                            : "h-7 text-xs bg-success text-white hover:bg-success/90"
                        }
                        disabled={busyId === r.id}
                        onClick={() => void togglePaid(r)}
                        data-testid={`receivable-toggle-${r.id}`}
                      >
                        <BadgeCheck className="w-3.5 h-3.5" />
                        {r.paidAt ? "Mark unpaid" : "Mark paid"}
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AdminShell>
  );
}
