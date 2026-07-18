// Core returns / surcharge credit audit trail.
//
// Client feedback (Parts, page 6): "A customer returns a pump. It has a
// core value. The pump is returned to the supplier. The supplier issues a
// credit. I need the system to track every stage automatically until the
// credit is received and applied e.g. Returns Note printed and logged in
// the system, when the credit is received a way to balance that credit to
// zero without affecting the stock, a listing/record of the outstanding
// credits with RTS notes etc."
//
// Three-stage lifecycle per row: received -> returned_to_supplier ->
// credited. Deliberately never touches inventory_items.qty_on_hand — this
// is a financial/paper trail, not a stock movement.

import { useMemo, useState } from "react";
import { useData } from "@/contexts/DataContext";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Printer, PackageCheck, Truck, CircleDollarSign } from "lucide-react";
import { toast } from "sonner";
import { openPrintView, escapeHtml } from "@/lib/csv";
import type { CoreReturn } from "@/types/domain";

const NO_ITEM = "__none__";

const STATUS_STYLE: Record<CoreReturn["status"], string> = {
  received: "bg-muted text-muted-foreground border-border",
  returned_to_supplier: "bg-amber-brand/15 text-amber-brand border-amber-brand/40",
  credited: "bg-success/15 text-success border-success/30",
};
const STATUS_LABEL: Record<CoreReturn["status"], string> = {
  received: "Received",
  returned_to_supplier: "Returned to supplier",
  credited: "Credited",
};

