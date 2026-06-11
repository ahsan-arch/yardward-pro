// Supabase Edge Function: tender-scrape
//
// Driven by public.tender_sources (id, base_url, enabled). For each enabled
// source we call a per-source scraper, upsert the resulting items into
// public.tenders keyed on URL, then build a weekly digest row in
// public.tender_digests (unique on week_start_date).
//
// Schedule: pg_cron tender-scrape-weekly, Mondays 06:00 UTC (see
// sprint4_payroll_tenders_polish migration).
// On-demand: POST /functions/v1/tender-scrape with admin JWT.
//
// Optional body: { sendTestTo?: string }
//   When sendTestTo is set, we skip the scrape + upsert phase entirely and
//   re-send the MOST RECENT existing digest to that single email address.
//   The DB row's sent_at / sent_to columns are NOT updated for test sends —
//   only the regular weekly broadcast updates them. This lets an admin POST
//   a "send test digest to me" without polluting the real audit trail.
//
// Returns:
//   { sources: [{ id, added, updated, error }],
//     digest: { weekStartDate, weekEndDate, newThisWeekCount, activeOpenCount,
//               tenderCount /* legacy alias for newThisWeekCount */ },
//     sent:   { ok, recipients, skippedReason?, error? } }
//
// Per-source failures are caught and recorded in tender_sources.last_error;
// the run continues with the next source.
//
// Email delivery (Resend):
//   - RESEND_API_KEY               required to send; missing → skip with warn
//   - TENDER_DIGEST_RECIPIENTS     comma-separated list; empty → skip
//   - TENDER_DIGEST_FROM           verified sender (default: onboarding@resend.dev)
//   On a non-2xx Resend response we log an integration_alerts row of kind
//   'tender_digest_send_failed' and still return 200 — a digest was generated,
//   it just didn't get emailed.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ---------------------------------------------------------------------------
// normalizeTenderUrl
//
// Strip tracking params, lowercase the host, drop the fragment, trim a
// trailing slash, and sort the remaining query parameters so that the same
// listing reachable via different query strings collapses to a single key.
// Used at write-time only — existing rows with raw URLs keep their old keys.
// ---------------------------------------------------------------------------
function normalizeTenderUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const STRIP = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid','sessionid','session_id','sid','mc_cid','mc_eid']);
    for (const key of [...u.searchParams.keys()]) {
      if (STRIP.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    const sortedKeys = [...u.searchParams.keys()].sort();
    const sp = new URLSearchParams();
    for (const k of sortedKeys) {
      for (const v of u.searchParams.getAll(k)) sp.append(k, v);
    }
    u.search = sp.toString() ? '?' + sp.toString() : '';
    return u.toString();
  } catch {
    return rawUrl.trim();
  }
}

// ---------------------------------------------------------------------------
// Auth (inlined — Edge Functions cannot share modules across functions)
// ---------------------------------------------------------------------------
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function verifyAdminOrServiceRole(
  req: Request,
  supabaseUrl: string,
  supabaseAnonKey: string,
  serviceRoleKey: string,
): Promise<Response | null> {
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization')
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return new Response(
      JSON.stringify({ error: 'Missing or malformed Authorization header' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 },
    )
  }
  const token = authHeader.slice(7).trim()

  // Cron path: pg_cron POSTs with the service_role_key in the bearer; allow it.
  if (serviceRoleKey && constantTimeEqual(token, serviceRoleKey)) {
    return null
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser(token)
  if (userErr || !userData?.user) {
    return new Response(
      JSON.stringify({ error: 'Invalid or expired user token' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 },
    )
  }

  const { data: profile, error: profileErr } = await userClient
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileErr || !profile || profile.role !== 'admin') {
    return new Response(
      JSON.stringify({ error: 'Admin privileges required' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 },
    )
  }

  return null
}

// ---------------------------------------------------------------------------
// fetchWithTimeout
// ---------------------------------------------------------------------------

// SSRF guard. base_url is admin-configured, but a typo'd/hostile source row (or
// a compromised admin) must not be able to make this service-role function
// fetch internal infrastructure — cloud metadata at 169.254.169.254, localhost
// admin panels, RFC-1918 hosts. Reject non-http(s) schemes and any host that is
// a private/loopback/link-local literal. Hostname-based; DNS-rebinding to a
// private IP is out of scope (the source list is admin-trust-bounded).
function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "") // strip IPv6 brackets
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1" || h === "::")
    return true
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1]),
      b = Number(m[2])
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true // link-local incl. cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true // IPv6 ULA / link-local
  return false
}

