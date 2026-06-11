import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useData } from "@/contexts/DataContext";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar, Mail, ExternalLink, Bot, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";
import { supabase, USE_SUPABASE } from "@/lib/supabase";

export const Route = createFileRoute("/admin/tenders")({
  head: () => ({ meta: [{ title: "Tenders — Engage Hydrovac CRM" }] }),
  component: Page,
});

// Shape of the tender-scrape edge function response.
interface ScrapeSourceResult {
  id: string;
  added: number;
  updated: number;
  error: string | null;
}
interface ScrapeResponse {
  sources: ScrapeSourceResult[];
  digest: {
    weekStartDate: string;
    weekEndDate?: string;
    newThisWeekCount?: number;
    activeOpenCount?: number;
    // Legacy alias still emitted by the function — equals newThisWeekCount.
    tenderCount: number;
  };
  // The edge function reports whether the digest was emailed in the same
  // response. ok=true means Resend accepted it; skippedReason is set when the
  // function intentionally no-op'd due to missing env (no API key / no
  // recipients) and that's surfaced to the admin as a non-error toast.
  sent?: {
    ok: boolean;
    recipients: string[];
    skippedReason?: string;
    error?: string;
  };
  durationMs?: number;
}

// Shape of the most recent tender_digests row we render in the card.
// We label both counts explicitly so the card can never confuse "new this
// week" with "active open across all weeks". sentAt/sentTo come from the
// tender_digests row and let us show "Last sent" alongside the counts.
interface DigestRow {
  weekStartDate: string;
  weekEndDate: string | null;
  newThisWeekCount: number;
  activeOpenCount: number;
  summary: string;
  sentAt: string | null;
  sentTo: string[];
}

