// Supabase Edge Function: formstack-import
//
// Pulls form submissions (hauling records / dump forms) from the Formstack
// v2025 API and upserts them into public.formstack_submissions. Incremental
// by default: each form's high-water mark is the max(submitted_at) already
// in the table, passed back to Formstack as minTime so re-runs only fetch
// new submissions. Re-fetching the boundary row is harmless (upsert by id).
//
// Invocation:
//   supabase.functions.invoke('formstack-import', {
//     body: { formIds?: number[], dryRun?: boolean, fullResync?: boolean }
//   })
//   - formIds omitted  -> every active form with >0 submissions
//   - dryRun=true      -> fetch + diff, skip all writes, return counts+samples
//   - fullResync=true  -> ignore high-water marks, refetch everything
//
// Auth: admin user JWT or service_role bearer (shared _shared/auth.ts gate).
//
// Secrets:
//   FORMSTACK_ACCESS_TOKEN - personal access token (fs_pat_...). PATs only
//     work against /api/v2025 — the legacy /api/v2 endpoints 401 them.
//     NOTE: Formstack PATs expire after 30/60/90 days; the Integrations tab
//     probe surfaces this, and a 401 here returns a regenerate hint.
//
// Formstack API notes (verified against the live API 2026-06-10):
//   - GET /api/v2025/forms?pageNumber=N&pageSize=50            (list forms)
//   - GET /api/v2025/forms/{id}/submissions?pageNumber=N&pageSize=100
//         &data=true&dataFormat=standardized&expandData=true&order=ASC
//         &minTime=YYYY-MM-DD HH:mm:ss                          (submissions)
//   - pageSize minimums exist (pageSize=1 -> HTTP 400); 10/50/100 verified.
//   - Submission timestamps are account-local time (America/Toronto for this
//     account — verified against parsedValue offsets), NOT UTC. We convert
//     to UTC on the way in and convert high-water marks back on the way out.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAdminOrServiceRole } from "../_shared/auth.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonOk(b: unknown, status = 200) {
  return new Response(JSON.stringify(b), {
    headers: { ...cors, "Content-Type": "application/json" },
    status,
  });
}

const FORMSTACK_BASE = "https://www.formstack.com/api/v2025";
const PAGE_SIZE = 100;
// Supabase edge functions get killed on a wall-clock limit (~150s). A full
// first-time backfill (~15k submissions / 150+ pages) cannot finish in one
// invocation, so we stop starting new forms once this budget is spent and
// return partial=true + remainingFormIds. The SPA loops until done — the
// per-form high-water marks make every continuation cheap and idempotent.
const TIME_BUDGET_MS = 100_000;
// 200 pages * 100 rows = 20k submissions per form per run; the largest form
// today is ~7.5k. A capped form logs a warning in the response rather than
// silently truncating.
const MAX_PAGES_PER_FORM = 200;
const UPSERT_CHUNK_SIZE = 200;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Timezone: Formstack submission timestamps are account-local. This account
// is America/Toronto. Two-pass offset resolution handles DST transitions.
// ---------------------------------------------------------------------------

const ACCOUNT_TZ = "America/Toronto";

function tzOffsetMs(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ACCOUNT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  const localAsUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return localAsUtc - utcMs;
}

// 'YYYY-MM-DD HH:mm:ss' in account-local time -> UTC ISO (or null).
function accountLocalToUtcIso(ts: string): string | null {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const naiveUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  let off = tzOffsetMs(naiveUtc);
  off = tzOffsetMs(naiveUtc - off);
  return new Date(naiveUtc - off).toISOString();
}