function StatusChip({ status }: { status: CoreReturn["status"] }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function printReturnsNote(cr: CoreReturn) {
  openPrintView(
    `Returns note — ${cr.id}`,
    `
    <h2 style="margin:0 0 4px 0;font-size:18px;">Core Returns Note</h2>
    <p style="margin:0 0 16px 0;color:#666;font-size:13px;">${escapeHtml(cr.id)}</p>
    <table>
      <tr><td>Part</td><td>${escapeHtml(cr.partDescription)}</td></tr>
      <tr><td>Customer</td><td>${escapeHtml(cr.customerName || "—")}</td></tr>
      <tr><td>Core value</td><td>$${cr.coreValue.toFixed(2)}</td></tr>
      <tr><td>Received</td><td>${escapeHtml(cr.receivedAt)}</td></tr>
      <tr><td>Supplier</td><td>${escapeHtml(cr.supplierId || "—")}</td></tr>
      <tr><td>RTS reference</td><td>${escapeHtml(cr.rtsReference || "—")}</td></tr>
      <tr><td>Sent to supplier</td><td>${cr.rtsAt ? escapeHtml(new Date(cr.rtsAt).toLocaleString()) : "—"}</td></tr>
      <tr><td>Status</td><td>${escapeHtml(STATUS_LABEL[cr.status])}</td></tr>
      <tr><td>Credit amount</td><td>${cr.creditAmount != null ? `$${cr.creditAmount.toFixed(2)}` : "—"}</td></tr>
      <tr><td>Credited</td><td>${cr.creditedAt ? escapeHtml(new Date(cr.creditedAt).toLocaleString()) : "—"}</td></tr>
      <tr><td>Notes</td><td>${escapeHtml(cr.notes || "—")}</td></tr>
    </table>
    `,
  );
}

export function CoreReturnsPanel() {
  const { coreReturns, inventoryItems, addCoreReturn, patchCoreReturn } = useData();
  const [filter, setFilter] = useState<"outstanding" | "all" | "credited">("outstanding");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const outstandingCount = useMemo(
    () => coreReturns.filter((c) => c.status !== "credited").length,
    [coreReturns],
  );
  const outstandingValue = useMemo(
    () =>
      coreReturns
        .filter((c) => c.status !== "credited")
        .reduce((sum, c) => sum + c.coreValue, 0),
    [coreReturns],
  );

  const rows = useMemo(() => {
    if (filter === "outstanding") return coreReturns.filter((c) => c.status !== "credited");
    if (filter === "credited") return coreReturns.filter((c) => c.status === "credited");
    return coreReturns;
  }, [coreReturns, filter]);

  const detail = detailId ? coreReturns.find((c) => c.id === detailId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <TabsList>
              <TabsTrigger value="outstanding" data-testid="cr-tab-outstanding">
                Outstanding ({outstandingCount})
              </TabsTrigger>
              <TabsTrigger value="credited" data-testid="cr-tab-credited">
                Credited
              </TabsTrigger>
              <TabsTrigger value="all" data-testid="cr-tab-all">
                All
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {outstandingCount > 0 && (
            <span className="text-xs text-muted-foreground">
              ${outstandingValue.toFixed(2)} in outstanding core value
            </span>
          )}
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          data-testid="cr-new"
        >
          <Plus className="w-4 h-4" /> Log core return
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["ID", "Part", "Customer", "Core value", "Supplier", "RTS ref", "Status"].map(
                (h) => (
                  <th key={h} className="text-left font-medium px-4 py-3">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.id}
                onClick={() => setDetailId(c.id)}
                className="border-t border-border hover:bg-muted/30 cursor-pointer"
                data-testid={`cr-row-${c.id}`}
              >
                <td className="px-4 py-3 font-mono text-xs text-amber-brand">{c.id}</td>
                <td className="px-4 py-3 max-w-xs truncate">{c.partDescription}</td>
                <td className="px-4 py-3 text-muted-foreground">{c.customerName || "—"}</td>
                <td className="px-4 py-3 font-mono">${c.coreValue.toFixed(2)}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {c.supplierId || "—"}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {c.rtsReference || "—"}
                </td>
                <td className="px-4 py-3">
                  <StatusChip status={c.status} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No core returns in this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <CreateCoreReturnDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        inventoryItems={inventoryItems}
        onSaved={addCoreReturn}
      />

      <Sheet open={!!detailId} onOpenChange={(o) => !o && setDetailId(null)}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {detail && (
            <CoreReturnDetail
              cr={detail}
              onPatched={(patch) => patchCoreReturn(detail.id, patch)}
              onClose={() => setDetailId(null)}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
        {k}
      </div>
      <div className="mt-0.5 text-sm">{v}</div>
    </div>
  );
}

function CoreReturnDetail({
  cr,
  onPatched,
  onClose,
}: {
  cr: CoreReturn;
  onPatched: (patch: Partial<CoreReturn>) => void;
  onClose: () => void;
}) {
  const [supplierId, setSupplierId] = useState(cr.supplierId ?? "");
  const [rtsReference, setRtsReference] = useState(cr.rtsReference);
  const [rtsDate, setRtsDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [creditAmount, setCreditAmount] = useState(String(cr.coreValue));
  const [creditDate, setCreditDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  async function sendToSupplier() {
    if (!supplierId.trim() || !rtsReference.trim()) {
      toast.error("Supplier and RTS reference are required");
      return;
    }
    setSaving(true);
    try {
      const rtsAt = new Date(rtsDate).toISOString();
      const r = await api.updateCoreReturn(cr.id, {
        status: "returned_to_supplier",
        supplierId: supplierId.trim(),
        rtsReference: rtsReference.trim(),
        rtsAt,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      onPatched({
        status: "returned_to_supplier",
        supplierId: supplierId.trim(),
        rtsReference: rtsReference.trim(),
        rtsAt,
      });
      toast.success("Marked returned to supplier");
    } finally {
      setSaving(false);
    }
  }

  async function markCredited() {
    const amt = Number(creditAmount);
    if (!Number.isFinite(amt) || amt < 0) {
      toast.error("Enter a non-negative credit amount");
      return;
    }
    setSaving(true);
    try {
      const creditedAt = new Date(creditDate).toISOString();
      const r = await api.updateCoreReturn(cr.id, {
        status: "credited",
        creditAmount: amt,
        creditedAt,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      onPatched({ status: "credited", creditAmount: amt, creditedAt });
      toast.success("Credit balanced to zero");
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-mono text-base">{cr.id}</SheetTitle>
      </SheetHeader>
      <div className="space-y-4 mt-6">
        <div className="flex items-center justify-between">
          <StatusChip status={cr.status} />
          <Button variant="outline" size="sm" onClick={() => printReturnsNote(cr)}>
            <Printer className="w-3.5 h-3.5" /> Print returns note
          </Button>
        </div>
        <Field k="Part" v={cr.partDescription} />
        <Field k="Customer" v={cr.customerName || "—"} />
        <Field k="Core value" v={`$${cr.coreValue.toFixed(2)}`} />
        <Field k="Received" v={cr.receivedAt} />
        {cr.notes && <Field k="Notes" v={cr.notes} />}

        {cr.status === "received" && (
          <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/20">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Truck className="w-4 h-4" /> Send to supplier
            </div>
            <div>
              <Label className="text-xs">Supplier</Label>
              <Input
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                placeholder="e.g. SUP-01"
                className="mt-1 font-mono"
              />
            </div>
            <div>
              <Label className="text-xs">RTS reference</Label>
              <Input
                value={rtsReference}
                onChange={(e) => setRtsReference(e.target.value)}
                placeholder="e.g. RTS-2025-0142"
                className="mt-1 font-mono"
              />
            </div>
            <div>
              <Label className="text-xs">Date sent</Label>
              <Input
                type="date"
                value={rtsDate}
                onChange={(e) => setRtsDate(e.target.value)}
                className="mt-1"
              />
            </div>
            <Button
              onClick={() => void sendToSupplier()}
              disabled={saving}
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
              data-testid="cr-send-to-supplier"
            >
              <Truck className="w-4 h-4" /> Mark returned to supplier
            </Button>
          </div>
        )}

        {cr.status === "returned_to_supplier" && (
          <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/20">
            <Field k="Supplier" v={cr.supplierId || "—"} />
            <Field k="RTS reference" v={cr.rtsReference || "—"} />
            <div className="flex items-center gap-1.5 text-sm font-medium pt-1">
              <CircleDollarSign className="w-4 h-4" /> Mark credit received
            </div>
            <div>
              <Label className="text-xs">Credit amount</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={creditAmount}
                onChange={(e) => setCreditAmount(e.target.value)}
                className="mt-1 font-mono"
              />
            </div>
            <div>
              <Label className="text-xs">Date credited</Label>
              <Input
                type="date"
                value={creditDate}
                onChange={(e) => setCreditDate(e.target.value)}
                className="mt-1"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Balances this core to zero — stock levels are not affected.
            </p>
            <Button
              onClick={() => void markCredited()}
              disabled={saving}
              className="w-full bg-success text-success-foreground hover:bg-success/90"
              data-testid="cr-mark-credited"
            >
              <PackageCheck className="w-4 h-4" /> Mark credit received
            </Button>
          </div>
        )}

        {cr.status === "credited" && (
          <div className="rounded-lg border border-success/40 bg-success/10 p-3 space-y-2">
            <Field k="Supplier" v={cr.supplierId || "—"} />
            <Field k="RTS reference" v={cr.rtsReference || "—"} />
            <Field k="Credit amount" v={cr.creditAmount != null ? `$${cr.creditAmount.toFixed(2)}` : "—"} />
            <Field
              k="Credited"
              v={cr.creditedAt ? new Date(cr.creditedAt).toLocaleDateString() : "—"}
            />
          </div>
        )}
      </div>
    </>
  );
}

function CreateCoreReturnDialog({
  open,
  onOpenChange,
  inventoryItems,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  inventoryItems: { id: string; name: string; sku: string }[];
  onSaved: (r: CoreReturn) => void;
}) {
  const [partDescription, setPartDescription] = useState("");
  const [linkedItemId, setLinkedItemId] = useState(NO_ITEM);
  const [coreValue, setCoreValue] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [supplierId, setSupplierId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setPartDescription("");
    setLinkedItemId(NO_ITEM);
    setCoreValue("");
    setCustomerName("");
    setReceivedAt(new Date().toISOString().slice(0, 10));
    setSupplierId("");
    setNotes("");
  }

  async function save() {
    const val = Number(coreValue);
    if (!partDescription.trim()) {
      toast.error("Describe the part");
      return;
    }
    if (!Number.isFinite(val) || val < 0) {
      toast.error("Core value must be a non-negative number");
      return;
    }
    setSaving(true);
    try {
      const r = await api.createCoreReturn({
        partDescription: partDescription.trim(),
        inventoryItemId: linkedItemId === NO_ITEM ? null : linkedItemId,
        coreValue: val,
        customerName: customerName.trim(),
        receivedAt,
        supplierId: supplierId.trim() || null,
        notes: notes.trim(),
      });
      toast.success(`${r.id} logged`);
      onSaved(r);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not log core return");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a core return</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Part</Label>
            <Input
              value={partDescription}
              onChange={(e) => setPartDescription(e.target.value)}
              placeholder="e.g. Hydraulic pump — CAT 320 (core)"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Link to catalog part (optional)</Label>
            <Select value={linkedItemId} onValueChange={setLinkedItemId}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ITEM}>Not in catalog</SelectItem>
                {inventoryItems.map((it) => (
                  <SelectItem key={it.id} value={it.id}>
                    {it.name} ({it.sku})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Core value ($)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={coreValue}
                onChange={(e) => setCoreValue(e.target.value)}
                className="mt-1 font-mono"
              />
            </div>
            <div>
              <Label>Date received</Label>
              <Input
                type="date"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label>Customer</Label>
            <Input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Who returned the core (optional)"
              className="mt-1"
            />
          </div>
          <div>
            <Label>Supplier</Label>
            <Input
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              placeholder="e.g. SUP-01 (optional — can set later)"
              className="mt-1 font-mono"
            />
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1"
            />
          </div>
          <Button
            onClick={() => void save()}
            disabled={saving}
            className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            data-testid="cr-create-save"
          >
            {saving ? "Saving…" : "Log core return"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