function Page() {
  const { tenders } = useData();
  const { user } = useAuth();
  const sorted = [...tenders].sort((a, b) => a.closingDate.localeCompare(b.closingDate));

  const [scraping, setScraping] = useState(false);
  const [lastScrape, setLastScrape] = useState<ScrapeResponse | null>(null);
  const [latestDigest, setLatestDigest] = useState<DigestRow | null>(null);
  const [digestLoading, setDigestLoading] = useState(true);
  const [testRecipient, setTestRecipient] = useState(user?.email ?? "");
  const [sendingTest, setSendingTest] = useState(false);

  // Fetch the most recent weekly digest on mount. We re-fetch after a manual
  // scrape so the "last digest" card reflects the run we just kicked off.
  async function loadLatestDigest() {
    if (!USE_SUPABASE || !supabase) {
      setDigestLoading(false);
      return;
    }
    setDigestLoading(true);
    try {
      const { data, error } = await supabase
        .from("tender_digests")
        .select("week_start_date, week_end_date, tender_count, content, sent_at, sent_to")
        .order("week_start_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        console.error("[tenders] latest digest fetch failed:", error);
        return;
      }
      if (!data) {
        setLatestDigest(null);
        return;
      }
      // content is jsonb; pull the explicit fields the edge function now
      // writes, with defensive fallbacks for older rows that only have the
      // legacy {summary, tenders} shape.
      const content = (data.content ?? {}) as {
        summary?: unknown;
        newThisWeekCount?: unknown;
        activeOpenCount?: unknown;
      };
      const newThisWeekCount =
        typeof content.newThisWeekCount === "number" ? content.newThisWeekCount : data.tender_count;
      const activeOpenCount =
        typeof content.activeOpenCount === "number" ? content.activeOpenCount : data.tender_count;
      const summary =
        typeof content.summary === "string"
          ? content.summary
          : `${newThisWeekCount} new tender${newThisWeekCount === 1 ? "" : "s"} scraped this week. ${activeOpenCount} currently open across all weeks.`;
      const row = data as {
        week_start_date: string;
        week_end_date?: string | null;
        sent_at?: string | null;
        sent_to?: string[] | null;
      };
      setLatestDigest({
        weekStartDate: row.week_start_date,
        weekEndDate: row.week_end_date ?? null,
        newThisWeekCount,
        activeOpenCount,
        summary,
        sentAt: row.sent_at ?? null,
        sentTo: Array.isArray(row.sent_to) ? row.sent_to : [],
      });
    } finally {
      setDigestLoading(false);
    }
  }

  useEffect(() => {
    void loadLatestDigest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the test-recipient input with the admin's own email once auth resolves.
  // We only auto-fill while the field is empty so a custom address an admin
  // typed isn't clobbered on a later auth re-hydrate.
  useEffect(() => {
    if (user?.email && !testRecipient) {
      setTestRecipient(user.email);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  async function runScraper() {
    if (scraping) return;
    if (!USE_SUPABASE || !supabase) {
      toast.error(
        "Tender scrape requires Supabase credentials. Set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.",
      );
      return;
    }
    setScraping(true);
    const toastId = toast.loading("Running tender scraper…");
    try {
      const { data, error } = await supabase.functions.invoke<ScrapeResponse>("tender-scrape", {
        body: {},
      });
      if (error) {
        toast.error(`Scrape failed: ${error.message}`, { id: toastId });
        return;
      }
      if (!data) {
        toast.error("Scrape returned no result", { id: toastId });
        return;
      }
      setLastScrape(data);

      const totals = data.sources.reduce(
        (acc, s) => {
          acc.added += s.added;
          acc.updated += s.updated;
          if (s.error) acc.errored += 1;
          return acc;
        },
        { added: 0, updated: 0, errored: 0 },
      );

      const seconds = data.durationMs ? ` in ${(data.durationMs / 1000).toFixed(1)}s` : "";
      const errorTail = totals.errored
        ? `, ${totals.errored} source error${totals.errored === 1 ? "" : "s"}`
        : "";
      // Prefer the explicit counts; fall back to the legacy tenderCount for
      // both numbers if the response predates the labelled fields.
      const newThisWeek = data.digest.newThisWeekCount ?? data.digest.tenderCount;
      const activeOpen = data.digest.activeOpenCount ?? data.digest.tenderCount;
      // Email tail describes the Resend outcome: success, intentional skip
      // (missing env), or hard failure. The function returns 200 in all
      // three cases — the email path is non-blocking.
      let emailTail = "";
      if (data.sent?.ok && data.sent.recipients.length > 0) {
        emailTail = ` Sent to ${data.sent.recipients.length} recipient${data.sent.recipients.length === 1 ? "" : "s"}.`;
      } else if (data.sent?.skippedReason) {
        emailTail = ` Email skipped (${data.sent.skippedReason}).`;
      } else if (data.sent && !data.sent.ok) {
        emailTail = ` Email send failed.`;
      }
      toast.success(
        `Scrape complete: ${totals.added} added, ${totals.updated} updated${errorTail}${seconds}. Week ${data.digest.weekStartDate}: ${newThisWeek} new this week, ${activeOpen} active open.${emailTail}`,
        { id: toastId },
      );

      // Refresh the digest card so the panel below reflects the latest run.
      void loadLatestDigest();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Scrape failed: ${message}`, { id: toastId });
    } finally {
      setScraping(false);
    }
  }

  // sendTestDigest re-sends the most recent digest to a single email address
  // by hitting tender-scrape with { sendTestTo }. The function short-circuits
  // around the scrape phase and does NOT touch tender_digests.sent_at — that
  // column is reserved for the real weekly broadcast so the audit trail stays
  // honest.
  async function sendTestDigest() {
    if (sendingTest) return;
    // Gate on a digest existing first — the audit button stays enabled so the
    // operator always gets some feedback (toast.error here) rather than a
    // silently-disabled control whose tooltip explains the dependency. This
    // matches the "always-enabled + actionable error" pattern the button
    // audit suite expects.
    if (!latestDigest) {
      toast.error("Run scraper first — there's no digest to send yet.");
      return;
    }
    if (!USE_SUPABASE || !supabase) {
      toast.error("Sending a test digest requires Supabase credentials.");
      return;
    }
    const recipient = testRecipient.trim();
    if (!recipient) {
      toast.error("Enter a recipient email first.");
      return;
    }
    // Light sanity check — full RFC-5322 validation is overkill and Resend
    // will reject anything actually broken with a clean error message.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      toast.error("That doesn't look like a valid email address.");
      return;
    }
    setSendingTest(true);
    const toastId = toast.loading(`Sending test digest to ${recipient}…`);
    try {
      const { data, error } = await supabase.functions.invoke<ScrapeResponse>("tender-scrape", {
        body: { sendTestTo: recipient },
      });
      if (error) {
        toast.error(`Test send failed: ${error.message}`, { id: toastId });
        return;
      }
      if (!data?.sent) {
        toast.error("Test send returned no result.", { id: toastId });
        return;
      }
      if (data.sent.ok) {
        toast.success(`Test digest sent to ${recipient}.`, { id: toastId });
      } else if (data.sent.skippedReason) {
        toast.error(`Test send skipped: ${data.sent.skippedReason}`, { id: toastId });
      } else {
        toast.error(`Test send failed: ${data.sent.error ?? "unknown error"}`, { id: toastId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Test send failed: ${message}`, { id: toastId });
    } finally {
      setSendingTest(false);
    }
  }

  return (
    <AdminShell title="Tender digest">
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-3">
          {/* Explicit heading makes clear the list spans every week's open
              tenders, not just whatever was scraped this week — same framing
              the digest email uses, so a recipient sees consistent labels. */}
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider font-mono text-muted-foreground">
              Active open tenders (any week)
            </h2>
            <span className="text-[10px] font-mono text-muted-foreground">
              {sorted.length} listed
            </span>
          </div>
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
                    {/* t.url comes from external scraped HTML; only allow
                        http(s) so a javascript:/data: URL can't execute when
                        an admin clicks the tender link. */}
                    <a
                      href={/^https?:\/\//i.test(t.url) ? t.url : "#"}
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
                <span className="font-mono">Weekly · Mon 06:00</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">New this run</span>
                <span className="font-mono">
                  {lastScrape ? lastScrape.sources.reduce((n, s) => n + s.added, 0) : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Updated</span>
                <span className="font-mono">
                  {lastScrape ? lastScrape.sources.reduce((n, s) => n + s.updated, 0) : "—"}
                </span>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-3 w-full"
              onClick={runScraper}
              disabled={scraping}
            >
              {scraping ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  Running…
                </>
              ) : (
                "Run scraper"
              )}
            </Button>
            {lastScrape && lastScrape.sources.length > 0 && (
              <div className="mt-3 pt-3 border-t border-border space-y-1.5">
                {lastScrape.sources.map((s) => (
                  <div key={s.id} className="text-[11px] font-mono flex justify-between gap-2">
                    <span className="text-muted-foreground truncate">{s.id}</span>
                    <span
                      className={s.error ? "text-danger" : "text-foreground"}
                      title={s.error ?? undefined}
                    >
                      {s.error ? "error" : `+${s.added} / ~${s.updated}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Mail className="w-4 h-4" /> Last weekly digest
            </h3>
            <div className="mt-3 text-sm">
              {digestLoading ? (
                <div className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                </div>
              ) : latestDigest ? (
                <>
                  {/* Week range — show the closed interval [start, end] so the
                      reader sees exactly which scrape window the "new this week"
                      number is measured against. */}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Week</span>
                    <span className="font-mono">
                      {latestDigest.weekStartDate}
                      {latestDigest.weekEndDate ? ` – ${latestDigest.weekEndDate}` : ""}
                    </span>
                  </div>
                  {/* Two explicitly-labelled stats — distinguishing the
                      this-week scrape count from the any-week active-open count
                      is the entire point of this card. */}
                  <div className="flex justify-between mt-1.5">
                    <span className="text-muted-foreground">New this week</span>
                    <span className="font-mono">{latestDigest.newThisWeekCount}</span>
                  </div>
                  <div className="flex justify-between mt-1.5">
                    <span className="text-muted-foreground">Active open</span>
                    <span className="font-mono">{latestDigest.activeOpenCount}</span>
                  </div>
                  {/* Email broadcast status. sent_at + sent_to are stamped by
                      the edge function ONLY after a successful Resend POST in
                      the weekly broadcast path; test sends from the panel
                      below intentionally don't update them. */}
                  <div className="mt-3 pt-3 border-t border-border text-xs">
                    {latestDigest.sentAt ? (
                      <>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Last sent</span>
                          <span className="font-mono" title={latestDigest.sentAt}>
                            {new Date(latestDigest.sentAt).toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between mt-1">
                          <span className="text-muted-foreground">Recipients</span>
                          <span
                            className="font-mono"
                            title={latestDigest.sentTo.join(", ") || undefined}
                          >
                            {latestDigest.sentTo.length}
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="text-muted-foreground italic">Not yet sent</div>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
                    {latestDigest.summary}
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">No digest generated yet.</p>
              )}
            </div>
          </div>

          {/* Test-send panel: lets an admin re-send the latest digest to a
              single address (defaulting to their own email) without running
              another scrape and without updating sent_at on the row. Useful
              for verifying Resend config or previewing the rendered HTML in
              an inbox. */}
          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Send className="w-4 h-4" /> Send test digest
            </h3>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Re-sends the most recent digest to a single address. Does not affect the weekly
              broadcast or the "last sent" timestamp above.
            </p>
            <div className="mt-3 space-y-3">
              <div>
                <Label htmlFor="test-recipient">Recipient</Label>
                <Input
                  id="test-recipient"
                  type="email"
                  value={testRecipient}
                  onChange={(e) => setTestRecipient(e.target.value)}
                  placeholder="you@yardward.pro"
                  disabled={sendingTest}
                />
              </div>
              <Button
                size="sm"
                className="w-full bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
                onClick={sendTestDigest}
                // Keep the button enabled even when there's no digest or no
                // recipient: the onClick guards above turn that into a
                // toast.error rather than a silently-disabled control. The
                // button audit treats a disabled "submit-form" action as a
                // failure, so we surface the error path via toast instead.
                disabled={sendingTest}
                title={
                  !latestDigest ? "Run the scraper first so there is a digest to send." : undefined
                }
              >
                {sendingTest ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Send test digest"
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </AdminShell>
  );
}
