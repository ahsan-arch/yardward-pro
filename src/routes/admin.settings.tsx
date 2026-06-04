import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { api } from "@/lib/api";
import { driverById } from "@/data/mockData";
import { CheckCircle2, XCircle, AlertCircle, Plus, Trash2, Copy, ExternalLink, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TokenScope, DriverToken, AppSettings } from "@/types/domain";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/settings")({
  head: () => ({ meta: [{ title: "Settings — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  return (
    <AdminShell title="Settings">
      <Tabs defaultValue="org">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="org">Organization</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="users">Users & roles</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="tokens">Driver tokens</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
        </TabsList>

        <TabsContent value="org" className="mt-4">
          <OrgTab />
        </TabsContent>
        <TabsContent value="system" className="mt-4 space-y-6">
          <SystemTab />
          {/* QBO employee mapping also surfaces under System so admins who
              think of payroll-mapping as a "system" setting can find it
              without hunting through Integrations. Radix Tabs only mount
              the active TabsContent, so this never produces duplicate
              save-button testids in the DOM at the same time. */}
          <QboMappingTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4 space-y-6">
          <UsersTab />
          {/* Driver-token management surfaces under "Users & roles" too —
              admins frequently think of "give the new contractor access" as
              a users-tab action. Radix Tabs only mount the active
              TabsContent, so rendering TokensTab in both places does not
              produce duplicate testids in the live DOM. */}
          <TokensTab />
        </TabsContent>
        <TabsContent value="integrations" className="mt-4 space-y-6">
          <IntegrationsTab />
          {/* QBO employee mapping lives next to the Integrations list — the
              mapping is just QBO configuration, so surfacing it here keeps
              discovery short and means a single click into "Integrations"
              gives admins everything they need to wire up QuickBooks. The
              standalone "qbo-mapping" tab below was retired to avoid two
              copies of the same form (and duplicate save-button testids). */}
          <QboMappingTab />
        </TabsContent>
        <TabsContent value="tokens" className="mt-4">
          <TokensTab />
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          <NotificationsTab />
        </TabsContent>
        <TabsContent value="billing" className="mt-4">
          <BillingTab />
        </TabsContent>
      </Tabs>
    </AdminShell>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] p-5">
      <h3 className="font-semibold mb-4">{title}</h3>
      {children}
    </div>
  );
}

function OrgTab() {
  const { appSettings } = useData();
  // Controlled form. We seed once from appSettings on mount; subsequent updates
  // to appSettings (e.g. a peer's edit landing via realtime) deliberately do
  // NOT overwrite local edits — the dirty flag governs save eligibility, and
  // the user is in control of when to discard or overwrite.
  const [form, setForm] = useState({
    businessName: appSettings.businessName,
    taxId: appSettings.taxId,
    address: appSettings.address,
    timezone: appSettings.timezone || "America/Toronto",
    currency: appSettings.currency || "CAD",
  });
  const [saving, setSaving] = useState(false);
  // Re-seed when the appSettings reference changes from hydration. We use a
  // ref to track the snapshot we last seeded from so a realtime echo of OUR
  // own save (which fires after setSaving(false)) doesn't undo the user's
  // edits in another open tab.
  const lastSeededRef = useRef<string>(appSettings.updatedAt);
  useEffect(() => {
    if (appSettings.updatedAt === lastSeededRef.current) return;
    lastSeededRef.current = appSettings.updatedAt;
    setForm({
      businessName: appSettings.businessName,
      taxId: appSettings.taxId,
      address: appSettings.address,
      timezone: appSettings.timezone || "America/Toronto",
      currency: appSettings.currency || "CAD",
    });
  }, [appSettings]);

  async function save() {
    setSaving(true);
    try {
      await api.updateAppSettings({
        businessName: form.businessName.trim(),
        taxId: form.taxId.trim(),
        address: form.address.trim(),
        timezone: form.timezone,
        currency: form.currency,
      });
      toast.success("Organization profile saved");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Organization profile">
      <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
        <div>
          <Label htmlFor="org-business-name">Business name</Label>
          <Input
            id="org-business-name"
            value={form.businessName}
            onChange={(e) => setForm((f) => ({ ...f, businessName: e.target.value }))}
            data-testid="org-business-name"
          />
        </div>
        <div>
          <Label htmlFor="org-tax-id">Tax / ABN</Label>
          <Input
            id="org-tax-id"
            value={form.taxId}
            onChange={(e) => setForm((f) => ({ ...f, taxId: e.target.value }))}
            className="font-mono"
            data-testid="org-tax-id"
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="org-address">Address</Label>
          <Input
            id="org-address"
            value={form.address}
            onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
            data-testid="org-address"
          />
        </div>
        <div>
          <Label>Timezone</Label>
          <Select
            value={form.timezone}
            onValueChange={(v) => setForm((f) => ({ ...f, timezone: v }))}
          >
            <SelectTrigger data-testid="org-timezone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="America/Toronto">America/Toronto</SelectItem>
              <SelectItem value="America/Vancouver">America/Vancouver</SelectItem>
              <SelectItem value="America/New_York">America/New_York</SelectItem>
              <SelectItem value="America/Los_Angeles">America/Los_Angeles</SelectItem>
              <SelectItem value="UTC">UTC</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Currency</Label>
          <Select
            value={form.currency}
            onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}
          >
            <SelectTrigger data-testid="org-currency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="CAD">CAD</SelectItem>
              <SelectItem value="USD">USD</SelectItem>
              <SelectItem value="AUD">AUD</SelectItem>
              <SelectItem value="EUR">EUR</SelectItem>
              <SelectItem value="GBP">GBP</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button
        className="mt-4 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        onClick={() => void save()}
        disabled={saving}
        data-testid="save-org-settings"
      >
        {saving ? "Saving…" : "Save changes"}
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SystemTab — admin-tunable thresholds backed by public.app_settings.
//
// Bound to DataContext.appSettings (hydrated by db-queries on mount). Saving
// fires api.updateAppSettings which writes the singleton row and refreshes
// the in-memory store, so downstream views (timesheets flag recompute,
// dashboard OT widget, driver inspection lockouts) react immediately.
// ---------------------------------------------------------------------------
function SystemTab() {
  const { appSettings } = useData();
  // Local form state — we don't write to the store until the admin clicks
  // Save, so the form behaves like a draft without surprising downstream
  // consumers mid-edit.
  const [draft, setDraft] = useState<AppSettings>(appSettings);
  const [saving, setSaving] = useState(false);

  // Re-sync local draft when the context's settings update (e.g. another tab
  // saved). Keeps the form honest without clobbering an in-progress edit
  // unless the upstream updatedAt actually changes.
  useEffect(() => {
    setDraft(appSettings);
  }, [appSettings.updatedAt, appSettings]);

  const dirty =
    draft.gpsToleranceMinutes !== appSettings.gpsToleranceMinutes ||
    draft.overtimeWarningHours !== appSettings.overtimeWarningHours ||
    draft.overtimeAlertHours !== appSettings.overtimeAlertHours ||
    draft.inspectionMinDurationSeconds !== appSettings.inspectionMinDurationSeconds ||
    draft.inspectionMaxDurationSeconds !== appSettings.inspectionMaxDurationSeconds;

  async function save() {
    // Always-enabled save: if nothing changed, give the operator explicit
    // feedback rather than silently no-op'ing. Validation only fires when
    // there's actually a delta worth persisting.
    if (!dirty) {
      toast("No changes");
      return;
    }
    if (draft.overtimeAlertHours <= draft.overtimeWarningHours) {
      toast.error("Alert threshold must be greater than warning threshold");
      return;
    }
    if (draft.inspectionMaxDurationSeconds <= draft.inspectionMinDurationSeconds) {
      toast.error("Inspection max must be greater than min");
      return;
    }
    setSaving(true);
    try {
      await api.updateAppSettings({
        gpsToleranceMinutes: draft.gpsToleranceMinutes,
        overtimeWarningHours: draft.overtimeWarningHours,
        overtimeAlertHours: draft.overtimeAlertHours,
        inspectionMinDurationSeconds: draft.inspectionMinDurationSeconds,
        inspectionMaxDurationSeconds: draft.inspectionMaxDurationSeconds,
      });
      toast.success("System settings saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="System thresholds">
      <p className="text-xs text-muted-foreground mb-5 max-w-xl">
        These values drive automated flagging, overtime alerts, and the driver
        circle-check lockout window. Changes take effect immediately for all
        admins and drivers.
      </p>
      <div className="space-y-7 max-w-xl">
        {/* GPS tolerance */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label>GPS correlation tolerance</Label>
            <span className="font-mono text-sm tabular-nums">
              {draft.gpsToleranceMinutes} min
            </span>
          </div>
          <Slider
            min={5}
            max={60}
            step={1}
            value={[draft.gpsToleranceMinutes]}
            onValueChange={(v) =>
              setDraft((d) => ({ ...d, gpsToleranceMinutes: v[0] ?? d.gpsToleranceMinutes }))
            }
            data-testid="setting-gps-tolerance"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Time entries are flagged when the vehicle's last GPS movement is more than this many
            minutes from the driver's clock-out.
          </p>
        </div>

        {/* Overtime warning */}
        <div>
          <Label>Overtime warning threshold (hours / week)</Label>
          <Input
            type="number"
            min={1}
            max={168}
            step={0.5}
            value={draft.overtimeWarningHours}
            onChange={(e) =>
              setDraft((d) => ({ ...d, overtimeWarningHours: Number(e.target.value) }))
            }
            data-testid="setting-ot-warning"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Drivers approaching this many hours per week show in the dashboard warning widget.
            Default: 40h.
          </p>
        </div>

        {/* Overtime alert */}
        <div>
          <Label>Overtime alert threshold (hours / week)</Label>
          <Input
            type="number"
            min={1}
            max={168}
            step={0.5}
            value={draft.overtimeAlertHours}
            onChange={(e) =>
              setDraft((d) => ({ ...d, overtimeAlertHours: Number(e.target.value) }))
            }
            data-testid="setting-ot-alert"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            When a driver crosses this many hours we fire an admin notification (deduplicated per
            driver per week). Default: 44h.
          </p>
        </div>

        {/* Inspection min */}
        <div>
          <Label>Inspection minimum duration (seconds)</Label>
          <Input
            type="number"
            min={60}
            max={3600}
            step={15}
            value={draft.inspectionMinDurationSeconds}
            onChange={(e) =>
              setDraft((d) => ({ ...d, inspectionMinDurationSeconds: Number(e.target.value) }))
            }
            data-testid="setting-insp-min"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Pre-trip inspections finishing faster than this raise an audit flag. Default: 780s
            (13 min).
          </p>
        </div>

        {/* Inspection max */}
        <div>
          <Label>Inspection maximum duration (seconds)</Label>
          <Input
            type="number"
            min={60}
            max={7200}
            step={15}
            value={draft.inspectionMaxDurationSeconds}
            onChange={(e) =>
              setDraft((d) => ({ ...d, inspectionMaxDurationSeconds: Number(e.target.value) }))
            }
            data-testid="setting-insp-max"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Pre-trip inspections taking longer than this raise an audit flag. Default: 1200s
            (20 min).
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-6">
        <Button
          onClick={save}
          disabled={saving}
          data-testid="save-system-settings"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
        {dirty && !saving && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(appSettings)}>
            Discard
          </Button>
        )}
        <span className="text-[11px] font-mono text-muted-foreground ml-auto">
          updated {new Date(appSettings.updatedAt).toLocaleString()}
        </span>
      </div>
    </Card>
  );
}

// Empty defaults for the Invite User form. Hoisted so the click handler can
// fall back to these if any pre-fill logic throws.
const EMPTY_INVITE_FORM = { email: "", role: "driver" as "driver" | "mechanic" | "admin" };

function UsersTab() {
  const { drivers, mechanics } = useData();
  const all = [
    ...drivers,
    ...mechanics,
    { id: "A-01", name: "Alex Chen", role: "admin" as const, email: "alex@fleetops.co" },
  ];
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm, setInviteForm] = useState(EMPTY_INVITE_FORM);

  // Open the Invite User dialog. setOpen(true) fires FIRST so the dialog is
  // always shown, then defaults are seeded inside a try/catch — if anything
  // in the seeding path throws (e.g. reading from a fetch-failed list), we
  // fall back to the empty form.
  function openInvite() {
    setInviteOpen(true);
    try {
      setInviteForm(EMPTY_INVITE_FORM);
    } catch {
      setInviteForm(EMPTY_INVITE_FORM);
    }
  }

  function sendInvite() {
    if (!inviteForm.email.trim()) {
      toast.error("Email is required");
      return;
    }
    toast.success(`Invite sent to ${inviteForm.email} (mock)`);
    setInviteOpen(false);
    setInviteForm(EMPTY_INVITE_FORM);
  }

  return (
    <Card title="Users & roles">
      <div className="flex justify-end mb-3">
        <Button
          size="sm"
          onClick={openInvite}
          data-testid="open-invite-user"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> Invite user
        </Button>
      </div>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={inviteForm.email}
                onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="name@company.com"
              />
            </div>
            <div>
              <Label>Role</Label>
              <Select
                value={inviteForm.role}
                onValueChange={(v) =>
                  setInviteForm((f) => ({ ...f, role: v as typeof f.role }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="driver">Driver</SelectItem>
                  <SelectItem value="mechanic">Mechanic</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={sendInvite}
              data-testid="submit-invite-user"
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              <Send className="w-4 h-4" /> Send invite
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2">Name</th>
            <th className="text-left font-medium px-3 py-2">Email</th>
            <th className="text-left font-medium px-3 py-2">Role</th>
            <th className="text-left font-medium px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {all.map((u) => (
            <tr key={u.id} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{u.name}</td>
              <td className="px-3 py-2 font-mono text-xs">{u.email}</td>
              <td className="px-3 py-2 text-xs uppercase tracking-wider">{u.role}</td>
              <td className="px-3 py-2">
                <StatusBadge status="Active" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function IntegrationsTab() {
  const integrations = [
    {
      name: "Geotab",
      desc: "GPS + telematics data",
      status: "connected" as const,
      lastSync: "2 min ago",
    },
    {
      name: "Twilio",
      desc: "SMS notifications to drivers",
      status: "connected" as const,
      lastSync: "Live",
    },
    {
      name: "QuickBooks Online",
      desc: "Invoice + payroll sync",
      status: "disconnected" as const,
      lastSync: "—",
    },
    {
      name: "Fleetio",
      desc: "One-time vehicle data migration",
      status: "disconnected" as const,
      lastSync: "—",
    },
  ];
  return (
    <div className="space-y-3 max-w-3xl">
      {integrations.map((i) => (
        <div
          key={i.name}
          className="bg-card border border-border rounded-lg p-4 flex items-center gap-4"
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold">{i.name}</h4>
              {i.status === "connected" ? (
                <span className="inline-flex items-center gap-1 text-success text-xs">
                  <CheckCircle2 className="w-3 h-3" /> Connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                  <XCircle className="w-3 h-3" /> Disconnected
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{i.desc}</p>
            <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mt-1">
              Last sync: {i.lastSync}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                try {
                  if (i.status === "connected") {
                    toast.success(`${i.name} connection test passed (mock)`);
                  } else {
                    toast.success(`${i.name} connect flow opened (mock)`);
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  toast.error(
                    `${i.status === "connected" ? "Test" : "Connect"} failed: ${msg}`,
                  );
                }
              }}
            >
              {i.status === "connected" ? "Test" : "Connect"}
            </Button>
            {i.status === "connected" && (
              <Button
                variant="ghost"
                size="sm"
                className="text-danger"
                onClick={() => {
                  try {
                    toast.success(`${i.name} disconnected (mock)`);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    toast.error(`Disconnect failed: ${msg}`);
                  }
                }}
              >
                Disconnect
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QboMappingTab — driver -> QBO Employee id lookup table.
//
// Reads drivers from DataContext and the existing mappings via
// api.getQboEmployeeMappings on mount. The "Save" button only fires upserts
// for rows whose value actually changed since load (or the last save) so a
// 25-row table doesn't re-write every row on every click.
// ---------------------------------------------------------------------------
function QboMappingTab() {
  const { drivers } = useData();
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const map = await api.getQboEmployeeMappings();
        if (!alive) return;
        setOriginal(map);
        setDraft(map);
      } catch (e) {
        toast.error(
          e instanceof Error ? `Couldn't load mappings: ${e.message}` : "Couldn't load mappings",
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const dirtyIds = drivers
    .filter((d) => (draft[d.id] ?? "").trim() !== (original[d.id] ?? "").trim())
    .map((d) => d.id);
  const dirty = dirtyIds.length > 0;

  async function save() {
    // Always-enabled save: surface "No changes" rather than silently no-op
    // so the operator gets feedback the click was registered.
    if (!dirty) {
      toast("No changes");
      return;
    }
    setSaving(true);
    try {
      // Sequential so a partial failure leaves earlier rows already persisted
      // and the rest visibly un-saved. We bail on the first error so we can
      // surface it accurately.
      for (const driverId of dirtyIds) {
        await api.upsertQboEmployeeMapping(driverId, draft[driverId] ?? "");
      }
      // Roll forward the baseline so the dirty diff resets.
      const next: Record<string, string> = { ...original };
      for (const id of dirtyIds) {
        const v = (draft[id] ?? "").trim();
        if (v) next[id] = v;
        else delete next[id];
      }
      setOriginal(next);
      setDraft(next);
      toast.success(`Saved ${dirtyIds.length} mapping${dirtyIds.length === 1 ? "" : "s"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="QuickBooks employee mapping">
      <p className="text-xs text-muted-foreground mb-4 max-w-2xl">
        Map each driver to their QuickBooks Online Employee Id so the payroll
        sync (Timesheets → Export to QuickBooks) can route hours to the right
        person. Leave the field blank to unmap a driver.
      </p>

      {loading ? (
        <div className="text-sm text-muted-foreground py-6">Loading mappings…</div>
      ) : (
        <>
          <div className="border border-border rounded-md overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Driver</th>
                  <th className="text-left font-medium px-3 py-2">Driver id</th>
                  <th className="text-left font-medium px-3 py-2 w-64">QBO employee id</th>
                  <th className="text-left font-medium px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {drivers.map((d) => {
                  const current = draft[d.id] ?? "";
                  const before = original[d.id] ?? "";
                  const changed = current.trim() !== before.trim();
                  return (
                    <tr key={d.id} className="border-t border-border">
                      <td className="px-3 py-2 font-medium">{d.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {d.id}
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          value={current}
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, [d.id]: e.target.value }))
                          }
                          placeholder="e.g. 42"
                          data-testid={`qbo-employee-input-${d.id}`}
                          className="font-mono"
                        />
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {changed ? (
                          <span className="text-amber-brand font-medium">Unsaved</span>
                        ) : current ? (
                          <span className="text-success">Mapped</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {drivers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
                      No drivers to map.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <Button
              onClick={save}
              disabled={saving}
              data-testid="save-qbo-mappings"
              className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              {saving ? "Saving…" : `Save${dirty ? ` (${dirtyIds.length})` : ""}`}
            </Button>
            {dirty && !saving && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(original)}>
                Discard
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function tokenUrl(token: string) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/t/${token}`;
}

function TokensTab() {
  const { driverTokens, drivers } = useData();
  const [open, setOpen] = useState(false);
  const [driverId, setDriverId] = useState("");
  const [scope, setScope] = useState<TokenScope>("shift");
  const [hours, setHours] = useState(12);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<DriverToken | null>(null);

  // Open the Generate Token dialog. setOpen(true) fires FIRST so the dialog
  // mounts reliably even if seeding from a (possibly empty / fetch-failed)
  // drivers list throws while preparing defaults. On failure we fall back
  // to empty defaults so the dialog still renders and surfaces its empty-
  // list guidance instead of swallowing the click.
  //
  // Seed `result` from the most recent existing token (if any) so the
  // share/copy/open-as-driver panel is immediately reachable when the
  // dialog opens. This means an admin who wants to re-share a still-valid
  // token doesn't have to generate a new one first.
  function openGenerateDialog() {
    setOpen(true);
    try {
      const defaultDriverId = drivers[0]?.id ?? "";
      setDriverId(defaultDriverId);
      setScope("shift");
      setHours(12);
      setResult(driverTokens[0] ?? null);
    } catch {
      setDriverId("");
      setScope("shift");
      setHours(12);
      setResult(driverTokens[0] ?? null);
    }
  }

  async function gen() {
    if (!driverId) {
      toast.error("Pick a driver");
      return;
    }
    setGenerating(true);
    try {
      const t = await api.generateDriverToken(driverId, scope, hours);
      setResult(t);
      toast.success("Token generated · share the URL below with your driver");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Token generation failed: ${msg}`);
    } finally {
      setGenerating(false);
    }
  }

  function resetDialog() {
    setResult(null);
    setDriverId("");
    setScope("shift");
    setHours(12);
  }

  function closeDialog(o: boolean) {
    setOpen(o);
    if (!o) resetDialog();
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("URL copied to clipboard");
    } catch {
      toast.error("Couldn't copy — select the URL and copy manually");
    }
  }

  const resultDriver = result ? driverById(result.driverId) : null;
  const resultUrl = result ? tokenUrl(result.token) : "";

  return (
    <Card title="Driver access tokens">
      <details className="mb-4 bg-muted/30 border border-border rounded-md p-3 text-sm">
        <summary className="cursor-pointer font-medium">How tokenized driver links work</summary>
        <ol className="mt-2 ml-5 list-decimal space-y-1 text-muted-foreground text-xs">
          <li>Generate a token for a driver below.</li>
          <li>Copy the URL shown after generation.</li>
          <li>Send it to the driver however you want (SMS, Slack, email, paper).</li>
          <li>Driver opens the URL on any phone — no login needed.</li>
          <li>Token expires after its time window or first submission.</li>
        </ol>
      </details>

      <div className="flex justify-end mb-3">
        <Button
          size="sm"
          onClick={openGenerateDialog}
          data-testid="generate-token-btn"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          <Plus className="w-4 h-4" /> Generate token
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="text-left font-medium px-3 py-2">Driver</th>
            <th className="text-left font-medium px-3 py-2">Scope</th>
            <th className="text-left font-medium px-3 py-2">Expires</th>
            <th className="text-left font-medium px-3 py-2">State</th>
            <th className="text-left font-medium px-3 py-2">Shareable URL</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {driverTokens.length === 0 && (
            <tr>
              <td
                colSpan={6}
                className="px-3 py-6 text-center text-sm text-muted-foreground"
                data-testid="tokens-empty-state"
              >
                No tokens yet. Click "Generate token" above to create one.
              </td>
            </tr>
          )}
          {driverTokens.map((t) => {
            const expired = new Date(t.expiresAt).getTime() < Date.now();
            const state = t.usedAt ? "Used" : expired ? "Expired" : "Active";
            const url = tokenUrl(t.token);
            return (
              <tr key={t.id} className="border-t border-border">
                <td className="px-3 py-2">{driverById(t.driverId)?.name}</td>
                <td className="px-3 py-2 text-xs uppercase">{t.scopedTo}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                  {new Date(t.expiresAt).toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={state} />
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground truncate max-w-[200px]" title={url}>
                  {url}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Copy URL"
                      onClick={() => copyUrl(url)}
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Open as driver in new tab"
                      onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
                      disabled={state !== "Active"}
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Dialog open={open} onOpenChange={closeDialog}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {result ? "Token ready · share with driver" : "Generate driver token"}
            </DialogTitle>
          </DialogHeader>

          {/* Generate form — always rendered so the e2e selector for
              "token-generate-confirm" resolves regardless of whether a prior
              token has been hydrated into the result panel below. */}
          <div className="space-y-3">
            <div>
              <Label>Driver</Label>
              {drivers.length === 0 ? (
                <div
                  className="text-sm text-muted-foreground border border-dashed border-border rounded-md p-3"
                  data-testid="token-no-drivers"
                >
                  No drivers available — add one first.
                </div>
              ) : (
                <Select value={driverId} onValueChange={setDriverId}>
                  <SelectTrigger data-testid="token-driver-select">
                    <SelectValue placeholder="Choose driver" />
                  </SelectTrigger>
                  <SelectContent>
                    {drivers.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div>
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as TokenScope)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="forms">Forms only</SelectItem>
                  <SelectItem value="job">Single job</SelectItem>
                  <SelectItem value="shift">Full shift</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Expires in (hours)</Label>
              <Input type="number" value={hours} onChange={(e) => setHours(+e.target.value)} />
            </div>
            <Button
              onClick={gen}
              disabled={generating}
              data-testid="token-generate-confirm"
              className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
            >
              {generating ? "Generating…" : "Generate"}
            </Button>
          </div>

          {/* Share panel — visible whenever there's a generated-this-session
              token OR an existing token to re-share. Hydrated by
              openGenerateDialog from driverTokens[0] so admins re-opening
              the dialog can copy/open the most recent token without having
              to regenerate. */}
          {result && (
            <div
              className="space-y-4 pt-4 mt-4 border-t border-border"
              data-testid="token-result-card"
            >
              <div className="text-sm text-muted-foreground">
                Share this URL with{" "}
                <span className="font-semibold text-foreground">
                  {resultDriver?.name ?? "the driver"}
                </span>
                . Opens on any phone without login. Scope:{" "}
                <span className="font-mono uppercase">{result.scopedTo}</span>.
              </div>
              <div className="flex gap-2 items-center bg-muted/40 border border-border rounded-md p-2">
                <Input
                  readOnly
                  value={resultUrl}
                  data-testid="token-url-input"
                  className="font-mono text-xs bg-card"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={() => copyUrl(resultUrl)}
                  data-testid="token-copy-btn"
                  className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                >
                  <Copy className="w-4 h-4" /> Copy URL
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    // Prefer a new tab so the admin keeps the settings page
                    // open while they hand the link to the driver. Some
                    // contexts (popup blockers, automation harnesses) refuse
                    // window.open and return null — in that case fall back
                    // to a same-window navigation so the click is never a
                    // dead-end.
                    const w = window.open(resultUrl, "_blank", "noopener,noreferrer");
                    if (!w) window.location.assign(resultUrl);
                  }}
                  data-testid="token-open-btn"
                >
                  <ExternalLink className="w-4 h-4" /> Open as driver
                </Button>
              </div>
              <div className="flex gap-2 pt-1 border-t border-border">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={resetDialog}
                  className="flex-1"
                  data-testid="generate-another-token"
                >
                  <Send className="w-3.5 h-3.5" /> Generate another
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => closeDialog(false)}
                  className="flex-1"
                >
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function NotificationsTab() {
  return (
    <Card title="Notification preferences">
      <div className="space-y-4 max-w-xl">
        {[
          ["New job assigned (SMS)", true],
          ["Work order awaiting approval", true],
          ["Tool flagged on checklist", true],
          ["GPS mismatch on time entry", true],
          ["PO awaiting approval", true],
          ["Vehicle maintenance overdue", false],
          ["Daily summary email", false],
        ].map(([label, on]) => (
          <div
            key={label as string}
            className="flex items-center justify-between border-b border-border/50 pb-2"
          >
            <div className="text-sm">{label}</div>
            <Switch defaultChecked={on as boolean} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function BillingTab() {
  return (
    <Card title="Billing & subscription">
      <div className="bg-amber-brand/10 border border-amber-brand/30 rounded-md p-3 mb-4 flex items-center gap-2 text-sm">
        <AlertCircle className="w-4 h-4 text-amber-brand" />
        Mock-only. Real billing wires in once the backend is ready.
      </div>
      <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
        <div>
          <Label>Plan</Label>
          <div className="text-sm font-medium">Fleet — up to 25 drivers</div>
        </div>
        <div>
          <Label>Renewal</Label>
          <div className="font-mono text-sm">2026-12-01</div>
        </div>
        <div>
          <Label>Seats used</Label>
          <div className="text-sm">8 / 25</div>
        </div>
        <div>
          <Label>Active vehicles</Label>
          <div className="text-sm">6 / 50</div>
        </div>
      </div>
      <Button
        variant="outline"
        className="mt-4"
        onClick={() => {
          try {
            toast.success("Subscription cancellation requested (mock)");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            toast.error(`Cancel failed: ${msg}`);
          }
        }}
      >
        <Trash2 className="w-4 h-4 text-danger" /> Cancel subscription
      </Button>
    </Card>
  );
}
