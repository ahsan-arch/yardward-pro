// Supabase Edge Function: qbo-push-time
// Pushes Engage Hydrovac CRM time entries to QuickBooks Online as TimeActivity rows.
//
// Flow:
//   1. Verify caller is admin or service_role
//   2. Acquire QBO access_token via shared getQboAccessToken (advisory-lock + cache)
//   3. SELECT time_entries in [periodStart, periodEnd) with clock_out IS NOT NULL
//   4. For each entry: look up qbo_employee_mappings; POST TimeActivity; record qbo_payroll_pushes row
//   5. Respect dryRun — skip the QBO POSTs entirely and only insert 'skipped' audit rows
//
// Returns: { pushed, failed, skipped, totalHours, durationMs }

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getQboAccessToken, qboApiHost } from '../_shared/qbo-oauth.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// QBO API constants — sandbox vs production host resolved by the shared
// qboApiHost() helper from QBO_ENVIRONMENT. Same env-var pattern as
// qbo-push-invoice so the deploy secrets stay in lockstep across the two
// functions.
const QBO_API_HOST = qboApiHost(Deno.env)
const QBO_MINOR_VERSION = '75'

// -------------------------- helpers --------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  })
}

function toYmd(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function isYmd(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function reportError(
  admin: ReturnType<typeof createClient>,
  opts: {
    code: string
    message: string
    severity?: 'info' | 'warn' | 'error' | 'critical'
    stack?: string | null
    context?: Record<string, unknown>
  },
): Promise<void> {
  try {
    await admin.rpc('report_error', {
      p_source: 'edge_function',
      p_severity: opts.severity ?? 'error',
      p_error_code: opts.code,
      p_message: opts.message,
      p_stack: opts.stack ?? null,
      p_function_name: 'qbo-push-time',
      p_context: opts.context ?? {},
    })
  } catch (e) {
    console.error(
      '[qbo-push-time] reportError failed (swallowed):',
      e instanceof Error ? e.message : String(e),
    )
  }
}

// AbortController-backed fetch. Throws an Error with `.isTimeout=true` on
// timeout so the upstream caller can map it to a 504 instead of a generic 502.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 20000,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err) {
    if ((err as any)?.name === 'AbortError') {
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

// -------------------------- QBO calls --------------------------
//
// OAuth refresh + token persistence now lives in ../_shared/qbo-oauth.ts —
// it wraps refresh in a pg_advisory_lock so qbo-push-invoice and qbo-push-time
// can't race the rotated refresh_token, and caches the access_token in
// qbo_oauth_tokens.access_token_expires_at to skip redundant Intuit
// round-trips when a sibling function already refreshed recently.

async function qboFetchWithBackoff(
  url: string,
  init: RequestInit,
  label: string,
  opts: { retryOn5xx?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  // POST TimeActivity is non-idempotent — we set retryOn5xx=false at the call
  // site so a 5xx with a successful upstream side-effect doesn't double-write
  // (we record it as failed and the admin retries explicitly).
  const { retryOn5xx = true, timeoutMs = 25000 } = opts
  const delays = [1000, 2000, 4000, 8000]
  let lastRes: Response | null = null
  for (let attempt = 0; attempt < delays.length; attempt++) {
    const res = await fetchWithTimeout(url, init, timeoutMs)
    lastRes = res
    if (res.status === 429) {
      if (attempt === delays.length - 1) return res
      console.warn(
        `[qbo-push-time] ${label} returned 429, retrying in ${delays[attempt]}ms (attempt ${attempt + 1})`,
      )
      await sleep(delays[attempt])
      continue
    }
    if (res.status >= 500 && retryOn5xx) {
      if (attempt === delays.length - 1) return res
      console.warn(
        `[qbo-push-time] ${label} returned ${res.status}, retrying in ${delays[attempt]}ms (attempt ${attempt + 1})`,
      )
      await sleep(delays[attempt])
      continue
    }
    return res
  }
  return lastRes as Response
}

// -------------------------- caller auth --------------------------

function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function verifyCallerIsAdminOrService(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization')
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, error: 'Missing or malformed Authorization header' }
  }
  const token = authHeader.slice(7).trim()
  if (!token) return { ok: false, status: 401, error: 'Empty bearer token' }

  if (constantTimeEqual(token, serviceRoleKey)) {
    return { ok: true }
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser(token)
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, error: 'Invalid or expired user token' }
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: profile, error: profileErr } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileErr) {
    return { ok: false, status: 401, error: `Profile lookup failed: ${profileErr.message}` }
  }
  if (!profile || profile.role !== 'admin') {
    return { ok: false, status: 401, error: 'Caller is not an admin' }
  }
  return { ok: true }
}

