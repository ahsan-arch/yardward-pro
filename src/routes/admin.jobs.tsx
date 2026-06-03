import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { StatusBadge } from "@/components/crm/StatusBadge";
import { jobDisplay } from "@/data/mockData";
import { useData } from "@/contexts/DataContext";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowUpDown, Loader2, Send } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/jobs")({
  head: () => ({ meta: [{ title: "Jobs — FleetOps CRM" }] }),
  component: Page,
});

function Page() {
  const { jobs } = useData();
  // Keep the raw status alongside the display row so we can spot drafts
  // without re-deriving from the lowercased mock-data string.
  const rows = jobs.map((j) => ({ ...jobDisplay(j), rawStatus: j.status }));
  type Row = (typeof rows)[number];
  const [sort, setSort] = useState<{ k: keyof Row; dir: 1 | -1 }>({ k: "id", dir: 1 });
  const sorted = [...rows].sort(
    (a, b) => (((a[sort.k] ?? "") as any) > ((b[sort.k] ?? "") as any) ? 1 : -1) * sort.dir,
  );
  const toggle = (k: any) => setSort((s) => ({ k, dir: s.k === k ? (s.dir === 1 ? -1 : 1) : 1 }));
  const [publishingId, setPublishingId] = useState<string | null>(null);

  async function publishDraft(jobId: string) {
    setPublishingId(jobId);
    try {
      const res = await api.publishJob(jobId);
      if ("alreadyPublished" in res && res.alreadyPublished) {
        toast.info(`${jobId} is already published`);
      } else {
        toast.success(`${jobId} published · SMS sent to driver`);
      }
    } finally {
      setPublishingId(null);
    }
  }

  return (
    <AdminShell title="Jobs">
      <div className="flex gap-2 mb-4">
        <Input placeholder="Search jobs…" className="max-w-sm" />
        <Button className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 ml-auto">
          New job
        </Button>
      </div>
      <div className="bg-card border border-border rounded-lg overflow-x-auto shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <table className="w-full text-sm min-w-[700px]">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              {(["id", "client", "location", "driver", "truck", "status", "time"] as const).map(
                (c) => (
                  <th key={c} className="text-left font-medium px-4 py-3">
                    <button
                      onClick={() => toggle(c)}
                      className="flex items-center gap-1 hover:text-foreground"
                    >
                      {c} <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                ),
              )}
              <th className="text-left font-medium px-4 py-3">actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((j) => {
              const isDraft = j.rawStatus === "draft";
              return (
                <tr
                  key={j.id}
                  data-testid={isDraft ? "jobs-row-draft" : "jobs-row"}
                  className={cn(
                    "border-t border-border hover:bg-muted/30",
                    // Drafts are visually de-emphasised in the master list so
                    // they read as "not yet live".
                    isDraft && "opacity-60 bg-muted/20",
                  )}
                >
                  <td className="px-4 py-3 font-mono text-xs">{j.id}</td>
                  <td className="px-4 py-3">{j.client}</td>
                  <td className="px-4 py-3 text-muted-foreground">{j.location}</td>
                  <td className="px-4 py-3">{j.driver}</td>
                  <td className="px-4 py-3 font-mono text-xs">{j.truck}</td>
                  <td className="px-4 py-3">
                    {isDraft ? (
                      <span
                        data-testid="draft-badge"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold tracking-wider uppercase border bg-muted-foreground/15 text-muted-foreground border-muted-foreground/20"
                      >
                        Draft
                      </span>
                    ) : (
                      <StatusBadge status={j.status} />
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono">{j.time}</td>
                  <td className="px-4 py-3">
                    {isDraft && (
                      <Button
                        size="sm"
                        data-testid={`publish-draft-${j.id}`}
                        onClick={() => publishDraft(j.id)}
                        disabled={publishingId === j.id}
                        className="h-7 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                      >
                        {publishingId === j.id ? (
                          <>
                            <Loader2 className="w-3 h-3 animate-spin" /> Publishing…
                          </>
                        ) : (
                          <>
                            <Send className="w-3 h-3" /> Publish
                          </>
                        )}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </AdminShell>
  );
}
