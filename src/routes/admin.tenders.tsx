import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar, Mail, ExternalLink, Bot } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/tenders")({
  head: () => ({ meta: [{ title: "Tenders — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { tenders } = useData();
  const sorted = [...tenders].sort((a, b) => a.closingDate.localeCompare(b.closingDate));

  return (
    <AdminShell title="Tender digest">
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          {sorted.map((t) => {
            const closingMs = new Date(t.closingDate).getTime() - Date.now();
            const days = Math.max(0, Math.round(closingMs / (1000 * 60 * 60 * 24)));
            return (
              <div key={t.id} className="bg-card border border-border rounded-lg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                      {t.source}
                    </div>
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold mt-0.5 inline-flex items-center gap-1.5 hover:text-amber-brand"
                    >
                      {t.title}
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                    <p className="text-sm text-muted-foreground mt-1.5">{t.summary}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] uppercase tracking-wider font-mono text-muted-foreground">
                      Closes
                    </div>
                    <div className="font-mono text-sm font-semibold inline-flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {t.closingDate}
                    </div>
                    <div
                      className={`text-[10px] font-mono mt-0.5 ${days < 7 ? "text-danger" : "text-muted-foreground"}`}
                    >
                      in {days} days
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {sorted.length === 0 && (
            <div className="text-center py-12 text-sm text-muted-foreground">
              No tenders scraped this cycle.
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Bot className="w-4 h-4" /> Scraper schedule
            </h3>
            <p className="text-xs text-muted-foreground mt-1">Scrapes municipal portals weekly.</p>
            <div className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Frequency</span>
                <span className="font-mono">Weekly · Mon 03:00</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Last run</span>
                <span className="font-mono">2025-05-12</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">New this run</span>
                <span className="font-mono">{tenders.length}</span>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 w-full"
              onClick={() => toast.success("Manual scrape triggered (mock)")}
            >
              Run now
            </Button>
          </div>

          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Mail className="w-4 h-4" /> Weekly digest
            </h3>
            <div className="mt-3 space-y-3">
              <div>
                <Label>Recipient</Label>
                <Input defaultValue="nick@fleetops.co" type="email" />
              </div>
              <Button
                size="sm"
                className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                onClick={() => toast.success("Digest sent (mock)")}
              >
                Send digest now
              </Button>
            </div>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
