import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, Plus, X, AlertTriangle, Receipt } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { TicketReportFrequency, Client } from "@/types/domain";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/prepaid-tickets")({
  head: () => ({ meta: [{ title: "Prepaid tickets — FleetOps CRM" }] }),
  component: Page,
});

type BalanceTone = "ok" | "low" | "negative";

function toneForBalance(balance: number, threshold: number): BalanceTone {
  if (balance < 0) return "negative";
  if (balance <= threshold) return "low";
  return "ok";
}

const toneStyles: Record<BalanceTone, string> = {
  ok: "bg-success/10 text-success border-success/30",
  low: "bg-amber-brand/10 text-amber-brand border-amber-brand/30",
  negative: "bg-danger/10 text-danger border-danger/30",
};

const toneLabel: Record<BalanceTone, string> = {
  ok: "Healthy",
  low: "Low",
  negative: "Negative",
};

function Page() {
  const { clients, ticketTransactions, ticketReplenishments } = useData();
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const enrolled = useMemo(
    () =>
      clients
        .filter((c) => c.tickets.enabled || c.tickets.balance !== 0)
        .filter(
          (c) =>
            c.name.toLowerCase().includes(search.toLowerCase()) ||
            c.id.toLowerCase().includes(search.toLowerCase()),
        ),
    [clients, search],
  );

  const lowBalanceCount = enrolled.filter(
    (c) => c.tickets.enabled && c.tickets.balance <= c.tickets.threshold,
  ).length;

  const current = openId ? clients.find((c) => c.id === openId) : null;
  const txnsForCurrent = current
    ? ticketTransactions
        .filter((t) => t.clientId === current.id)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    : [];
  const repsForCurrent = current
    ? ticketReplenishments
        .filter((r) => r.clientId === current.id)
        .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
    : [];

  return (
    <AdminShell title="Prepaid tickets">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <StatCard
          label="Enrolled clients"
          value={`${enrolled.filter((c) => c.tickets.enabled).length}`}
          tone="muted"
        />
        <StatCard
          label="Low or negative balances"
          value={`${lowBalanceCount}`}
          tone={lowBalanceCount > 0 ? "warning" : "muted"}
          icon={AlertTriangle}
        />
        <StatCard
          label="Replenishments this month"
          value={`${ticketReplenishments.length}`}
          tone="muted"
          icon={Receipt}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search clients…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["Client", "Balance", "Threshold", "Bundle", "Auto-bill", "Status", "Reports"].map(
                (h) => (
                  <th key={h} className="text-left font-medium px-4 py-3">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {enrolled.map((c) => {
              const tone = toneForBalance(c.tickets.balance, c.tickets.threshold);
              return (
                <tr
                  key={c.id}
                  onClick={() => setOpenId(c.id)}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{c.name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">{c.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-baseline gap-1 font-mono font-bold",
                        tone === "negative" ? "text-danger" : tone === "low" ? "text-amber-brand" : "",
                      )}
                    >
                      {c.tickets.balance}
                      <span className="text-[10px] text-muted-foreground font-normal">tickets</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {c.tickets.threshold}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {c.tickets.bundleSize} · ${c.tickets.bundlePrice}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "text-[10px] uppercase font-mono px-1.5 py-0.5 rounded",
                        c.tickets.autoBillEnabled
                          ? "bg-success/15 text-success"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {c.tickets.autoBillEnabled ? "On" : "Off"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border",
                        toneStyles[tone],
                      )}
                    >
                      {toneLabel[tone]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground capitalize">
                    {c.tickets.reportFrequency === "off"
                      ? "—"
                      : c.tickets.reportFrequency}
                  </td>
                </tr>
              );
            })}
            {enrolled.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  No clients are enrolled in prepaid tickets yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {current && (
            <ClientTicketsSheet
              key={current.id}
              client={current}
              txns={txnsForCurrent}
              reps={repsForCurrent}
            />
          )}
        </SheetContent>
      </Sheet>
    </AdminShell>
  );
}

type SheetProps = {
  client: Client;
  txns: ReturnType<typeof useData>["ticketTransactions"];
  reps: ReturnType<typeof useData>["ticketReplenishments"];
};

function ClientTicketsSheet({ client, txns, reps }: SheetProps) {
  const [enabled, setEnabled] = useState(client.tickets.enabled);
  const [threshold, setThreshold] = useState(client.tickets.threshold);
  const [bundleSize, setBundleSize] = useState(client.tickets.bundleSize);
  const [bundlePrice, setBundlePrice] = useState(client.tickets.bundlePrice);
  const [autoBill, setAutoBill] = useState(client.tickets.autoBillEnabled);
  const [frequency, setFrequency] = useState<TicketReportFrequency>(
    client.tickets.reportFrequency,
  );
  const [recipientsText, setRecipientsText] = useState(
    client.tickets.reportRecipients.join(", "),
  );
  const [saving, setSaving] = useState(false);
  const [toppingUp, setToppingUp] = useState(false);

  const tone = toneForBalance(client.tickets.balance, client.tickets.threshold);

  async function save() {
    setSaving(true);
    try {
      await api.updateClientTicketSettings(client.id, {
        enabled,
        threshold,
        bundleSize,
        bundlePrice,
        autoBillEnabled: autoBill,
        reportFrequency: frequency,
        reportRecipients: recipientsText
          .split(/[,;\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      toast.success("Ticket settings saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function topUp() {
    setToppingUp(true);
    try {
      const rep = await api.topUpTickets(client.id, bundleSize);
      toast.success(`Added ${rep.qty} tickets · invoice ${rep.invoiceDataId}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setToppingUp(false);
    }
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle>{client.name}</SheetTitle>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground font-mono text-xs">{client.id}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border",
              toneStyles[tone],
            )}
          >
            {toneLabel[tone]}
          </span>
        </div>
      </SheetHeader>

      <div className="mt-5 space-y-5">
        <div className="bg-muted/40 rounded-lg p-4 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
              Current balance
            </div>
            <div
              className={cn(
                "font-mono font-bold text-3xl",
                tone === "negative" && "text-danger",
                tone === "low" && "text-amber-brand",
              )}
            >
              {client.tickets.balance}
              <span className="text-sm font-normal text-muted-foreground ml-1">tickets</span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Threshold {client.tickets.threshold}
            </div>
          </div>
          <Button
            type="button"
            onClick={topUp}
            disabled={toppingUp}
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            <Plus className="w-4 h-4" /> Top up ({client.tickets.bundleSize})
          </Button>
        </div>

        <Section title="Settings">
          <div className="space-y-4">
            <ToggleRow
              label="Prepaid program enabled"
              checked={enabled}
              onChange={setEnabled}
              description="When on, each approved work order with a dump site debits one ticket."
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Low-balance threshold">
                <Input
                  type="number"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="font-mono"
                />
              </Field>
              <Field label="Bundle size">
                <Input
                  type="number"
                  value={bundleSize}
                  onChange={(e) => setBundleSize(Number(e.target.value))}
                  className="font-mono"
                />
              </Field>
              <Field label="Bundle price ($)">
                <Input
                  type="number"
                  value={bundlePrice}
                  onChange={(e) => setBundlePrice(Number(e.target.value))}
                  className="font-mono"
                />
              </Field>
              <Field label="Report frequency">
                <Select
                  value={frequency}
                  onValueChange={(v) => setFrequency(v as TicketReportFrequency)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <ToggleRow
              label="Auto-bill when threshold crossed"
              checked={autoBill}
              onChange={setAutoBill}
              description="Generates a replenishment invoice and pushes it to QuickBooks automatically."
            />
            <Field label="Report recipients (comma separated)">
              <Input
                value={recipientsText}
                onChange={(e) => setRecipientsText(e.target.value)}
                placeholder="billing@client.com, ops@client.com"
              />
            </Field>
            <Button
              onClick={save}
              disabled={saving}
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </Section>

        <Section title="Recent transactions">
          {txns.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No transactions yet.</p>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">When</th>
                    <th className="text-left font-medium px-3 py-2">Type</th>
                    <th className="text-left font-medium px-3 py-2">Qty</th>
                    <th className="text-left font-medium px-3 py-2">Balance</th>
                    <th className="text-left font-medium px-3 py-2">Dump site</th>
                  </tr>
                </thead>
                <tbody>
                  {txns.slice(0, 12).map((t) => (
                    <tr key={t.id} className="border-t border-border">
                      <td className="px-3 py-2 font-mono text-xs">
                        {t.occurredAt.slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="px-3 py-2 capitalize">
                        <span
                          className={cn(
                            "text-xs",
                            t.kind === "debit" && "text-danger",
                            t.kind === "credit" && "text-success",
                          )}
                        >
                          {t.kind}
                        </span>
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 font-mono text-xs",
                          t.kind === "debit" ? "text-danger" : "text-success",
                        )}
                      >
                        {t.kind === "debit" ? "-" : "+"}
                        {t.qty}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{t.balanceAfter}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {t.dumpSite ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Replenishment invoices">
          {reps.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No replenishments yet.</p>
          ) : (
            <div className="space-y-2">
              {reps.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between text-sm border border-border rounded-md p-3"
                >
                  <div>
                    <div className="font-mono text-xs">{r.invoiceDataId}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.qty} tickets · ${r.amount} ·{" "}
                      {r.triggeredAt.slice(0, 10)}
                    </div>
                  </div>
                  <span
                    className={cn(
                      "text-[10px] uppercase font-mono px-1.5 py-0.5 rounded",
                      r.qboSyncStatus === "synced"
                        ? "bg-success/15 text-success"
                        : r.qboSyncStatus === "failed"
                          ? "bg-danger/15 text-danger"
                          : "bg-amber-brand/15 text-amber-brand",
                    )}
                  >
                    {r.autoBilled ? "Auto · " : ""}
                    {r.qboSyncStatus}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

function StatCard({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  tone: "muted" | "warning";
  icon?: typeof X;
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="flex items-start justify-between">
        {Icon && <Icon className="w-5 h-5 text-muted-foreground" />}
      </div>
      <div
        className={cn(
          "text-2xl font-bold font-mono mt-2",
          tone === "warning" && "text-amber-brand",
        )}
      >
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-[10px] uppercase tracking-wider">{label}</Label>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
