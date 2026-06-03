import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { DriverShell } from "@/components/layout/DriverLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { vehicleById } from "@/data/mockData";
import { ArrowLeft, KeyRound, Bell, HelpCircle, LogOut, ChevronRight, Clock } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/driver/profile")({
  head: () => ({ meta: [{ title: "Profile — FleetOps" }] }),
  component: Page,
});

function Page() {
  const nav = useNavigate();
  const { user, logout } = useAuth();
  const { drivers, timeEntries } = useData();
  const me = drivers.find((d) => d.id === user.id || d.email === user.email) ?? drivers[0];
  const openShift = timeEntries.find((t) => t.driverId === me.id && !t.clockOut);
  const v = openShift ? vehicleById(me.vehicleAssignmentId) : undefined;
  const hoursSoFar = openShift
    ? ((Date.now() - new Date(openShift.clockIn).getTime()) / 3600_000).toFixed(1)
    : null;

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
            onClick={() => toast.info("Password reset link sent (mock)")}
          />
          <ActionRow
            icon={Bell}
            label="Notifications"
            onClick={() => toast.info("Notification settings (mock)")}
          />
          <ActionRow
            icon={HelpCircle}
            label="Help & support"
            onClick={() => toast.info("Help (mock)")}
          />
          <ActionRow
            icon={LogOut}
            label="Logout"
            danger
            onClick={() => {
              logout();
              nav({ to: "/login" });
            }}
          />
        </div>
      </div>
    </DriverShell>
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
