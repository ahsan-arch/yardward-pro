import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { driverById } from "@/data/mockData";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { MessageSquare, Radio } from "lucide-react";

export const Route = createFileRoute("/admin/sms-log")({
  head: () => ({ meta: [{ title: "SMS log — Yardward Pro" }] }),
  component: Page,
});

const LIVE_THRESHOLD_MS = 60_000;

function Page() {
  const { smsLogs } = useData();
  const sorted = [...smsLogs].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  const now = Date.now();

  return (
    <AdminShell title="SMS notification log">
      <p className="text-sm text-muted-foreground mb-4">
        Every SMS dispatched through Twilio appears here with its delivery status. Entries less than
        60 seconds old show a <span className="inline-flex items-center gap-1 text-amber-brand font-semibold"><Radio className="w-3 h-3" /> Live</span>{" "}
        badge.
      </p>
      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]" data-testid="sms-log-table">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {["Sent at", "Driver", "Job", "Message", "Twilio ID", "Delivery"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const ageMs = now - new Date(s.sentAt).getTime();
              const isLive = ageMs >= 0 && ageMs < LIVE_THRESHOLD_MS;
              return (
                <tr
                  key={s.id}
                  data-testid="sms-log-row"
                  data-sms-id={s.id}
                  data-live={isLive ? "true" : "false"}
                  className="border-t border-border hover:bg-muted/30"
                >
                  <td className="px-4 py-3 font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <span>{new Date(s.sentAt).toLocaleString()}</span>
                      {isLive && (
                        <span
                          data-testid="sms-live-badge"
                          className="inline-flex items-center gap-1 text-[10px] font-semibold bg-amber-brand/15 text-amber-brand px-1.5 py-0.5 rounded-full uppercase tracking-wider"
                        >
                          <Radio className="w-2.5 h-2.5 animate-pulse" /> Live
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">{driverById(s.driverId)?.name ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs">{s.jobId ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <MessageSquare className="w-3 h-3 text-muted-foreground" />
                      {s.body}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {s.twilioMessageId ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={s.deliveryStatus.charAt(0).toUpperCase() + s.deliveryStatus.slice(1)}
                    />
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No SMS messages sent yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
