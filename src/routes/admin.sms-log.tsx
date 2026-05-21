import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { driverById } from "@/data/mockData";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { MessageSquare } from "lucide-react";

export const Route = createFileRoute("/admin/sms-log")({
  head: () => ({ meta: [{ title: "SMS log — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { smsLogs } = useData();
  const sorted = [...smsLogs].sort((a, b) => b.sentAt.localeCompare(a.sentAt));

  return (
    <AdminShell title="SMS notification log">
      <div className="bg-card border border-border rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.06)] overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
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
            {sorted.map((s) => (
              <tr key={s.id} className="border-t border-border hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">
                  {new Date(s.sentAt).toLocaleString()}
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
            ))}
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
