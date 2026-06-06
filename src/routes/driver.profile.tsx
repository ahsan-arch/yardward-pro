import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { vehicleById } from "@/data/mockData";
import {
  ArrowLeft,
  KeyRound,
  Bell,
  HelpCircle,
  LogOut,
  ChevronRight,
  Clock,
  Loader2,
  Mail,
  Phone,
} from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import {
  DEFAULT_USER_NOTIFICATION_PREFERENCES,
  type UserNotificationPreferences,
} from "@/types/domain";

export const Route = createFileRoute("/driver/profile")({
  head: () => ({ meta: [{ title: "Profile — Yardward Pro" }] }),
  component: Page,
});

function Page() {
  const nav = useNavigate();
  const { user, logout, sendPasswordReset } = useAuth();
  const { drivers, timeEntries, appSettings } = useData();
  const me = drivers.find((d) => d.id === user.id || d.email === user.email) ?? drivers[0];
  const openShift = timeEntries.find((t) => t.driverId === me.id && !t.clockOut);
  const v = openShift ? vehicleById(me.vehicleAssignmentId) : undefined;
  const hoursSoFar = openShift
    ? ((Date.now() - new Date(openShift.clockIn).getTime()) / 3600_000).toFixed(1)
    : null;

  const [notifOpen, setNotifOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  async function handleChangePassword() {
    if (!user.email) {
      toast.error("No email on file for this account");
      return;
    }
    const { error } = await sendPasswordReset(user.email);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(`Password reset link sent to ${user.email}. Check inbox + spam.`);
  }

  return (
    <DriverShell>
      <div className="p-4">
        <Link
          to="/driver"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>

        <div className="flex items-center gap-4 bg-card border border-border rounded-xl p-4">
          <div className="w-16 h-16 rounded-full bg-navy text-navy-foreground grid place-items-center text-xl font-bold">
            {me.initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-lg">{me.name}</div>
            <div className="text-xs text-muted-foreground font-mono">
              {me.id} · {me.phone}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              License {me.licenseNumber}, expires {me.licenseExpiry}
            </div>
          </div>
        </div>

        <div className="mt-4 bg-card border border-border rounded-xl p-4">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4" /> My shift
          </h2>
          {openShift ? (
            <div className="mt-2 space-y-1.5 text-sm">
              <Row
                k="Clocked in"
                v={new Date(openShift.clockIn).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              />
              <Row k="Hours so far" v={`${hoursSoFar}h`} />
              <Row k="Current vehicle" v={v ? `${v.id} — ${v.name}` : "—"} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-2 italic">Not clocked in.</p>
          )}
        </div>

        <div className="mt-4 space-y-1.5">
          <ActionRow
            icon={KeyRound}
            label="Change password"
            onClick={() => void handleChangePassword()}
          />
          <ActionRow
            icon={Bell}
            label="Notifications"
            onClick={() => setNotifOpen(true)}
          />
          <ActionRow
            icon={HelpCircle}
            label="Help & support"
            onClick={() => setHelpOpen(true)}
          />
          <ActionRow
            icon={LogOut}
            label="Logout"
            danger
            onClick={() => {
              void logout();
              nav({ to: "/login" });
            }}
          />
        </div>
      </div>

      <NotificationsSheet open={notifOpen} onOpenChange={setNotifOpen} />
      <HelpSheet
        open={helpOpen}
        onOpenChange={setHelpOpen}
        orgPhone={me.phone}
        supportEmail={
          appSettings.businessName ? `support@${slugify(appSettings.businessName)}.co` : "support@yardward.pro"
        }
      />
    </DriverShell>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24) || "yardward";
}

function NotificationsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  // Lazy-load the prefs the first time the sheet opens. Avoids a query on
  // every profile render.
  const [prefs, setPrefs] = useState<UserNotificationPreferences>(
    DEFAULT_USER_NOTIFICATION_PREFERENCES,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    setLoading(true);
    api
      .getMyNotificationPreferences()
      .then((p) => {
        setPrefs(p);
        setLoaded(true);
      })
      .catch(() => {
        // Surface the default prefs even if fetch fails so the UI is usable.
        setLoaded(true);
      })
      .finally(() => setLoading(false));
  }, [open, loaded]);

  async function save() {
    setSaving(true);
    try {
      const result = await api.updateMyNotificationPreferences(prefs);
      if (result.ok) {
        toast.success("Notification preferences saved");
        onOpenChange(false);
      } else {
        toast.error(result.reason);
      }
    } finally {
      setSaving(false);
    }
  }

  const rows: Array<{ key: keyof UserNotificationPreferences; label: string }> = [
    { key: "newJobAssignedSms", label: "New job assigned (SMS)" },
    { key: "workOrderAwaitingApproval", label: "Work order awaiting approval" },
    { key: "toolFlaggedOnChecklist", label: "Tool flagged on checklist" },
    { key: "shiftReminders", label: "Shift reminders" },
    { key: "maintenanceAlerts", label: "Maintenance alerts" },
    { key: "dailySummaryEmail", label: "Daily summary email" },
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Bell className="w-4 h-4" /> Notification preferences
          </SheetTitle>
        </SheetHeader>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground mt-6">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="space-y-4 mt-6">
              {rows.map((row) => (
                <div
                  key={row.key}
                  className="flex items-center justify-between border-b border-border/50 pb-2"
                >
                  <div className="text-sm">{row.label}</div>
                  <Switch
                    checked={prefs[row.key]}
                    onCheckedChange={(v) =>
                      setPrefs((p) => ({ ...p, [row.key]: v }))
                    }
                    data-testid={`user-notif-${row.key}`}
                  />
                </div>
              ))}
            </div>
            <Button
              onClick={() => void save()}
              disabled={saving}
              data-testid="save-user-notif-prefs"
              className="w-full mt-6 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold"
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

const FAQ_ITEMS: Array<{ q: string; a: string }> = [
  {
    q: "My pre-trip inspection won't let me clock in.",
    a: "Submit a fresh circle-check from the inspection screen. The lockout lifts as soon as a passing inspection is recorded for your assigned vehicle (CVOR rules give you a 12-hour window).",
  },
  {
    q: "GPS shows red or 'fallback' on my form.",
    a: "Make sure location permission is on for Yardward Pro in your phone settings. The form still works in fallback mode — your shift won't be blocked.",
  },
  {
    q: "I submitted a form while offline. Did it save?",
    a: "Yes — it's in the offline queue and will flush automatically when you're back online. You'll see a green banner when the sync completes.",
  },
  {
    q: "I need to reset my password.",
    a: "Use the Change password row above. You'll get a reset link in your email.",
  },
];

function HelpSheet({
  open,
  onOpenChange,
  orgPhone,
  supportEmail,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgPhone: string;
  supportEmail: string;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) {
      toast.error("Subject and message are required");
      return;
    }
    setSending(true);
    try {
      const result = await api.createSupportTicket({
        subject: subject.trim(),
        body: body.trim(),
      });
      if (result.ok) {
        toast.success(`Ticket sent (${result.ticketId}). We'll reply by email.`);
        setSubject("");
        setBody("");
        onOpenChange(false);
      } else {
        toast.error(result.reason);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <HelpCircle className="w-4 h-4" /> Help &amp; support
          </SheetTitle>
        </SheetHeader>

        <div className="mt-5 space-y-3">
          <h3 className="text-sm font-semibold">Frequently asked</h3>
          {FAQ_ITEMS.map((item, i) => (
            <details
              key={i}
              className="border border-border rounded-md px-3 py-2 group"
            >
              <summary className="cursor-pointer text-sm font-medium list-none flex items-center justify-between">
                <span>{item.q}</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-90" />
              </summary>
              <p className="text-xs text-muted-foreground mt-2">{item.a}</p>
            </details>
          ))}
        </div>

        <div className="mt-6 space-y-2">
          <h3 className="text-sm font-semibold">Reach the office</h3>
          <a
            href={`mailto:${supportEmail}`}
            className="flex items-center gap-2 text-sm text-amber-brand hover:underline"
            data-testid="support-email-link"
          >
            <Mail className="w-4 h-4" /> {supportEmail}
          </a>
          {orgPhone && (
            <a
              href={`tel:${orgPhone.replace(/[^0-9+]/g, "")}`}
              className="flex items-center gap-2 text-sm text-amber-brand hover:underline"
              data-testid="support-phone-link"
            >
              <Phone className="w-4 h-4" /> {orgPhone}
            </a>
          )}
        </div>

        <form onSubmit={submit} className="mt-6 space-y-3">
          <h3 className="text-sm font-semibold">Or open a ticket</h3>
          <div>
            <Label htmlFor="support-subject">Subject</Label>
            <Input
              id="support-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What's going on?"
              data-testid="support-subject"
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="support-body">Details</Label>
            <Textarea
              id="support-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Steps you took, what you expected, what happened…"
              data-testid="support-body"
              className="mt-1.5"
            />
          </div>
          <Button
            type="submit"
            disabled={sending}
            data-testid="submit-support-ticket"
            className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold"
          >
            {sending ? "Sending…" : "Send ticket"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-medium">{v}</span>
    </div>
  );
}

function ActionRow({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: typeof KeyRound;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 bg-card border border-border rounded-xl px-4 py-3.5 text-left hover:border-amber-brand active:scale-[0.99] ${danger ? "text-danger" : ""}`}
    >
      <Icon className="w-5 h-5" />
      <span className="flex-1 font-medium">{label}</span>
      <ChevronRight className="w-4 h-4 text-muted-foreground" />
    </button>
  );
}
