import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Phone, Award, Pencil, AlertCircle, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/drivers")({
  head: () => ({ meta: [{ title: "Drivers & mechanics — Yardward Pro" }] }),
  component: Page,
});

const EMPTY_DRIVER_FORM = {
  name: "",
  email: "",
  phone: "",
  licenseNumber: "",
  licenseExpiry: "",
};

// Heuristic: an E.164 number passes this regex. Display helper warns admin
// when a driver/mechanic has a placeholder so they know SMS won't deliver
// to them via Twilio. The pattern matches what api.updateUserPhone enforces.
function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{9,14}$/.test(phone.trim());
}
function isProbablyPlaceholder(phone: string): boolean {
  const stripped = phone.replace(/[^\d+]/g, "");
  return (
    !stripped || stripped.startsWith("+1555") || stripped.startsWith("+1000") || !isValidE164(phone)
  );
}

function Page() {
  const { drivers, mechanics, setUserPhone } = useData();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_DRIVER_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [creating, setCreating] = useState(false);
  const [createdInfo, setCreatedInfo] = useState<{
    name: string;
    email: string;
    tempPassword: string;
    warning?: string;
  } | null>(null);

  function openAddDriver() {
    setOpen(true);
    setCreatedInfo(null);
    try {
      const nextId = drivers.length + 1;
      // Default license_expiry to today+5y so the dialog opens with something
      // sensible; admin can edit before submit.
      const fiveYears = new Date();
      fiveYears.setFullYear(fiveYears.getFullYear() + 5);
      setForm({
        ...EMPTY_DRIVER_FORM,
        licenseNumber: `DL-${String(nextId).padStart(2, "0")}`,
        licenseExpiry: fiveYears.toISOString().slice(0, 10),
      });
    } catch {
      setForm(EMPTY_DRIVER_FORM);
    }
  }

  async function submit() {
    const name = form.name.trim();
    const email = form.email.trim();
    const phone = form.phone.trim();
    const licenseNumber = form.licenseNumber.trim();
    const licenseExpiry = form.licenseExpiry.trim();
    if (!name) return toast.error("Name is required");
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast.error("Valid email is required");
    if (phone && !/^\+[1-9]\d{9,14}$/.test(phone)) {
      return toast.error("Phone must be E.164 (e.g. +14165550100) or empty");
    }
    if (!licenseNumber) return toast.error("License number is required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(licenseExpiry)) {
      return toast.error("License expiry must be YYYY-MM-DD");
    }
    setCreating(true);
    try {
      const r = await api.createUser({
        email,
        name,
        phone: phone || undefined,
        role: "driver",
        licenseNumber,
        licenseExpiry,
      });
      if (!r.ok) {
        toast.error(r.reason);
        return;
      }
      toast.success(`${name} created`);
      // This entry point doesn't (yet) offer the email-invite toggle, so
      // the response is always the tempPassword branch. Narrowing is
      // defensive — if we add the toggle here later, the else branch
      // already shows a sensible inline confirmation.
      if (r.inviteSent) {
        setCreatedInfo({
          name,
          email,
          tempPassword: "(sent via email)",
          ...(r.warning ? { warning: r.warning } : {}),
        });
      } else {
        setCreatedInfo({
          name,
          email,
          tempPassword: r.tempPassword,
          ...(r.warning ? { warning: r.warning } : {}),
        });
      }
      if (r.warning) {
        // Loud toast that doesn't auto-dismiss; the warning also renders
        // inline in the credentials panel so the admin can't miss it.
        toast.warning(r.warning, { duration: 15_000 });
      }
      // Don't close the dialog yet — show the temp password panel.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  // Build a unified list of phone-bearing staff for the phone-edit Sheet
  // to look up by id. Drivers come first then mechanics.
  const rosterById = useMemo(() => {
    const m = new Map<
      string,
      {
        id: string;
        name: string;
        phone: string;
        kind: "driver" | "mechanic";
        initials: string;
        subtitle: string;
      }
    >();
    for (const d of drivers) {
      m.set(d.id, {
        id: d.id,
        name: d.name,
        phone: d.phone,
        kind: "driver",
        initials: d.initials,
        subtitle: `License ${d.licenseNumber}`,
      });
    }
    for (const mech of mechanics) {
      m.set(mech.id, {
        id: mech.id,
        name: mech.name,
        phone: mech.phone,
        kind: "mechanic",
        initials: mech.name
          .split(" ")
          .map((p) => p[0])
          .join("")
          .slice(0, 2)
          .toUpperCase(),
        subtitle: mech.email,
      });
    }
    return m;
  }, [drivers, mechanics]);

  const editingTarget = editingId ? (rosterById.get(editingId) ?? null) : null;

  const visibleDrivers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return drivers;
    return drivers.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        d.email.toLowerCase().includes(q) ||
        d.phone.toLowerCase().includes(q),
    );
  }, [drivers, search]);
  const visibleMechanics = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return mechanics;
    return mechanics.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.phone.toLowerCase().includes(q),
    );
  }, [mechanics, search]);

  const placeholderCount = [...drivers, ...mechanics].filter((u) =>
    isProbablyPlaceholder(u.phone),
  ).length;

  return (
    <AdminShell title="Drivers & mechanics">
      {placeholderCount > 0 && (
        <div
          className="mb-4 bg-amber-brand/10 border border-amber-brand/30 rounded-md p-3 flex items-start gap-2 text-sm"
          data-testid="phone-placeholder-warning"
        >
          <AlertCircle className="w-4 h-4 text-amber-brand mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              {placeholderCount} {placeholderCount === 1 ? "person" : "people"} still has a
              placeholder phone number.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Twilio outbound SMS (job assignments, Communications replies) won't deliver to
              placeholder numbers. Click the pencil on a card to set a real E.164 number (e.g.
              +14165550100).
            </p>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or phone…"
          className="max-w-sm"
          data-testid="staff-search"
        />
        <Button
          onClick={openAddDriver}
          data-testid="open-add-driver"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 ml-auto"
        >
          Add driver
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setCreatedInfo(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createdInfo ? "Driver created" : "Add driver"}</DialogTitle>
          </DialogHeader>
          {createdInfo ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {createdInfo.name} has been created. Send these credentials to them and ask them to
                rotate the password via the Forgot? link on first sign in.
              </p>
              {createdInfo.warning && (
                <div
                  className="bg-danger/10 border-2 border-danger/40 rounded-md p-3 flex items-start gap-2 text-sm"
                  data-testid="create-user-warning"
                >
                  <AlertCircle className="w-4 h-4 text-danger mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold text-danger">Action required</p>
                    <p className="text-xs text-danger mt-1">{createdInfo.warning}</p>
                  </div>
                </div>
              )}
              <div className="bg-muted/50 border border-border rounded-md p-3 space-y-2 font-mono text-xs">
                <div>
                  <span className="text-muted-foreground">Email:</span> {createdInfo.email}
                </div>
                <div>
                  <span className="text-muted-foreground">Temp password:</span>{" "}
                  <span data-testid="created-temp-password">{createdInfo.tempPassword}</span>
                </div>
              </div>
              <Button
                onClick={() => {
                  void navigator.clipboard?.writeText(
                    `Email: ${createdInfo.email}\nTemp password: ${createdInfo.tempPassword}`,
                  );
                  toast.success("Credentials copied to clipboard");
                }}
                data-testid="copy-created-credentials"
                className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
              >
                Copy credentials
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  setCreatedInfo(null);
                }}
                className="w-full"
              >
                Done
              </Button>
            </div>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              data-testid="add-driver-form"
            >
              <div>
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Jane Doe"
                  data-testid="add-driver-name"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="text"
                  inputMode="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="jane@yardward.pro"
                  data-testid="add-driver-email"
                />
              </div>
              <div>
                <Label>Phone (E.164)</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="+14165550100"
                  className="font-mono"
                  data-testid="add-driver-phone"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Optional but required for SMS delivery via Twilio.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>License number</Label>
                  <Input
                    value={form.licenseNumber}
                    onChange={(e) => setForm((f) => ({ ...f, licenseNumber: e.target.value }))}
                    className="font-mono"
                    data-testid="add-driver-license"
                  />
                </div>
                <div>
                  <Label>License expiry</Label>
                  <Input
                    type="date"
                    value={form.licenseExpiry}
                    onChange={(e) => setForm((f) => ({ ...f, licenseExpiry: e.target.value }))}
                    className="font-mono"
                    data-testid="add-driver-license-expiry"
                  />
                </div>
              </div>
              <Button
                type="submit"
                disabled={creating}
                data-testid="submit-add-driver"
                className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
              >
                {creating ? "Creating…" : "Add driver"}
              </Button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mt-2 mb-2">
        Drivers ({visibleDrivers.length})
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {visibleDrivers.map((d) => (
          <StaffCard
            key={d.id}
            id={d.id}
            name={d.name}
            initials={d.initials}
            phone={d.phone}
            status={d.status}
            kind="driver"
            subtitle={`License ${d.licenseNumber}`}
            onEdit={() => setEditingId(d.id)}
          />
        ))}
      </div>

      {visibleMechanics.length > 0 && (
        <>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mt-6 mb-2">
            Mechanics ({visibleMechanics.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visibleMechanics.map((m) => (
              <StaffCard
                key={m.id}
                id={m.id}
                name={m.name}
                initials={
                  m.name
                    .split(" ")
                    .map((p) => p[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase() || m.id.slice(0, 2)
                }
                phone={m.phone}
                status={m.status}
                kind="mechanic"
                subtitle={m.email}
                onEdit={() => setEditingId(m.id)}
              />
            ))}
          </div>
        </>
      )}

      <Sheet open={!!editingId} onOpenChange={(o) => !o && setEditingId(null)}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Edit phone — {editingTarget?.name ?? ""}</SheetTitle>
          </SheetHeader>
          {editingTarget && (
            <EditPhoneForm
              key={editingTarget.id}
              userId={editingTarget.id}
              currentPhone={editingTarget.phone}
              displayName={editingTarget.name}
              onSaved={(newPhone) => {
                setUserPhone(editingTarget.id, newPhone);
                setEditingId(null);
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </AdminShell>
  );
}

function StaffCard({
  id,
  name,
  initials,
  phone,
  status,
  kind,
  subtitle,
  onEdit,
}: {
  id: string;
  name: string;
  initials: string;
  phone: string;
  status: string;
  kind: "driver" | "mechanic";
  subtitle: string;
  onEdit: () => void;
}) {
  const placeholder = isProbablyPlaceholder(phone);
  return (
    <div
      className="bg-card border border-border rounded-lg p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
      data-testid="staff-card"
      data-user-id={id}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "w-12 h-12 rounded-full text-navy-foreground grid place-items-center font-bold",
            kind === "mechanic" ? "bg-info text-info-foreground" : "bg-navy",
          )}
        >
          {kind === "mechanic" ? <Wrench className="w-5 h-5" /> : initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">{name}</div>
          <div className="text-xs font-mono text-muted-foreground">{id.slice(0, 8)}…</div>
        </div>
        <span
          className={cn(
            "text-[10px] font-mono uppercase px-2 py-1 rounded",
            status === "active" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
          )}
        >
          {status}
        </span>
      </div>
      <div className="mt-4 pt-4 border-t border-border space-y-1.5 text-sm">
        <div className="flex items-center gap-2">
          <Phone
            className={cn(
              "w-3.5 h-3.5",
              placeholder ? "text-amber-brand" : "text-muted-foreground",
            )}
          />
          <span
            className={cn("font-mono text-xs flex-1 truncate", placeholder && "text-amber-brand")}
            data-testid="staff-phone"
          >
            {phone || "(not set)"}
          </span>
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit phone for ${name}`}
            data-testid="edit-staff-phone"
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Award className="w-3.5 h-3.5" />
          <span className="text-xs truncate">{subtitle}</span>
        </div>
      </div>
    </div>
  );
}

function EditPhoneForm({
  userId,
  currentPhone,
  displayName,
  onSaved,
}: {
  userId: string;
  currentPhone: string;
  displayName: string;
  onSaved: (newPhone: string) => void;
}) {
  const [phone, setPhone] = useState(currentPhone);
  const [saving, setSaving] = useState(false);
  const trimmed = phone.trim();
  const valid = isValidE164(trimmed);
  const showWarning = trimmed.length > 0 && !valid;

  async function save() {
    if (!valid) {
      toast.error("Phone must be E.164 format (e.g. +14165550100)");
      return;
    }
    setSaving(true);
    try {
      const r = await api.updateUserPhone({ userId, phone: trimmed });
      if (r.ok) {
        toast.success(`Phone updated for ${displayName}`);
        onSaved(trimmed);
      } else {
        toast.error(r.reason);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm text-muted-foreground">
        Phone number must be in E.164 format (country code + number, no spaces or dashes). Twilio
        uses this to deliver job-assignment SMS and Communications messages.
      </p>
      <div>
        <Label htmlFor="staff-phone-input">Phone</Label>
        <Input
          id="staff-phone-input"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+14165550100"
          className={cn(
            "font-mono mt-1.5",
            showWarning && "border-danger focus-visible:ring-danger",
          )}
          data-testid="edit-staff-phone-input"
        />
        {showWarning && (
          <p className="text-xs text-danger mt-1">
            Not a valid E.164 number. Format: +14165550100 (no spaces).
          </p>
        )}
      </div>
      <Button
        onClick={() => void save()}
        disabled={saving || !valid || trimmed === currentPhone}
        data-testid="save-staff-phone"
        className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
      >
        {saving ? "Saving…" : "Save phone"}
      </Button>
    </div>
  );
}
