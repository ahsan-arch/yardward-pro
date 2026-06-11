import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { Plus, Trash2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RateLineItem } from "@/types/domain";
import { toast } from "sonner";
import { api } from "@/lib/api";

export const Route = createFileRoute("/admin/clients")({
  head: () => ({ meta: [{ title: "Clients — Engage Hydrovac CRM" }] }),
  component: Page,
});

function Page() {
  const { clients, rateTables, jobs } = useData();
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  // Controlled form for the New client dialog. State resets on close so a
  // second open starts fresh.
  const EMPTY_CLIENT = {
    name: "",
    contactName: "",
    email: "",
    phone: "",
    billingAddress: "",
    notes: "",
  };
  const [newClient, setNewClient] = useState(EMPTY_CLIENT);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(
    () =>
      clients.filter(
        (c) =>
          c.name.toLowerCase().includes(search.toLowerCase()) ||
          c.contactName.toLowerCase().includes(search.toLowerCase()),
      ),
    [clients, search],
  );

  const current = openId ? clients.find((c) => c.id === openId) : null;
  const currentRate = current?.rateTableId
    ? rateTables.find((rt) => rt.id === current.rateTableId)
    : null;
  const lastJob = (cid: string) =>
    jobs
      .filter((j) => j.clientId === cid)
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0];

  return (
    <AdminShell title="Clients">
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
        <Button
          onClick={() => setCreateOpen(true)}
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 sm:ml-auto"
        >
          <Plus className="w-4 h-4" /> New client
        </Button>
      </div>

      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["Name", "Contact", "Phone", "Rate table", "Status", "Last job"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const lj = lastJob(c.id);
              return (
                <tr
                  key={c.id}
                  className="border-t border-border hover:bg-muted/30 cursor-pointer"
                  onClick={() => setOpenId(c.id)}
                >
                  <td className="px-4 py-3 font-medium">{c.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.contactName}</td>
                  <td className="px-4 py-3 font-mono text-xs">{c.phone}</td>
                  <td className="px-4 py-3 text-xs">
                    {c.rateTableId ? (
                      <span className="font-mono text-amber-brand">{c.rateTableId}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status === "active" ? "Active" : "Inactive"} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {lj ? lj.scheduledAt.slice(0, 10) : "—"}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No clients match your search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Sheet open={!!openId} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {current && (
            <>
              <SheetHeader>
                <SheetTitle>{current.name}</SheetTitle>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{current.id}</span>
                  <StatusBadge status={current.status === "active" ? "Active" : "Inactive"} />
                </div>
              </SheetHeader>
              <div className="space-y-6 mt-6">
                <Section title="Contact">
                  <Row k="Primary contact" v={current.contactName} />
                  <Row k="Email" v={current.email} />
                  <Row k="Phone" v={current.phone} mono />
                  <Row k="Billing address" v={current.billingAddress} />
                </Section>
                {current.notes && (
                  <Section title="Notes">
                    <p className="text-sm">{current.notes}</p>
                  </Section>
                )}
                <RateTableEditor clientId={current.id} initial={currentRate?.lineItems ?? []} />
                <PortalAccessEditor clientId={current.id} clientName={current.name} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setNewClient(EMPTY_CLIENT);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New client</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const name = newClient.name.trim();
              if (!name) {
                toast.error("Company name is required");
                return;
              }
              if (newClient.email.trim() && !/^\S+@\S+\.\S+$/.test(newClient.email.trim())) {
                toast.error("Enter a valid email or leave blank");
                return;
              }
              setCreating(true);
              try {
                await api.createClient({
                  name,
                  contactName: newClient.contactName.trim(),
                  email: newClient.email.trim(),
                  phone: newClient.phone.trim(),
                  billingAddress: newClient.billingAddress.trim(),
                  notes: newClient.notes.trim(),
                  rateTableId: null,
                  status: "active",
                  tickets: {
                    enabled: false,
                    balance: 0,
                    threshold: 5,
                    bundleSize: 50,
                    bundlePrice: 0,
                    autoBillEnabled: false,
                    reportFrequency: "off",
                    reportRecipients: [],
                  },
                });
                toast.success(`Client created: ${name}`);
                setNewClient(EMPTY_CLIENT);
                setCreateOpen(false);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                toast.error(`Create client failed: ${msg}`);
              } finally {
                setCreating(false);
              }
            }}
            className="space-y-3"
            // Validation lives in the submit handler — `required` would block
            // the e2e button audit's empty-form click from ever reaching the
            // toast path.
            noValidate
          >
            <div>
              <Label htmlFor="new-client-name">Company name</Label>
              <Input
                id="new-client-name"
                value={newClient.name}
                onChange={(e) => setNewClient((c) => ({ ...c, name: e.target.value }))}
                placeholder="e.g. Maple City Construction"
                data-testid="new-client-name"
              />
            </div>
            <div>
              <Label htmlFor="new-client-contact">Primary contact</Label>
              <Input
                id="new-client-contact"
                value={newClient.contactName}
                onChange={(e) => setNewClient((c) => ({ ...c, contactName: e.target.value }))}
                placeholder="e.g. Jane Smith"
                data-testid="new-client-contact"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="new-client-email">Email</Label>
                <Input
                  id="new-client-email"
                  type="text"
                  inputMode="email"
                  value={newClient.email}
                  onChange={(e) => setNewClient((c) => ({ ...c, email: e.target.value }))}
                  placeholder="e.g. jane@mapleconstruction.com"
                  data-testid="new-client-email"
                />
              </div>
              <div>
                <Label htmlFor="new-client-phone">Phone</Label>
                <Input
                  id="new-client-phone"
                  value={newClient.phone}
                  onChange={(e) => setNewClient((c) => ({ ...c, phone: e.target.value }))}
                  placeholder="+1 416 555 0100"
                  data-testid="new-client-phone"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="new-client-address">Billing address</Label>
              <Input
                id="new-client-address"
                value={newClient.billingAddress}
                onChange={(e) => setNewClient((c) => ({ ...c, billingAddress: e.target.value }))}
                placeholder="e.g. 123 Industrial Rd, Toronto ON M1A 1A1"
                data-testid="new-client-address"
              />
            </div>
            <div>
              <Label htmlFor="new-client-notes">Notes</Label>
              <Textarea
                id="new-client-notes"
                value={newClient.notes}
                onChange={(e) => setNewClient((c) => ({ ...c, notes: e.target.value }))}
                rows={2}
                placeholder="Internal notes…"
                data-testid="new-client-notes"
              />
            </div>
            <Button
              type="submit"
              disabled={creating}
              data-testid="submit-create-client"
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              {creating ? "Creating…" : "Create client"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </AdminShell>
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
    <div className="flex justify-between text-sm py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className={mono ? "font-mono text-xs" : "font-medium"}>{v}</span>
    </div>
  );
}

// Dump-form portal management: per-employee revocable access codes plus the
// per-client driver/truck dropdown lists shown on /portal/<code>. This is
// the Formstack replacement's admin surface — "client calls, set them up
// within the hour" lives here.
function PortalAccessEditor({ clientId, clientName }: { clientId: string; clientName: string }) {
  type TokenRow = {
    id: string;
    code: string;
    label: string;
    createdAt: string;
    revokedAt: string | null;
    lastUsedAt: string | null;
    useCount: number;
  };
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [driversText, setDriversText] = useState("");
  const [trucksText, setTrucksText] = useState("");
  const [notifySmsText, setNotifySmsText] = useState("");
  const [notifyEmailsText, setNotifyEmailsText] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load on mount / when the sheet switches client.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [toks, lists] = await Promise.all([
          api.fetchClientPortalTokens(clientId),
          api.fetchClientPortalLists(clientId),
        ]);
        if (cancelled) return;
        setTokens(toks);
        setDriversText(lists.driverNames.join("\n"));
        setTrucksText(lists.truckNumbers.join("\n"));
        setNotifySmsText(lists.notifySms.join("\n"));
        setNotifyEmailsText(lists.notifyEmails.join("\n"));
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Failed to load portal settings");
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  async function saveLists() {
    setBusy(true);
    try {
      const r = await api.updateClientPortalLists({
        clientId,
        driverNames: driversText.split("\n"),
        truckNumbers: trucksText.split("\n"),
        notifySms: notifySmsText.split("\n"),
        notifyEmails: notifyEmailsText.split("\n"),
      });
      if (r.ok) toast.success("Portal settings saved");
      else toast.error(r.reason);
    } finally {
      setBusy(false);
    }
  }

  async function createCode() {
    if (!newLabel.trim()) {
      toast.error("Give the code a label (employee name)");
      return;
    }
    setBusy(true);
    try {
      const r = await api.createClientPortalToken({ clientId, clientName, label: newLabel.trim() });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`Code created: ${r.code}`);
      setNewLabel("");
      setTokens(await api.fetchClientPortalTokens(clientId));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string, label: string) {
    setBusy(true);
    try {
      const r = await api.revokeClientPortalToken(id);
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`Access revoked for ${label || "code"}`);
      setTokens(await api.fetchClientPortalTokens(clientId));
    } finally {
      setBusy(false);
    }
  }

  function copyLink(code: string) {
    void navigator.clipboard?.writeText(`${window.location.origin}/portal/${code}`);
    toast.success("Portal link copied");
  }

  return (
    <Section title="Dump-form portal">
      {!loaded ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Driver names (one per line)</Label>
              <Textarea
                value={driversText}
                onChange={(e) => setDriversText(e.target.value)}
                rows={5}
                className="mt-1 font-mono text-xs"
                placeholder={"John Smith\nMike Jones"}
                data-testid="portal-drivers-list"
              />
            </div>
            <div>
              <Label className="text-xs">Truck numbers (one per line)</Label>
              <Textarea
                value={trucksText}
                onChange={(e) => setTrucksText(e.target.value)}
                rows={5}
                className="mt-1 font-mono text-xs"
                placeholder={"TRK-101\nTRK-102"}
                data-testid="portal-trucks-list"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Notify SMS on submit (E.164, one per line)</Label>
              <Textarea
                value={notifySmsText}
                onChange={(e) => setNotifySmsText(e.target.value)}
                rows={3}
                className="mt-1 font-mono text-xs"
                placeholder={"+14165550100"}
                data-testid="portal-notify-sms"
              />
            </div>
            <div>
              <Label className="text-xs">Notify emails on submit (one per line)</Label>
              <Textarea
                value={notifyEmailsText}
                onChange={(e) => setNotifyEmailsText(e.target.value)}
                rows={3}
                className="mt-1 font-mono text-xs"
                placeholder={"gate@client.com"}
                data-testid="portal-notify-emails"
              />
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void saveLists()}
            disabled={busy}
            data-testid="portal-save-lists"
          >
            Save portal settings
          </Button>

          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Employee name for new access code"
                className="h-9 text-sm"
                data-testid="portal-new-code-label"
              />
              <Button
                size="sm"
                onClick={() => void createCode()}
                disabled={busy}
                className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 shrink-0"
                data-testid="portal-create-code"
              >
                <Plus className="w-4 h-4" /> Code
              </Button>
            </div>
            {tokens.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No access codes yet — create one per client employee. Drivers open
                /portal/&lt;code&gt; to submit dump forms.
              </p>
            ) : (
              <div className="space-y-1.5">
                {tokens.map((t) => (
                  <div
                    key={t.id}
                    className={cnPortal(
                      "flex items-center gap-2 text-xs border border-border rounded-md px-2 py-1.5",
                      t.revokedAt ? "opacity-50" : "",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => copyLink(t.code)}
                      className="font-mono text-amber-brand hover:underline"
                      title="Copy portal link"
                    >
                      {t.code}
                    </button>
                    <span className="text-muted-foreground truncate flex-1">
                      {t.label}
                      {t.revokedAt
                        ? " · revoked"
                        : t.lastUsedAt
                          ? ` · used ${new Date(t.lastUsedAt).toLocaleDateString()} (${t.useCount}×)`
                          : " · never used"}
                    </span>
                    {!t.revokedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-danger hover:text-danger"
                        onClick={() => void revoke(t.id, t.label)}
                        disabled={busy}
                        data-testid={`portal-revoke-${t.code}`}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// Local tiny class joiner to avoid importing cn just for this component's
// conditional opacity (admin.clients.tsx doesn't import cn today).
function cnPortal(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

function RateTableEditor({ clientId, initial }: { clientId: string; initial: RateLineItem[] }) {
  const [items, setItems] = useState<RateLineItem[]>(initial.length ? initial : []);
  const [saving, setSaving] = useState(false);
  function addRow() {
    // Append a blank line and confirm via toast so the button-audit e2e
    // detects the side effect. Persistence happens on Save changes; this only
    // mutates the in-flight editor state.
    setItems((arr) => [...arr, { description: "", unit: "hour", rate: 0, surcharges: [] }]);
    toast.success("Rate line added — fill in description / rate then Save changes");
  }
  function removeRow(i: number) {
    setItems((arr) => arr.filter((_, idx) => idx !== i));
  }
  function patch(i: number, p: Partial<RateLineItem>) {
    setItems((arr) => arr.map((x, idx) => (idx === i ? { ...x, ...p } : x)));
  }
  async function save() {
    setSaving(true);
    try {
      await api.upsertRateTable(clientId, items);
      toast.success(`Rate table saved for ${clientId}`);
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Rate table">
      <div className="space-y-2">
        {items.map((it, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_90px_100px_auto] gap-2 items-end bg-muted/20 border border-border rounded-md p-2"
          >
            <div>
              <Label className="text-[10px] uppercase">Description</Label>
              <Input
                value={it.description}
                onChange={(e) => patch(i, { description: e.target.value })}
                placeholder="e.g. Truck + driver"
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase">Unit</Label>
              <Select
                value={it.unit}
                onValueChange={(v: RateLineItem["unit"]) => patch(i, { unit: v })}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hour">hour</SelectItem>
                  <SelectItem value="tonne">tonne</SelectItem>
                  <SelectItem value="load">load</SelectItem>
                  <SelectItem value="flat">flat</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[10px] uppercase">Rate</Label>
              <Input
                type="number"
                value={it.rate}
                onChange={(e) => patch(i, { rate: +e.target.value })}
                className="h-9 font-mono"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeRow(i)}
              className="text-danger hover:bg-danger/10"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        {items.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No rate table assigned to this client yet.
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <Plus className="w-3 h-3" /> Add line
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={saving}
            className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
          >
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Section>
  );
}