// -------------------------- main handler --------------------------

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startedAt = Date.now()

  // 1. Validate secrets up front
  const QBO_CLIENT_ID = Deno.env.get('QBO_CLIENT_ID')
  const QBO_CLIENT_SECRET = Deno.env.get('QBO_CLIENT_SECRET')
  // QBO_REFRESH_TOKEN is no longer read from env — the shared helper
  // (_shared/qbo-oauth.ts) reads the live refresh_token from
  // public.qbo_oauth_tokens and rotates it back into that row.
  const QBO_REALM_ID = Deno.env.get('QBO_REALM_ID')
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  // For a dryRun we still need SUPABASE_* + a way to verify the caller, but we
  // can skip the QBO secrets. We don't know dryRun yet, so we collect missing
  // secrets and decide once the body is parsed.
  const missingSupabase: string[] = []
  if (!SUPABASE_URL) missingSupabase.push('SUPABASE_URL')
  if (!SUPABASE_ANON_KEY) missingSupabase.push('SUPABASE_ANON_KEY')
  if (!SUPABASE_SERVICE_ROLE_KEY) missingSupabase.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missingSupabase.length > 0) {
    const msg = `Missing required env vars: ${missingSupabase.join(', ')}`
    console.error(`[qbo-push-time] ${msg}`)
    return jsonResponse({ error: msg }, 500)
  }

  // 1b. Caller auth gate — admin or service_role bearer required.
  const authCheck = await verifyCallerIsAdminOrService(
    req,
    SUPABASE_URL!,
    SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY!,
  )
  if (!authCheck.ok) {
    console.warn(`[qbo-push-time] auth rejected: ${authCheck.error}`)
    const oneOff = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    void reportError(oneOff, {
      code: 'AUTH_FAILED',
      severity: 'warn',
      message: `Caller auth rejected: ${authCheck.error}`,
      context: { stage: 'caller_auth', httpStatus: authCheck.status },
    })
    return jsonResponse({ error: authCheck.error }, authCheck.status)
  }

  // 2. Parse + validate body
  let periodStart: string | undefined
  let periodEnd: string | undefined
  let dryRun = false
  try {
    const body = await req.json()
    periodStart = body?.periodStart
    periodEnd = body?.periodEnd
    dryRun = body?.dryRun === true
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  if (!isYmd(periodStart)) {
    return jsonResponse({ error: 'periodStart must be YYYY-MM-DD' }, 400)
  }
  if (!isYmd(periodEnd)) {
    return jsonResponse({ error: 'periodEnd must be YYYY-MM-DD' }, 400)
  }
  if (periodStart >= periodEnd) {
    return jsonResponse({ error: 'periodStart must be < periodEnd' }, 400)
  }

  // For LIVE runs we need the QBO secrets too. For dryRun we don't talk to
  // QBO at all so we can short-circuit a missing-secret install.
  if (!dryRun) {
    const missingQbo: string[] = []
    if (!QBO_CLIENT_ID) missingQbo.push('QBO_CLIENT_ID')
    if (!QBO_CLIENT_SECRET) missingQbo.push('QBO_CLIENT_SECRET')
    if (!QBO_REALM_ID) missingQbo.push('QBO_REALM_ID')
    if (missingQbo.length > 0) {
      const msg = `Missing required env vars: ${missingQbo.join(', ')}`
      console.error(`[qbo-push-time] ${msg}`)
      const oneOff = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      void reportError(oneOff, {
        code: 'MISSING_SECRETS',
        severity: 'critical',
        message: msg,
        context: { missing: missingQbo, stage: 'secret_validation' },
      })
      return jsonResponse({ error: msg }, 500)
    }
  }

  console.log(
    `[qbo-push-time] starting push period=${periodStart}..${periodEnd} dryRun=${dryRun}`,
  )

  const admin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 3. Load time_entries in window. We use the same date-only filter the
  // admin UI uses (clock_in falls in [periodStart, periodEnd)).
  let timeEntries: Array<{
    id: string
    driver_id: string
    clock_in: string
    clock_out: string | null
  }> = []
  try {
    const { data, error } = await admin
      .from('time_entries')
      .select('id, driver_id, clock_in, clock_out')
      .gte('clock_in', periodStart)
      .lt('clock_in', periodEnd)
      .not('clock_out', 'is', null)
      .order('clock_in', { ascending: true })
    if (error) throw new Error(`time_entries load failed: ${error.message}`)
    timeEntries = (data ?? []) as typeof timeEntries
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    console.error(`[qbo-push-time] DB read failed: ${msg}`)
    void reportError(admin, {
      code: 'DB_WRITE_FAILED',
      message: `DB read failed: ${msg}`,
      stack,
      context: { stage: 'load_time_entries', periodStart, periodEnd },
    })
    return jsonResponse({ error: `DB read failed: ${msg}` }, 500)
  }

  console.log(`[qbo-push-time] loaded ${timeEntries.length} time entries`)

  if (timeEntries.length === 0) {
    return jsonResponse(
      { pushed: 0, failed: 0, skipped: 0, totalHours: 0, durationMs: Date.now() - startedAt },
      200,
    )
  }

  // 4. Load the QBO employee mapping table once instead of per-row to keep
  // the per-entry loop O(1) lookups.
  let mappingByDriver = new Map<string, string>()
  try {
    const { data, error } = await admin
      .from('qbo_employee_mappings')
      .select('driver_id, qbo_employee_id')
    if (error) throw new Error(`qbo_employee_mappings load failed: ${error.message}`)
    for (const row of data ?? []) {
      mappingByDriver.set(row.driver_id as string, row.qbo_employee_id as string)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[qbo-push-time] mapping load failed: ${msg}`)
    void reportError(admin, {
      code: 'DB_WRITE_FAILED',
      message: `Mapping load failed: ${msg}`,
      context: { stage: 'load_mappings', periodStart, periodEnd },
    })
    return jsonResponse({ error: `Mapping load failed: ${msg}` }, 500)
  }

  // 5. For a live run, acquire a QBO access_token via the shared helper. The
  //    helper:
  //      - takes a pg_advisory_lock so concurrent edge functions can't race
  //        the rotated refresh_token (Intuit invalidates the previous one)
  //      - reuses a cached access_token if it has >60s remaining
  //      - persists rotated refresh_token + access_token atomically under lock
  //    dryRun stays entirely offline — caller wants the no-side-effects preview.
  let accessToken: string | null = null
  let qboHeaders: Record<string, string> = {}
  let baseUrl = ''
  if (!dryRun) {
    try {
      console.log('[qbo-push-time] requesting QBO access token (shared helper)')
      const tok = await getQboAccessToken(admin, Deno.env)
      accessToken = tok.access_token
      qboHeaders = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }
      // Use the realm that actually owns the refresh_token (OAuth-stored),
      // falling back to the env var only if unset — so a drifted QBO_REALM_ID
      // can't push payroll time into the wrong QuickBooks company.
      baseUrl = `${QBO_API_HOST}/v3/company/${tok.realm_id || QBO_REALM_ID}`
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack ?? null : null
      const isAuth = (err as any)?.isAuthError === true
      const isTimeout = (err as any)?.isTimeout === true
      console.error(`[qbo-push-time] token refresh failed: ${msg}`)
      if (isTimeout) {
        void reportError(admin, {
          code: 'UPSTREAM_TIMEOUT',
          message: `QBO token refresh timed out: ${msg}`,
          stack,
          context: { stage: 'token_refresh' },
        })
        return jsonResponse({ error: 'QBO call timed out' }, 504)
      }
      if (msg.startsWith('qbo_oauth_tokens read failed')) {
        void reportError(admin, {
          code: 'DB_WRITE_FAILED',
          message: msg,
          stack,
          context: { stage: 'load_refresh_token', op: 'select', table: 'qbo_oauth_tokens' },
        })
        return jsonResponse(
          { error: `Could not read stored refresh token: ${msg}` },
          500,
        )
      }
      void reportError(admin, {
        code: isAuth ? 'AUTH_FAILED' : 'UPSTREAM_502',
        severity: isAuth ? 'warn' : 'error',
        message: `QBO token refresh failed: ${msg}`,
        stack,
        context: { stage: 'token_refresh', isAuth },
      })
      return jsonResponse(
        {
          error: isAuth
            ? 'QBO refresh token is invalid/expired. Re-run the OAuth consent flow.'
            : `QBO token refresh failed: ${msg}`,
        },
        isAuth ? 401 : 502,
      )
    }
  }

  // 6. Per-entry push loop. We flush the audit buffer every 10 entries (and a
  // final time at the end) so a transient DB hiccup mid-period still leaves a
  // useful audit trail for the rows that DID flush. Each row carries its own
  // status/error_message; if a flush fails we log to integration_alerts with
  // the buffered rows as JSON context for human reconciliation.
  type PushRow = {
    period_start: string
    period_end: string
    driver_id: string | null
    time_entry_id: string | null
    hours: number
    qbo_time_activity_id: string | null
    status: 'pushed' | 'failed' | 'skipped'
    error_message: string | null
    pushed_at: string | null
  }
  let auditBuffer: PushRow[] = []
  let pushed = 0
  let failed = 0
  let skipped = 0
  let totalHours = 0
  const FLUSH_THRESHOLD = 10
  const FLUSH_CHUNK = 200

  // flushAuditBuffer inserts the current buffer in 200-row chunks and clears it.
  // On failure we log to integration_alerts with the full buffered rows as
  // context — the QBO side-effects already happened, so a human needs to
  // reconcile the missing audit rows.
  async function flushAuditBuffer(): Promise<{ ok: boolean; error?: string }> {
    if (auditBuffer.length === 0) return { ok: true }
    const toFlush = auditBuffer
    auditBuffer = []
    for (let i = 0; i < toFlush.length; i += FLUSH_CHUNK) {
      const chunk = toFlush.slice(i, i + FLUSH_CHUNK)
      try {
        const { error } = await admin.from('qbo_payroll_pushes').insert(chunk)
        if (error) throw error
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[qbo-push-time] audit flush failed: ${msg}`)
        try {
          await admin.from('integration_alerts').insert({
            source: 'qbo-push-time',
            kind: 'audit_flush_failed',
            severity: 'critical',
            message: `Audit flush failed: ${msg}`,
            context: {
              stage: 'audit_flush',
              chunkIndex: i,
              chunkSize: chunk.length,
              periodStart,
              periodEnd,
              rows: chunk,
            },
          })
        } catch (alertErr) {
          console.error(
            '[qbo-push-time] integration_alerts insert threw during flush failure:',
            alertErr instanceof Error ? alertErr.message : String(alertErr),
          )
        }
        void reportError(admin, {
          code: 'DB_WRITE_FAILED',
          severity: 'critical',
          message: `Audit flush failed: ${msg}`,
          context: {
            stage: 'audit_flush',
            chunkIndex: i,
            chunkSize: chunk.length,
            periodStart,
            periodEnd,
          },
        })
        return { ok: false, error: msg }
      }
    }
    return { ok: true }
  }

  for (const te of timeEntries) {
    const clockIn = new Date(te.clock_in)
    const clockOut = te.clock_out ? new Date(te.clock_out) : null
    if (!clockOut || isNaN(clockIn.getTime()) || isNaN(clockOut.getTime())) {
      // Defensive — the SELECT filter already excludes clock_out IS NULL.
      continue
    }
    const hoursDecimal = (clockOut.getTime() - clockIn.getTime()) / 3600000
    if (!Number.isFinite(hoursDecimal) || hoursDecimal <= 0) {
      auditBuffer.push({
        period_start: periodStart,
        period_end: periodEnd,
        driver_id: te.driver_id,
        time_entry_id: te.id,
        hours: 0,
        qbo_time_activity_id: null,
        status: 'skipped',
        error_message: 'invalid duration (clock_out <= clock_in)',
        pushed_at: null,
      })
      skipped++
      if (auditBuffer.length >= FLUSH_THRESHOLD) await flushAuditBuffer()
      continue
    }
    totalHours += hoursDecimal
    // Route through total-minutes to guarantee minutes ∈ [0, 59]. The naive
    // floor(h) + round(frac*60) path can produce minutes=60 for inputs like
    // 7.999h (floor=7, frac=0.999, *60=59.94, round=60) which QBO rejects.
    const totalMinutes = Math.round(hoursDecimal * 60)
    const hoursWhole = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    const txnDate = toYmd(clockIn)

    // Round to 2dp for the audit row so the dashboard math lines up with what
    // an admin would compute by hand from clock_in/clock_out timestamps.
    const auditHours = Math.round(hoursDecimal * 100) / 100

    const qboEmployeeId = mappingByDriver.get(te.driver_id)
    if (!qboEmployeeId) {
      auditBuffer.push({
        period_start: periodStart,
        period_end: periodEnd,
        driver_id: te.driver_id,
        time_entry_id: te.id,
        hours: auditHours,
        qbo_time_activity_id: null,
        status: 'skipped',
        error_message: `no QBO employee mapping for driver ${te.driver_id}`,
        pushed_at: null,
      })
      skipped++
      if (auditBuffer.length >= FLUSH_THRESHOLD) await flushAuditBuffer()
      continue
    }

    if (dryRun) {
      // Preview-only: same audit row a real run would write, but tagged so
      // operators can grep `error_message ilike '%dryRun%'`.
      auditBuffer.push({
        period_start: periodStart,
        period_end: periodEnd,
        driver_id: te.driver_id,
        time_entry_id: te.id,
        hours: auditHours,
        qbo_time_activity_id: null,
        status: 'skipped',
        error_message: `dryRun · would push ${hoursWhole}h ${minutes}m to QBO employee ${qboEmployeeId}`,
        pushed_at: null,
      })
      skipped++
      if (auditBuffer.length >= FLUSH_THRESHOLD) await flushAuditBuffer()
      continue
    }

    // Pre-check: another admin / concurrent invocation may have already pushed
    // this time_entry. The unique partial index on (time_entry_id) WHERE
    // status='pushed' is the source of truth, but a cheap SELECT here lets us
    // skip the QBO POST entirely in the common case.
    try {
      const { data: existing, error: precheckErr } = await admin
        .from('qbo_payroll_pushes')
        .select('id')
        .eq('time_entry_id', te.id)
        .eq('status', 'pushed')
        .limit(1)
        .maybeSingle()
      if (precheckErr) {
        // Treat as transient — fall through to the POST, the unique index
        // will still protect us from a true double-push.
        console.warn(
          `[qbo-push-time] pre-check read failed for entry ${te.id}: ${precheckErr.message}`,
        )
      } else if (existing) {
        auditBuffer.push({
          period_start: periodStart,
          period_end: periodEnd,
          driver_id: te.driver_id,
          time_entry_id: te.id,
          hours: auditHours,
          qbo_time_activity_id: null,
          status: 'skipped',
          error_message: 'already pushed by prior run',
          pushed_at: null,
        })
        skipped++
        if (auditBuffer.length >= FLUSH_THRESHOLD) await flushAuditBuffer()
        continue
      }
    } catch (err) {
      console.warn(
        `[qbo-push-time] pre-check threw for entry ${te.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Live push. POST is non-idempotent so we disable 5xx retry to avoid
    // double-billing on a QBO partial failure.
    const payload = {
      TimeActivity: {
        NameOf: 'Employee',
        EmployeeRef: { value: qboEmployeeId },
        TxnDate: txnDate,
        Hours: hoursWhole,
        Minutes: minutes,
      },
    }
    try {
      const res = await qboFetchWithBackoff(
        `${baseUrl}/timeactivity?minorversion=${QBO_MINOR_VERSION}`,
        {
          method: 'POST',
          headers: qboHeaders,
          body: JSON.stringify(payload),
        },
        `timeactivity ${te.id}`,
        { retryOn5xx: false, timeoutMs: 25000 },
      )
      const text = await res.text()
      let body: any
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`QBO TimeActivity returned non-JSON (HTTP ${res.status}): ${text}`)
      }
      if (!res.ok || body.Fault || !body.TimeActivity?.Id) {
        throw new Error(`QBO TimeActivity failed (HTTP ${res.status}): ${JSON.stringify(body)}`)
      }
      const qboTimeActivityId = body.TimeActivity.Id as string
      // Insert the 'pushed' audit row immediately so the unique partial index
      // on (time_entry_id) WHERE status='pushed' arbitrates against any
      // concurrent admin that won the race between our pre-check and this
      // INSERT. If we get 23505, demote this row to 'skipped' and flag for
      // human reconciliation — QBO may now hold a duplicate TimeActivity.
      try {
        const { error: insertErr } = await admin.from('qbo_payroll_pushes').insert({
          period_start: periodStart,
          period_end: periodEnd,
          driver_id: te.driver_id,
          time_entry_id: te.id,
          hours: auditHours,
          qbo_time_activity_id: qboTimeActivityId,
          status: 'pushed',
          error_message: null,
          pushed_at: new Date().toISOString(),
        })
        if (insertErr) throw insertErr
        pushed++
      } catch (insertErr: any) {
        const code = insertErr?.code as string | undefined
        const msg = insertErr instanceof Error ? insertErr.message : String(insertErr)
        if (code === '23505') {
          console.error(
            `[qbo-push-time] RACE LOST for entry ${te.id} — concurrent admin already inserted pushed row. ` +
            `Our QBO TimeActivity Id=${qboTimeActivityId} may be a duplicate; manual reconciliation required.`,
          )
          auditBuffer.push({
            period_start: periodStart,
            period_end: periodEnd,
            driver_id: te.driver_id,
            time_entry_id: te.id,
            hours: auditHours,
            qbo_time_activity_id: qboTimeActivityId,
            status: 'skipped',
            error_message:
              'race lost to concurrent admin — TimeActivity may have been double-posted, verify QBO',
            pushed_at: null,
          })
          try {
            await admin.from('integration_alerts').insert({
              source: 'qbo-push-time',
              kind: 'qbo_double_push_suspected',
              severity: 'critical',
              message: `Race lost on time_entry ${te.id}; QBO TimeActivity ${qboTimeActivityId} may be a duplicate`,
              context: {
                stage: 'audit_insert_pushed',
                timeEntryId: te.id,
                qboTimeActivityId,
                periodStart,
                periodEnd,
              },
            })
          } catch (alertErr) {
            console.error(
              '[qbo-push-time] integration_alerts insert threw on race-loss:',
              alertErr instanceof Error ? alertErr.message : String(alertErr),
            )
          }
          skipped++
        } else {
          // Non-unique-violation: we DID succeed at QBO but failed to record
          // it. Buffer a 'pushed' row with the QBO id so the final flush
          // catches it, and surface via reportError for visibility.
          console.error(
            `[qbo-push-time] audit insert failed for entry ${te.id} (QBO push succeeded, id=${qboTimeActivityId}): ${msg}`,
          )
          auditBuffer.push({
            period_start: periodStart,
            period_end: periodEnd,
            driver_id: te.driver_id,
            time_entry_id: te.id,
            hours: auditHours,
            qbo_time_activity_id: qboTimeActivityId,
            status: 'pushed',
            error_message: null,
            pushed_at: new Date().toISOString(),
          })
          pushed++
          void reportError(admin, {
            code: 'DB_WRITE_FAILED',
            severity: 'error',
            message: `Inline pushed-row insert failed (will retry via buffer): ${msg}`,
            context: {
              stage: 'audit_insert_pushed',
              timeEntryId: te.id,
              qboTimeActivityId,
              errorCode: code ?? null,
            },
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[qbo-push-time] entry ${te.id} push failed: ${msg}`)
      auditBuffer.push({
        period_start: periodStart,
        period_end: periodEnd,
        driver_id: te.driver_id,
        time_entry_id: te.id,
        hours: auditHours,
        qbo_time_activity_id: null,
        status: 'failed',
        error_message: msg.length > 1000 ? msg.slice(0, 1000) : msg,
        pushed_at: null,
      })
      failed++
    }
    if (auditBuffer.length >= FLUSH_THRESHOLD) await flushAuditBuffer()
  }

  // 7. Final audit flush. In-loop flushes already handled the bulk of the
  // buffer (every FLUSH_THRESHOLD entries); this drains anything left over.
  // Note: 'pushed' rows are inserted inline above so the unique index can
  // arbitrate the race — only 'skipped' and 'failed' rows land here.
  const finalFlush = await flushAuditBuffer()
  if (!finalFlush.ok) {
    return jsonResponse(
      {
        error: `QBO pushes succeeded but final audit log write failed: ${finalFlush.error}`,
        pushed,
        failed,
        skipped,
        totalHours: Math.round(totalHours * 100) / 100,
        durationMs: Date.now() - startedAt,
      },
      500,
    )
  }

  const durationMs = Date.now() - startedAt
  console.log(
    `[qbo-push-time] done. pushed=${pushed} failed=${failed} skipped=${skipped} totalHours=${totalHours.toFixed(2)} duration=${durationMs}ms`,
  )

  return jsonResponse(
    {
      pushed,
      failed,
      skipped,
      totalHours: Math.round(totalHours * 100) / 100,
      durationMs,
    },
    200,
  )
})