// UTC ISO -> 'YYYY-MM-DD HH:mm:ss' in account-local time (for minTime).
function utcIsoToAccountLocal(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ACCOUNT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

// ---------------------------------------------------------------------------
// Formstack HTTP — timeout + 429 retry with Retry-After/backoff
// ---------------------------------------------------------------------------

class FormstackError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

async function fsGet<T>(path: string, token: string, attempt = 0): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${FORMSTACK_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") {
      throw new FormstackError(`Formstack request timed out after ${FETCH_TIMEOUT_MS}ms: ${path}`);
    }
    throw new FormstackError(
      `Network error reaching Formstack: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(2 ** attempt * 1000, 8000);
    await new Promise((r) => setTimeout(r, waitMs));
    return fsGet<T>(path, token, attempt + 1);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    const hint = res.status === 401
      ? " (PAT expired or revoked? Formstack PATs live 30/60/90 days — regenerate in admin.formstack.com and run `supabase secrets set FORMSTACK_ACCESS_TOKEN=...`)"
      : "";
    throw new FormstackError(
      `Formstack ${path} returned HTTP ${res.status}: ${bodyText.slice(0, 300)}${hint}`,
      res.status,
    );
  }
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new FormstackError(`Formstack ${path}: non-JSON 200 response`, 200);
  }
}

// ---------------------------------------------------------------------------
// API shapes (v2025, dataFormat=standardized)
// ---------------------------------------------------------------------------

interface FsFormPreview {
  id: number;
  name?: string | null;
  active?: boolean | null;
  submissionsCount?: number | null;
}

interface FsFormsPage {
  page?: { totalPages?: number };
  forms?: FsFormPreview[];
}

interface FsField {
  field?: string;
  label?: string | null;
  type?: string | null;
  displayValue?: string | null;
  parsedValue?: unknown;
}

interface FsSubmission {
  id: number;
  formId: number;
  timestamp?: string | null;
  data?: FsField[] | null;
}

interface FsSubmissionsPage {
  page?: { totalPages?: number; totalElements?: number };
  submissions?: FsSubmission[];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface SubmissionRow {
  id: string;
  submission_id: number;
  form_id: number;
  form_name: string;
  submitted_at: string | null;
  summary: string;
  data: FsField[];
}

function buildSummary(data: FsField[]): string {
  const parts: string[] = [];
  for (const f of data) {
    const v = (f.displayValue ?? "").toString().replace(/\s+/g, " ").trim();
    if (!v) continue;
    parts.push(v);
    if (parts.length >= 4) break;
  }
  const s = parts.join(" | ");
  return s.length > 240 ? `${s.slice(0, 237)}...` : s;
}

function mapSubmission(s: FsSubmission, formName: string): SubmissionRow {
  const data = Array.isArray(s.data) ? s.data : [];
  return {
    id: `FS-${s.id}`,
    submission_id: s.id,
    form_id: s.formId,
    form_name: formName,
    submitted_at: s.timestamp ? accountLocalToUtcIso(s.timestamp) : null,
    summary: buildSummary(data),
    data,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Main handler (wrapped so uncaught throws return structured JSON; the stack
// goes to console.error only — never into the response body).
// ---------------------------------------------------------------------------

interface ImportBody {
  formIds?: number[];
  dryRun?: boolean;
  fullResync?: boolean;
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return jsonOk({ error: "POST only" }, 405);

  const startedAt = Date.now();

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return jsonOk({ error: "Missing supabase env" }, 500);
  }

  const authFailure = await verifyAdminOrServiceRole(req, {
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    serviceRoleKey: SERVICE_ROLE_KEY,
    corsHeaders: cors,
  });
  if (authFailure) return authFailure;

  const token = Deno.env.get("FORMSTACK_ACCESS_TOKEN") ?? "";
  if (!token) {
    return jsonOk(
      {
        ok: false,
        error:
          "FORMSTACK_ACCESS_TOKEN not set — generate a Personal Access Token in admin.formstack.com and run `supabase secrets set FORMSTACK_ACCESS_TOKEN=fs_pat_...`",
      },
      400,
    );
  }

  let body: ImportBody;
  try {
    body = req.body ? ((await req.json()) as ImportBody) : {};
  } catch {
    return jsonOk({ error: "Body must be JSON" }, 400);
  }
  const dryRun = body.dryRun === true;
  const fullResync = body.fullResync === true;
  const requestedFormIds = Array.isArray(body.formIds)
    ? body.formIds.filter((n) => Number.isInteger(n) && n > 0)
    : null;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- 1. List forms (paginated) ------------------------------------------
  const allForms: FsFormPreview[] = [];
  for (let p = 1; p <= 20; p++) {
    const page = await fsGet<FsFormsPage>(`/forms?pageNumber=${p}&pageSize=50`, token);
    const forms = page.forms ?? [];
    allForms.push(...forms);
    if (p >= (page.page?.totalPages ?? 1)) break;
  }
  const targets = allForms.filter((f) =>
    requestedFormIds
      ? requestedFormIds.includes(f.id)
      : (f.active ?? true) && (f.submissionsCount ?? 0) > 0,
  );
  if (targets.length === 0) {
    return jsonOk({
      ok: true,
      dryRun,
      totalFetched: 0,
      totalUpserted: 0,
      forms: [],
      hint: requestedFormIds
        ? `None of the requested formIds matched the account's forms (${allForms.length} visible)`
        : "No active forms with submissions found",
      durationMs: Date.now() - startedAt,
    });
  }

  // ---- 2. Per-form incremental pull + upsert ------------------------------
  const formResults: Array<{
    formId: number;
    formName: string;
    fetched: number;
    upserted: number;
    capped?: boolean;
    error?: string;
  }> = [];
  const samples: SubmissionRow[] = [];
  const remainingFormIds: number[] = [];
  let totalFetched = 0;
  let totalUpserted = 0;

  for (const form of targets) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      remainingFormIds.push(form.id);
      continue;
    }
    const formName = (form.name ?? `Form ${form.id}`).toString();
    const result = { formId: form.id, formName, fetched: 0, upserted: 0 } as (typeof formResults)[number];
    formResults.push(result);
    try {
      // High-water mark: newest submitted_at we already hold for this form.
      let minTimeParam = "";
      if (!fullResync) {
        const { data: hw, error: hwErr } = await admin
          .from("formstack_submissions")
          .select("submitted_at")
          .eq("form_id", form.id)
          .not("submitted_at", "is", null)
          .order("submitted_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (hwErr) throw new Error(`high-water query failed: ${hwErr.message}`);
        if (hw?.submitted_at) {
          minTimeParam = `&minTime=${encodeURIComponent(utcIsoToAccountLocal(hw.submitted_at))}`;
        }
      }

      // Dedup by id across pages — protects the chunked upsert from
      // "ON CONFLICT DO UPDATE cannot affect row a second time" if a page
      // boundary shifts mid-pull (new submission arriving during the run).
      const rowsById = new Map<string, SubmissionRow>();
      for (let p = 1; p <= MAX_PAGES_PER_FORM; p++) {
        const page = await fsGet<FsSubmissionsPage>(
          `/forms/${form.id}/submissions?pageNumber=${p}&pageSize=${PAGE_SIZE}` +
            `&data=true&dataFormat=standardized&expandData=true&order=ASC${minTimeParam}`,
          token,
        );
        const subs = page.submissions ?? [];
        for (const s of subs) rowsById.set(`FS-${s.id}`, mapSubmission(s, formName));
        const totalPages = page.page?.totalPages ?? 1;
        if (p >= totalPages || subs.length === 0) break;
        if (p === MAX_PAGES_PER_FORM) result.capped = true;
      }

      const rows = Array.from(rowsById.values());
      result.fetched = rows.length;
      totalFetched += rows.length;
      for (const r of rows) {
        if (samples.length < 5) samples.push(r);
      }

      if (!dryRun && rows.length > 0) {
        for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
          const { error: upErr } = await admin
            .from("formstack_submissions")
            .upsert(batch, { onConflict: "id" });
          if (upErr) throw new Error(`upsert failed: ${upErr.message}`);
          result.upserted += batch.length;
          totalUpserted += batch.length;
        }
      }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      console.error(`[formstack-import] form ${form.id} (${formName}):`, result.error);
      // A 401 is account-wide (expired PAT) — no point hammering the
      // remaining forms with the same dead token.
      if (err instanceof FormstackError && err.status === 401) break;
    }
  }

  const errors = formResults.filter((f) => f.error);
  return jsonOk({
    ok: errors.length === 0,
    dryRun,
    fullResync,
    totalFetched,
    totalUpserted,
    forms: formResults,
    partial: remainingFormIds.length > 0,
    ...(remainingFormIds.length > 0 ? { remainingFormIds } : {}),
    ...(dryRun ? { samples } : {}),
    ...(errors.length > 0
      ? { error: `${errors.length}/${formResults.length} forms failed — see forms[].error` }
      : {}),
    durationMs: Date.now() - startedAt,
  });
}

serve(async (req) => {
  try {
    return await handle(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      "formstack-import: UNHANDLED exception",
      msg,
      err instanceof Error ? err.stack ?? "" : "",
    );
    return jsonOk({ ok: false, step: "unhandled", error: msg }, 500);
  }
});
