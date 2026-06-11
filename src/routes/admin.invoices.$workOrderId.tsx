import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { clientById, jobById } from "@/data/mockData";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
  ArrowLeft,
  FileText,
  CheckCircle2,
  Loader2,
  XCircle,
  ExternalLink,
  Mail,
  BadgeCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin/invoices/$workOrderId")({
  head: () => ({ meta: [{ title: "Invoice preview — Engage Hydrovac CRM" }] }),
  component: Page,
});

function Page() {
  const { workOrderId } = useParams({ from: "/admin/invoices/$workOrderId" });
  const { workOrders, invoiceData } = useData();
  const wo = workOrders.find((w) => w.id === workOrderId);
  const inv = wo?.invoiceDataId
    ? invoiceData.find((i) => i.id === wo.invoiceDataId)
    : invoiceData.find((i) => i.workOrderId === workOrderId);
  const [pushing, setPushing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"pending" | "synced" | "failed">(
    inv?.qboSyncStatus === "synced" ? "synced" : "pending",
  );

  if (!wo)
    return (
      <AdminShell title="Invoice">
        <Link
          to="/admin/work-orders"
          className="inline-flex items-center gap-1 text-sm text-amber-brand"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <div className="mt-6 text-sm text-muted-foreground">Work order not found.</div>
      </AdminShell>
    );

  const job = jobById(wo.jobId);
  const client = job ? clientById(job.clientId) : null;
  const lineItems =
    inv?.lineItems ??
    (wo.weightTonnes > 0
      ? [
          {
            description: `${wo.loadType} haul`,
            qty: wo.weightTonnes,
            rate: 24,
            amount: wo.weightTonnes * 24,
          },
        ]
      : []);
  const total = lineItems.reduce((s, li) => s + li.amount, 0);

  async function push() {
    setPushing(true);
    try {
      await api.pushInvoiceToQbo(inv?.id ?? "preview");
      setSyncStatus("synced");
      toast.success("Pushed to QuickBooks");
    } catch (err) {
      setSyncStatus("failed");
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Push to QuickBooks failed: ${msg}`);
    } finally {
      setPushing(false);
    }
  }

  return (
    <AdminShell title="Invoice preview">
      <Link
        to="/admin/work-orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Back to work orders
      </Link>

      <div className="grid lg:grid-cols-[1fr_300px] gap-4">
        <div className="bg-card border border-border rounded-lg p-6 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="flex items-center justify-between border-b border-border pb-4 mb-4">
            <div>
              <h2 className="font-bold text-lg flex items-center gap-2">
                <FileText className="w-5 h-5" /> Invoice draft
              </h2>
              <div className="text-xs font-mono text-muted-foreground mt-0.5">
                Work order {wo.id}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                Total
              </div>
              <div className="font-mono font-bold text-2xl">${total.toFixed(2)}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mb-6">
            <div>
              <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                Bill to
              </div>
              <div className="font-semibold">{client?.name ?? "—"}</div>
              <div className="text-sm text-muted-foreground">{client?.billingAddress}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                Date
              </div>
              <div className="font-mono">{new Date().toLocaleDateString()}</div>
            </div>
          </div>

          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
              <tr>
                <th className="text-left font-medium py-2">Description</th>
                <th className="text-right font-medium py-2">Qty</th>
                <th className="text-right font-medium py-2">Rate</th>
                <th className="text-right font-medium py-2">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-3">{li.description}</td>
                  <td className="py-3 text-right font-mono">{li.qty}</td>
                  <td className="py-3 text-right font-mono">${li.rate.toFixed(2)}</td>
                  <td className="py-3 text-right font-mono font-medium">${li.amount.toFixed(2)}</td>
                </tr>
              ))}
              {lineItems.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-muted-foreground italic text-sm">
                    No billable items.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3} className="text-right py-3 font-semibold">
                  Total
                </td>
                <td className="text-right py-3 font-mono font-bold">${total.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="space-y-4">
          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="font-semibold text-sm mb-3">QuickBooks sync</h3>
            <div className="text-sm flex items-center gap-2">
              {syncStatus === "synced" && (
                <>
                  <CheckCircle2 className="w-4 h-4 text-success" />{" "}
                  <span className="text-success">Synced</span>
                </>
              )}
              {syncStatus === "pending" && (
                <>
                  <Loader2 className={`w-4 h-4 ${pushing ? "animate-spin" : ""}`} />{" "}
                  <span>Pending</span>
                </>
              )}
              {syncStatus === "failed" && (
                <>
                  <XCircle className="w-4 h-4 text-danger" />{" "}
                  <span className="text-danger">Failed</span>
                </>
              )}
            </div>
            {inv?.qboInvoiceId && (
              <div className="mt-2 text-xs text-muted-foreground font-mono">
                QBO ID: {inv.qboInvoiceId}
              </div>
            )}
            <Button
              disabled={pushing || syncStatus === "synced"}
              onClick={push}
              className="w-full mt-3 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              {pushing
                ? "Pushing…"
                : syncStatus === "synced"
                  ? "Already synced"
                  : "Push to QuickBooks"}
            </Button>
          </div>

          {inv && client && (
            <SendPaymentCard
              invoiceId={inv.id}
              workOrderId={wo.id}
              clientName={client.name}
              clientEmail={client.email}
              billingAddress={client.billingAddress}
              lineItems={lineItems}
              total={total}
            />
          )}

          {client && (
            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="font-semibold text-sm mb-2">Rate table applied</h3>
              <p className="text-xs text-muted-foreground">
                {client.rateTableId
                  ? `Using ${client.rateTableId}`
                  : "No client-specific rates. Default $24/t applied."}
              </p>
              <Link
                to="/admin/clients"
                className="inline-flex items-center gap-1 text-xs text-amber-brand mt-2 hover:underline"
              >
                View client rate table
                <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
          )}
        </div>
      </div>
    </AdminShell>
  );
}

// Standalone invoicing: email the branded invoice straight to the client and
// track sent/paid in the CRM — QuickBooks push remains available but is no
// longer required to bill a client.
function SendPaymentCard(props: {
  invoiceId: string;
  workOrderId: string;
  clientName: string;
  clientEmail: string;
  billingAddress: string;
  lineItems: Array<{ description: string; qty: number; rate: number; amount: number }>;
  total: number;
}) {
  const [to, setTo] = useState(props.clientEmail);
  const [meta, setMeta] = useState<{
    sentAt: string | null;
    sentTo: string | null;
    paidAt: string | null;
  }>({
    sentAt: null,
    sentTo: null,
    paidAt: null,
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .fetchInvoiceMeta(props.invoiceId)
      .then(setMeta)
      .catch(() => {});
  }, [props.invoiceId]);

  async function send() {
    if (!/^\S+@\S+\.\S+$/.test(to.trim())) {
      toast.error("Enter a valid email address");
      return;
    }
    setBusy(true);
    try {
      const r = await api.emailInvoice({
        invoiceId: props.invoiceId,
        to: to.trim(),
        clientName: props.clientName,
        billingAddress: props.billingAddress,
        workOrderId: props.workOrderId,
        lineItems: props.lineItems,
        total: props.total,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`Invoice emailed to ${to.trim()}`);
      setMeta((m) => ({ ...m, sentAt: new Date().toISOString(), sentTo: to.trim() }));
    } finally {
      setBusy(false);
    }
  }

  async function togglePaid() {
    setBusy(true);
    try {
      const next = !meta.paidAt;
      const r = await api.markInvoicePaid(props.invoiceId, next);
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      setMeta((m) => ({ ...m, paidAt: next ? new Date().toISOString() : null }));
      toast.success(next ? "Marked paid" : "Marked unpaid");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3">
      <h3 className="font-semibold text-sm">Send & payment</h3>
      <div className="flex gap-2">
        <Input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="client@email.com"
          className="h-9 text-sm"
          data-testid="invoice-email-to"
        />
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={busy}
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 shrink-0"
          data-testid="invoice-email-send"
        >
          <Mail className="w-4 h-4" /> Email
        </Button>
      </div>
      {meta.sentAt && (
        <p className="text-xs text-muted-foreground">
          Sent to {meta.sentTo} · {new Date(meta.sentAt).toLocaleString()}
        </p>
      )}
      <Button
        size="sm"
        variant={meta.paidAt ? "outline" : "default"}
        onClick={() => void togglePaid()}
        disabled={busy}
        className={meta.paidAt ? "w-full" : "w-full bg-success text-white hover:bg-success/90"}
        data-testid="invoice-mark-paid"
      >
        <BadgeCheck className="w-4 h-4" />
        {meta.paidAt
          ? `Paid ${new Date(meta.paidAt).toLocaleDateString()} — mark unpaid`
          : "Mark paid"}
      </Button>
    </div>
  );
}