function assertSafeFetchUrl(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`invalid URL: ${url}`)
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked non-http(s) scheme: ${u.protocol}`)
  }
  if (isPrivateOrLocalHost(u.hostname)) {
    throw new Error(`blocked private/loopback host: ${u.hostname}`)
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 20000,
): Promise<Response> {
  assertSafeFetchUrl(url)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      const e = new Error(`fetch timed out after ${ms}ms: ${url}`) as Error & {
        isTimeout?: boolean
      }
      e.isTimeout = true
      throw e
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Per-source scrapers
//
// Each scraper returns { items, error? } where items is an array of normalized
// tender records. A non-fatal error string in the result is recorded against
// tender_sources.last_error but does not abort the rest of the run.
// ---------------------------------------------------------------------------
interface ScrapedItem {
  title: string
  url: string
  closingDate?: string | null
  summary?: string | null
}

interface ScrapeResult {
  items: ScrapedItem[]
  error?: string
}

// ---- halton-region scraper ----
//
// Expected upstream: https://www.halton.ca/business/tenders is a server-
// rendered HTML page. The actual DOM structure (selectors, anchor patterns)
// varies per release and we don't want to ship a brittle CSS-selector
// implementation here — and pulling in deno_dom adds ~3MB to the bundle for a
// page that's read once a week.
//
// Instead we use a STRUCTURAL TEXT PARSER:
//   - Fetch the page HTML.
//   - Look for anchor tags whose href looks like a tender posting
//     (case-insensitive substring "tender", "rfp", "rfq", or "bid").
//   - Extract the anchor text as the title and the (possibly relative) href
//     as the URL.
//   - closingDate / summary are left null — the per-portal HTML doesn't
//     consistently surface them and the daily admin UI can be edited
//     manually for now. Once the real Halton DOM is wired up, swap this
//     regex pass for a deno_dom-based selector chain.
//
// This deliberately returns an EMPTY array (with no error) if the page
// returns 200 but contains no anchors that match — the page may be empty
// during a quiet bid cycle and that's a normal outcome, not a failure.
async function scrapeHaltonRegion(baseUrl: string): Promise<ScrapeResult> {
  let res: Response
  try {
    res = await fetchWithTimeout(baseUrl, {
      headers: {
        // Some municipal portals 403 default Deno UAs.
        'User-Agent': 'Mozilla/5.0 (compatible; YardwardCRM-TenderBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    }, 25000)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { items: [], error: `fetch failed: ${message}` }
  }

  if (!res.ok) {
    return { items: [], error: `HTTP ${res.status} ${res.statusText}` }
  }

  let html: string
  try {
    html = await res.text()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { items: [], error: `read body failed: ${message}` }
  }

  // Anchor extractor. The capture groups are:
  //   1 = href value (quoted)
  //   2 = inner text (raw, may contain inline HTML which we strip below).
  // Anchors with the relevant keywords in either href or inner text qualify.
  const items: ScrapedItem[] = []
  const seenUrls = new Set<string>()
  const anchorRe = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  const keyword = /\b(tender|rfp|rfq|bid)\b/i
  const base = new URL(baseUrl)

  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1] ?? match[2] ?? ''
    const rawText = match[3] ?? ''
    const text = rawText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!href || !text) continue
    if (!keyword.test(href) && !keyword.test(text)) continue
    // Skip the in-page anchors / nav.
    if (href.startsWith('#')) continue

    let absolute: string
    try {
      absolute = new URL(href, base).toString()
    } catch {
      continue
    }
    if (seenUrls.has(absolute)) continue
    seenUrls.add(absolute)

    items.push({
      title: text.slice(0, 500),
      url: absolute,
      closingDate: null,
      summary: null,
    })
  }

  return { items }
}

// ---- demo-feed scraper ----
//
// Expects a JSON array of objects with shape
//   { title: string, url: string, closingDate?: string, summary?: string }
// Anything missing title/url is silently dropped.
async function scrapeDemoFeed(baseUrl: string): Promise<ScrapeResult> {
  let res: Response
  try {
    res = await fetchWithTimeout(baseUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'YardwardCRM-TenderBot/1.0',
      },
    }, 15000)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { items: [], error: `fetch failed: ${message}` }
  }

  if (!res.ok) {
    return { items: [], error: `HTTP ${res.status} ${res.statusText}` }
  }

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { items: [], error: `invalid JSON: ${message}` }
  }

  if (!Array.isArray(parsed)) {
    return { items: [], error: 'expected a JSON array' }
  }

  const items: ScrapedItem[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const title = typeof e.title === 'string' ? e.title.trim() : ''
    const url = typeof e.url === 'string' ? e.url.trim() : ''
    if (!title || !url) continue
    const closingDate = typeof e.closingDate === 'string' ? e.closingDate : null
    const summary = typeof e.summary === 'string' ? e.summary : null
    items.push({ title: title.slice(0, 500), url, closingDate, summary })
  }
  return { items }
}

// ---- scraper dispatch ----
async function scrapeSource(sourceId: string, baseUrl: string): Promise<ScrapeResult> {
  switch (sourceId) {
    case 'halton-region':
      return scrapeHaltonRegion(baseUrl)
    case 'demo-feed':
      return scrapeDemoFeed(baseUrl)
    default:
      return { items: [], error: `no scraper registered for source '${sourceId}'` }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tenderId(): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  return `TND-${Date.now().toString(36)}-${rand}`
}

// closing_date is `date` in Postgres; coerce loosely-typed strings into
// YYYY-MM-DD. Returns null when the input isn't parseable.
function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Already-iso dates pass through.
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) return isoMatch[1]
  const parsed = new Date(trimmed)
  if (isNaN(parsed.getTime())) return null
  // Normalise to UTC midnight YYYY-MM-DD.
  return parsed.toISOString().slice(0, 10)
}

// Last Monday at 00:00 UTC for the supplied reference date.
function lastMondayUtc(ref: Date): Date {
  const d = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()))
  // getUTCDay: 0 = Sun, 1 = Mon, … 6 = Sat. We want days since Monday.
  const day = d.getUTCDay()
  const deltaToMonday = (day + 6) % 7 // Mon→0, Tue→1, … Sun→6
  d.setUTCDate(d.getUTCDate() - deltaToMonday)
  return d
}

interface TenderSourceRow {
  id: string
  name: string
  base_url: string
  enabled: boolean
}

interface SourceResult {
  id: string
  added: number
  updated: number
  error: string | null
}

interface ExistingTenderRow {
  id: string
  url: string
}

// ---------------------------------------------------------------------------
// Digest email helpers
// ---------------------------------------------------------------------------

interface DigestTenderPreview {
  id: string
  source: string
  title: string
  url: string
  closingDate: string | null
  summary: string | null
}

interface DigestContent {
  newThisWeekCount: number
  activeOpenCount: number
  openTendersPreview: DigestTenderPreview[]
  summary: string
  weekStartDate: string
  weekEndDate: string
  generatedAt: string
}

// Defensive HTML escape — scraped titles and source ids can contain ampersands,
// angle brackets, or quotes that would break the digest layout or, worse,
// inject markup. We render plain inline-styled HTML so this is the only
// sanitisation layer between the scraper and the recipient's inbox.
function escapeHtml(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  const s = String(raw)
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// VITE_APP_URL is set on the function for the CTA link; fall back to a
// reasonable default so the email doesn't ship a dead link in local dev.
function buildDigestEmail(content: DigestContent): { subject: string; html: string } {
  const appUrl = (Deno.env.get('TENDER_DIGEST_APP_URL') ?? 'https://yardward.pro').replace(/\/$/, '')
  const adminTendersUrl = `${appUrl}/admin/tenders`

  const newCount = content.newThisWeekCount
  const subject = `Yardward weekly tender digest — ${newCount} new this week`

  const rangeLabel = `${escapeHtml(content.weekStartDate)} → ${escapeHtml(content.weekEndDate)}`
  const previewRows = (content.openTendersPreview ?? []).slice(0, 10)

  const rowsHtml = previewRows.length === 0
    ? `<tr><td colspan="4" style="padding:16px;color:#6b7280;font-family:Arial,Helvetica,sans-serif;font-size:13px;text-align:center;">No open tenders to show.</td></tr>`
    : previewRows.map((t) => {
        const closing = t.closingDate ? escapeHtml(t.closingDate) : '<span style="color:#9ca3af;">—</span>'
        return `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#111827;vertical-align:top;">${escapeHtml(t.title)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-family:Menlo,Consolas,monospace;font-size:12px;color:#374151;vertical-align:top;white-space:nowrap;">${escapeHtml(t.source)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-family:Menlo,Consolas,monospace;font-size:12px;color:#374151;vertical-align:top;white-space:nowrap;">${closing}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:13px;vertical-align:top;"><a href="${escapeHtml(t.url)}" style="color:#b45309;text-decoration:none;">View →</a></td>
          </tr>`
      }).join('')

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;max-width:640px;">
          <tr>
            <td style="padding:24px 28px 8px 28px;">
              <h1 style="margin:0;font-size:20px;font-weight:700;color:#111827;font-family:Arial,Helvetica,sans-serif;">Weekly tender digest</h1>
              <p style="margin:4px 0 0 0;font-size:12px;color:#6b7280;font-family:Menlo,Consolas,monospace;">Week ${rangeLabel}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 8px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;">
                <tr>
                  <td style="padding:16px 18px;">
                    <div style="font-size:28px;font-weight:700;color:#92400e;font-family:Arial,Helvetica,sans-serif;line-height:1;">${escapeHtml(newCount)}</div>
                    <div style="margin-top:4px;font-size:13px;color:#78350f;font-family:Arial,Helvetica,sans-serif;">new tender${newCount === 1 ? '' : 's'} scraped this week</div>
                    <div style="margin-top:8px;font-size:12px;color:#6b7280;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(content.activeOpenCount)} currently open across all weeks</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 0 28px;">
              <h2 style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#111827;font-family:Arial,Helvetica,sans-serif;">Active open tenders (any week)</h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:6px;border-collapse:separate;border-spacing:0;">
                <thead>
                  <tr style="background:#f9fafb;">
                    <th align="left" style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Title</th>
                    <th align="left" style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Source</th>
                    <th align="left" style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Closing</th>
                    <th align="left" style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Link</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 28px 24px 28px;">
              <a href="${escapeHtml(adminTendersUrl)}" style="display:inline-block;padding:10px 18px;background:#b45309;color:#ffffff;border-radius:6px;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:600;">View all tenders →</a>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 24px 28px;border-top:1px solid #e5e7eb;background:#f9fafb;">
              <p style="margin:0;font-size:11px;color:#6b7280;font-family:Arial,Helvetica,sans-serif;text-align:center;">Generated by Yardward Pro · ${escapeHtml(content.generatedAt)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, html }
}

// parseRecipients normalises the TENDER_DIGEST_RECIPIENTS comma-separated env
// var into a deduped list of trimmed addresses. Returns an empty array if the
// env var is missing or only contains whitespace / empty segments.
function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(',')) {
    const v = part.trim()
    if (!v) continue
    const lower = v.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(v)
  }
  return out
}

interface SendOutcome {
  ok: boolean
  recipients: string[]
  skippedReason?: string
  error?: string
}

// sendDigestViaResend POSTs the rendered digest to Resend's /emails endpoint.
// Returns an outcome object describing whether the send happened, was skipped
// (missing env), or failed (non-2xx) — never throws to the caller, since a
// failed email is non-fatal: the digest row is already in the DB.
async function sendDigestViaResend(
  apiKey: string,
  from: string,
  recipients: string[],
  subject: string,
  html: string,
): Promise<SendOutcome> {
  try {
    const res = await fetchWithTimeout(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: recipients,
          subject,
          html,
        }),
      },
      15000,
    )
    if (!res.ok) {
      let body = ''
      try { body = await res.text() } catch { /* ignore */ }
      return {
        ok: false,
        recipients,
        error: `Resend HTTP ${res.status}: ${body.slice(0, 500)}`,
      }
    }
    return { ok: true, recipients }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, recipients, error: `Resend fetch failed: ${message}` }
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    const missing = [
      !SUPABASE_URL && 'SUPABASE_URL',
      !SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY',
      !SERVICE_ROLE_KEY && 'SUPABASE_SERVICE_ROLE_KEY',
    ]
      .filter(Boolean)
      .join(', ')
    console.error(`tender-scrape: missing env vars: ${missing}`)
    return new Response(
      JSON.stringify({ error: `Server misconfigured: missing env vars: ${missing}` }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    )
  }

  const authFailure = await verifyAdminOrServiceRole(
    req,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SERVICE_ROLE_KEY,
  )
  if (authFailure) return authFailure

  const startedAt = Date.now()
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // Parse the body once. The body is optional (cron POSTs an empty body); the
  // only field we care about is sendTestTo, which short-circuits to "re-send
  // the most recent digest to this address" without scraping.
  let sendTestTo: string | null = null
  if (req.method === 'POST') {
    try {
      const body = await req.json() as { sendTestTo?: unknown } | null
      if (body && typeof body.sendTestTo === 'string' && body.sendTestTo.trim()) {
        sendTestTo = body.sendTestTo.trim()
      }
    } catch {
      // No body / non-JSON body is the normal cron path — proceed.
    }
  }

  // ----- Test-send path: skip scrape, re-send the most recent digest. -----
  if (sendTestTo) {
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
    const TENDER_DIGEST_FROM = Deno.env.get('TENDER_DIGEST_FROM') ?? 'onboarding@resend.dev'
    if (!RESEND_API_KEY) {
      return new Response(
        JSON.stringify({
          error: 'RESEND_API_KEY is not configured on the function — cannot send test digest.',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 },
      )
    }
    const { data: latest, error: latestErr } = await supabase
      .from('tender_digests')
      .select('id, week_start_date, week_end_date, tender_count, content')
      .order('week_start_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestErr || !latest) {
      return new Response(
        JSON.stringify({
          error: latestErr?.message ?? 'No tender digest exists yet — run the scraper first.',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 404 },
      )
    }
    const rawContent = (latest.content ?? {}) as Partial<DigestContent>
    const content: DigestContent = {
      newThisWeekCount: typeof rawContent.newThisWeekCount === 'number'
        ? rawContent.newThisWeekCount
        : latest.tender_count ?? 0,
      activeOpenCount: typeof rawContent.activeOpenCount === 'number'
        ? rawContent.activeOpenCount
        : 0,
      openTendersPreview: Array.isArray(rawContent.openTendersPreview)
        ? rawContent.openTendersPreview as DigestTenderPreview[]
        : [],
      summary: typeof rawContent.summary === 'string' ? rawContent.summary : '',
      weekStartDate: latest.week_start_date,
      weekEndDate: latest.week_end_date,
      generatedAt: typeof rawContent.generatedAt === 'string'
        ? rawContent.generatedAt
        : new Date().toISOString(),
    }
    const { subject, html } = buildDigestEmail(content)
    const outcome = await sendDigestViaResend(
      RESEND_API_KEY,
      TENDER_DIGEST_FROM,
      [sendTestTo],
      `[TEST] ${subject}`,
      html,
    )
    if (!outcome.ok) {
      console.error(`tender-scrape: test digest send failed: ${outcome.error}`)
      // Best-effort alert; don't block the response on logging.
      try {
        await supabase.from('integration_alerts').insert({
          kind: 'tender_digest_send_failed',
          message: `Test digest send to ${sendTestTo} failed: ${outcome.error}`,
          context: { mode: 'test', digestId: latest.id, recipient: sendTestTo, error: outcome.error },
        })
      } catch (alertErr) {
        console.error('integration_alerts insert failed for test send:', alertErr)
      }
      return new Response(
        JSON.stringify({
          sent: outcome,
          digest: {
            weekStartDate: latest.week_start_date,
            weekEndDate: latest.week_end_date,
            newThisWeekCount: content.newThisWeekCount,
            activeOpenCount: content.activeOpenCount,
            tenderCount: content.newThisWeekCount,
          },
          durationMs: Date.now() - startedAt,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 502 },
      )
    }
    return new Response(
      JSON.stringify({
        sent: outcome,
        digest: {
          weekStartDate: latest.week_start_date,
          weekEndDate: latest.week_end_date,
          newThisWeekCount: content.newThisWeekCount,
          activeOpenCount: content.activeOpenCount,
          tenderCount: content.newThisWeekCount,
        },
        durationMs: Date.now() - startedAt,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
    )
  }

  try {
    // ----- 1. Load enabled sources -----
    const { data: sources, error: srcErr } = await supabase
      .from('tender_sources')
      .select('id, name, base_url, enabled')
      .eq('enabled', true)
    if (srcErr) {
      console.error('tender_sources select failed:', srcErr)
      return new Response(
        JSON.stringify({ error: `Failed to load tender_sources: ${srcErr.message}` }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }
    const sourceList = (sources ?? []) as TenderSourceRow[]
    console.log(`tender-scrape: loaded ${sourceList.length} enabled source(s).`)

    // ----- 2. For each source, scrape + upsert -----
    const sourceResults: SourceResult[] = []

    for (const src of sourceList) {
      const result: SourceResult = { id: src.id, added: 0, updated: 0, error: null }
      let scrapeError: string | null = null

      let scrape: ScrapeResult
      try {
        scrape = await scrapeSource(src.id, src.base_url)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        scrape = { items: [], error: `scraper threw: ${message}` }
      }
      if (scrape.error) scrapeError = scrape.error

      if (scrape.items.length > 0) {
        // Look up existing rows for these URLs so we can attribute add vs update.
        // url isn't unique in the schema (text PK), so we do the dedup in app
        // code: find existing url → reuse id, else mint a fresh TND-... id.
        // Normalize once and use the normalized URL for both the lookup and
        // the upsert payload so the same listing reachable via different
        // query strings collapses to a single key.
        const normalizedItemsRaw = scrape.items.map((item) => ({
          item,
          url: normalizeTenderUrl(item.url),
        }))
        // Dedupe within this source run by normalized URL — keep first occurrence.
        // Without this, two anchors that normalize to the same URL but have no
        // existing row both mint fresh ids and INSERT separate rows.
        const seenUrls = new Set<string>()
        const normalizedItems: typeof normalizedItemsRaw = []
        for (const n of normalizedItemsRaw) {
          if (seenUrls.has(n.url)) continue
          seenUrls.add(n.url)
          normalizedItems.push(n)
        }
        const urls = Array.from(seenUrls)
        const { data: existing, error: existErr } = await supabase
          .from('tenders')
          .select('id, url')
          .in('url', urls)
        if (existErr) {
          console.error(`tenders lookup failed for source ${src.id}:`, existErr)
          scrapeError = scrapeError
            ? `${scrapeError}; lookup failed: ${existErr.message}`
            : `lookup failed: ${existErr.message}`
        } else {
          const urlToId = new Map<string, string>()
          for (const row of (existing ?? []) as ExistingTenderRow[]) {
            urlToId.set(row.url, row.id)
          }

          const rows = normalizedItems.map(({ item, url }) => {
            const id = urlToId.get(url) ?? tenderId()
            const isExisting = urlToId.has(url)
            if (isExisting) result.updated += 1
            else result.added += 1
            return {
              id,
              source: src.id,
              title: item.title.slice(0, 500),
              url,
              closing_date: toIsoDate(item.closingDate),
              summary: item.summary ?? '',
              scraped_at: new Date().toISOString(),
            }
          })

          // Upsert on id PK. We constructed ids to collide for existing URLs
          // so this is genuinely idempotent on URL.
          const { error: upsertErr } = await supabase
            .from('tenders')
            .upsert(rows, { onConflict: 'id' })
          if (upsertErr) {
            console.error(`tenders upsert failed for source ${src.id}:`, upsertErr)
            scrapeError = scrapeError
              ? `${scrapeError}; upsert failed: ${upsertErr.message}`
              : `upsert failed: ${upsertErr.message}`
            // Roll back the counters since the rows didn't land.
            result.added = 0
            result.updated = 0
          }
        }
      }

      result.error = scrapeError

      // Always update last_run_at + last_error; a quiet success clears the
      // previous error.
      const { error: srcUpdErr } = await supabase
        .from('tender_sources')
        .update({
          last_run_at: new Date().toISOString(),
          last_error: scrapeError,
        })
        .eq('id', src.id)
      if (srcUpdErr) {
        console.error(`tender_sources update failed for ${src.id}:`, srcUpdErr)
      }

      sourceResults.push(result)
    }

    // ----- 3. Weekly digest -----
    const now = new Date()
    const weekStart = lastMondayUtc(now)
    const weekEnd = new Date(weekStart)
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7)
    const weekStartIso = weekStart.toISOString().slice(0, 10)
    const weekEndIso = weekEnd.toISOString().slice(0, 10)

    // Two distinct counts power the digest:
    //   - newThisWeekCount: tenders scraped during the current week window
    //     that are still open. This answers "what did the scraper find this
    //     week?".
    //   - openTendersPreview: the top 10 currently-open tenders across ANY
    //     week, sorted soonest-to-close. This answers "what should an admin
    //     act on right now?".
    // The two intentionally have different denominators — a quiet scrape
    // week can still surface a long backlog of open tenders, and vice versa.
    const todayIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      .toISOString()
      .slice(0, 10)

    // Treat NULL closing_date as "still open" — the Halton scraper doesn't
    // surface closing dates, so excluding NULLs would zero out the digest.
    let newThisWeekCount = 0
    const { count, error: countErr } = await supabase
      .from('tenders')
      .select('id', { count: 'exact', head: true })
      .gte('scraped_at', weekStart.toISOString())
      .or('closing_date.is.null,closing_date.gte.' + todayIso)
    if (countErr) {
      console.error('tenders count failed:', countErr)
    } else {
      newThisWeekCount = count ?? 0
    }

    // Total currently-open tenders across any week — separate from the
    // weekly scrape count so the digest can show "M currently open" alongside
    // the "N scraped this week" number.
    let activeOpenCount = 0
    const { count: openCount, error: openCountErr } = await supabase
      .from('tenders')
      .select('id', { count: 'exact', head: true })
      .or('closing_date.is.null,closing_date.gte.' + todayIso)
    if (openCountErr) {
      console.error('active open tenders count failed:', openCountErr)
    } else {
      activeOpenCount = openCount ?? 0
    }

    const { data: topTenders, error: topErr } = await supabase
      .from('tenders')
      .select('id, source, title, url, closing_date, summary, scraped_at')
      .or('closing_date.is.null,closing_date.gte.' + todayIso)
      .order('closing_date', { ascending: true, nullsFirst: false })
      .limit(10)
    if (topErr) {
      console.error('top tenders select failed:', topErr)
    }

    const openTendersPreview = (topTenders ?? []).map((t) => ({
      id: t.id,
      source: t.source,
      title: t.title,
      url: t.url,
      closingDate: t.closing_date,
      summary: t.summary,
    }))

    // Summary string makes the two counts explicit so the same line works in
    // the admin UI card and in the email digest body. Phrasing avoids the
    // ambiguous bare "N tenders" that previously read as either count.
    const newPhrase = newThisWeekCount === 0
      ? 'No new tenders scraped this week'
      : `${newThisWeekCount} new tender${newThisWeekCount === 1 ? '' : 's'} scraped this week`
    const openPhrase = `${activeOpenCount} currently open across all weeks`
    const summary = `${newPhrase}. ${openPhrase}.`

    const digestContent = {
      // Canonical, unambiguous field names. Consumers (admin UI, email send
      // path) should prefer these over the legacy aliases below.
      newThisWeekCount,
      activeOpenCount,
      openTendersPreview,
      // Legacy aliases — kept so the existing admin UI and any other reader
      // that hasn't been migrated yet keeps working. Safe to drop once every
      // consumer reads the explicit fields above.
      tenders: openTendersPreview,
      summary,
      weekStartDate: weekStartIso,
      weekEndDate: weekEndIso,
      generatedAt: new Date().toISOString(),
    }

    // Upsert returning the row id so we can stamp sent_at / sent_to after a
    // successful email send. .select() on a Supabase upsert returns the
    // affected rows including the generated id for first-time inserts.
    const { data: digestRows, error: digestErr } = await supabase
      .from('tender_digests')
      .upsert(
        {
          week_start_date: weekStartIso,
          week_end_date: weekEndIso,
          // tender_count column stores the new-this-week number (its original
          // meaning); the broader "active open" figure lives only in content
          // since the column is a single integer.
          tender_count: newThisWeekCount,
          content: digestContent,
          generated_at: new Date().toISOString(),
        },
        { onConflict: 'week_start_date' },
      )
      .select('id')
    if (digestErr) {
      console.error('tender_digests upsert failed:', digestErr)
    }
    const digestId: string | null = digestRows && digestRows.length > 0
      ? (digestRows[0].id as string)
      : null

    // ----- 4. Email the digest via Resend (best-effort) -----
    //
    // The send is intentionally optional and non-fatal: a missing API key or
    // empty recipient list means "skip", which leaves the digest row in the
    // DB but unsent. The admin UI surfaces sent_at / sent_to so the human can
    // tell at a glance whether the broadcast happened.
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
    const TENDER_DIGEST_RECIPIENTS_RAW = Deno.env.get('TENDER_DIGEST_RECIPIENTS')
    const TENDER_DIGEST_FROM = Deno.env.get('TENDER_DIGEST_FROM') ?? 'onboarding@resend.dev'
    const recipients = parseRecipients(TENDER_DIGEST_RECIPIENTS_RAW)
    let sentOutcome: SendOutcome
    if (!RESEND_API_KEY) {
      console.warn(
        'tender-scrape: RESEND_API_KEY not set — skipping digest email send.',
      )
      sentOutcome = { ok: false, recipients: [], skippedReason: 'RESEND_API_KEY not set' }
    } else if (recipients.length === 0) {
      console.warn(
        'tender-scrape: TENDER_DIGEST_RECIPIENTS not set or empty — skipping digest email send.',
      )
      sentOutcome = {
        ok: false,
        recipients: [],
        skippedReason: 'TENDER_DIGEST_RECIPIENTS not set',
      }
    } else {
      const { subject, html } = buildDigestEmail(digestContent as DigestContent)
      sentOutcome = await sendDigestViaResend(
        RESEND_API_KEY,
        TENDER_DIGEST_FROM,
        recipients,
        subject,
        html,
      )
      if (!sentOutcome.ok) {
        console.error(`tender-scrape: digest email send failed: ${sentOutcome.error}`)
        try {
          await supabase.from('integration_alerts').insert({
            kind: 'tender_digest_send_failed',
            message: `Weekly digest send failed for week ${weekStartIso}: ${sentOutcome.error}`,
            context: {
              mode: 'weekly',
              digestId,
              weekStartDate: weekStartIso,
              recipients,
              error: sentOutcome.error,
            },
          })
        } catch (alertErr) {
          console.error('integration_alerts insert failed for weekly send:', alertErr)
        }
      } else if (digestId) {
        // Stamp the row so the admin UI can show "last sent: TIMESTAMP".
        const { error: stampErr } = await supabase
          .from('tender_digests')
          .update({ sent_at: new Date().toISOString(), sent_to: recipients })
          .eq('id', digestId)
        if (stampErr) {
          // The email DID go out; failing to record sent_at is a soft error
          // worth surfacing but not worth reversing the send for.
          console.error('tender_digests sent_at stamp failed:', stampErr)
        }
      }
    }

    const payload = {
      sources: sourceResults,
      digest: {
        weekStartDate: weekStartIso,
        weekEndDate: weekEndIso,
        newThisWeekCount,
        activeOpenCount,
        // Legacy alias — old admin UI builds read tenderCount; keep it
        // mirroring the new-this-week number so they continue to render.
        tenderCount: newThisWeekCount,
      },
      sent: sentOutcome,
      durationMs: Date.now() - startedAt,
    }

    console.log(`tender-scrape done: ${JSON.stringify(payload)}`)
    return new Response(JSON.stringify(payload), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const isTimeout = !!(err as { isTimeout?: boolean })?.isTimeout
    console.error('tender-scrape fatal error:', message)
    return new Response(
      JSON.stringify({
        error: message,
        durationMs: Date.now() - startedAt,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: isTimeout ? 504 : 500,
      },
    )
  }
})
