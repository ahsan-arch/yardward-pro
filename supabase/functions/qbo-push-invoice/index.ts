// Supabase Edge Function: qbo-push-invoice
// Pushes a Engage Hydrovac CRM invoice to QuickBooks Online and stores the QBO invoice id.
//
// Flow:
//   1. Load invoice_data + invoice_line_items + clients from Supabase
//   2. Exchange QBO refresh token for a fresh access token (and persist any rotated refresh_token)
//   3. Look up (or create) the QBO Customer by DisplayName
//   4. POST the Invoice to QBO
//   5. Update our invoice_data row with qbo_invoice_id + qbo_sync_status='synced'
//
// Returns: { qboInvoiceId, qboSyncStatus }

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getQboAccessToken, qboApiHost } from '../_shared/qbo-oauth.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// QBO API constants. Sandbox vs production host is resolved by the shared
// qboApiHost() helper from QBO_ENVIRONMENT. Defaults to sandbox so dev/test
// doesn't accidentally hit a real QBO realm.
const QBO_API_HOST = qboApiHost(Deno.env)
const QBO_MINOR_VERSION = '75'

// -------------------------- helpers --------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  })
}

function escapeQboQueryString(value: string): string {
  // QBO query language: single quotes escaped by doubling.
  return value.replace(/'/g, "''")
}

function toYmd(input: string | null | undefined): string | undefined {
  if (!input) return undefined
  // Accept either YYYY-MM-DD or ISO timestamp; QBO requires YYYY-MM-DD (no time).
  const d = new Date(input)
  if (isNaN(d.getTime())) return undefined
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Fire-and-forget error reporter — pushes to public.report_error RPC.
 * Wrapped in try/catch so a reporting failure can never bubble up and mask
 * the original error path. Call as `reportError(admin, {...})` without await
 * at the bubble-out point (just before the failure response).
 */
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
      p_function_name: 'qbo-push-invoice',
      p_context: opts.context ?? {},
    })
  } catch (e) {
    console.error(
      '[qbo-push-invoice] reportError failed (swallowed):',
      e instanceof Error ? e.message : String(e),
    )
  }
}

// fetchWithTimeout: wraps fetch with an AbortController that fires after `ms`.
// On timeout, throws an Error with `.isTimeout = true` so callers can map it
// to a 504 instead of a generic 502.
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
// it wraps the refresh in a pg_advisory_lock so qbo-push-invoice and
// qbo-push-time can't race the rotated refresh_token, and caches the access
// token in qbo_oauth_tokens.access_token_expires_at to skip redundant Intuit
// round-trips when a sibling function already refreshed recently.

async function qboFetchWithBackoff(
  url: string,
  init: RequestInit,
  label: string,
  opts: { retryOn5xx?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  // Simple exponential backoff for 429 / 5xx. 4 attempts: 1s, 2s, 4s, 8s.
  // retryOn5xx defaults to true; pass false for non-idempotent POSTs (invoice
  // create) where a 5xx could mean QBO actually processed the request and a
  // blind retry would duplicate.
  const { retryOn5xx = true, timeoutMs = 25000 } = opts
  const delays = [1000, 2000, 4000, 8000]
  let lastRes: Response | null = null
  for (let attempt = 0; attempt < delays.length; attempt++) {
    const res = await fetchWithTimeout(url, init, timeoutMs)
    lastRes = res
    if (res.status === 429) {
      // Rate limited — QBO didn't process the request, retry is safe.
      if (attempt === delays.length - 1) return res
      console.warn(
        `[qbo-push-invoice] ${label} returned 429, retrying in ${delays[attempt]}ms (attempt ${attempt + 1})`,
      )
      await sleep(delays[attempt])
      continue
    }
    if (res.status >= 500 && retryOn5xx) {
      if (attempt === delays.length - 1) return res
      console.warn(
        `[qbo-push-invoice] ${label} returned ${res.status}, retrying in ${delays[attempt]}ms (attempt ${attempt + 1})`,
      )
      await sleep(delays[attempt])
      continue
    }
    return res
  }
  // Should not reach here
  return lastRes as Response
}

async function findCustomerIdByDisplayName(
  baseUrl: string,
  headers: Record<string, string>,
  displayName: string,
): Promise<string | null> {
  const q = encodeURIComponent(
    `select * from Customer where DisplayName = '${escapeQboQueryString(displayName)}'`,
  )
  const url = `${baseUrl}/query?query=${q}&minorversion=${QBO_MINOR_VERSION}`
  const res = await qboFetchWithBackoff(url, { headers }, 'customer query')
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`QBO customer query returned non-JSON (HTTP ${res.status}): ${text}`)
  }
  if (!res.ok || body.Fault) {
    throw new Error(`QBO customer query failed (HTTP ${res.status}): ${JSON.stringify(body)}`)
  }
  const found = body.QueryResponse?.Customer?.[0]
  return found?.Id ?? null
}

interface BillAddrInput {
  Line1?: string
  City?: string
  CountrySubDivisionCode?: string
  PostalCode?: string
}

async function createCustomer(
  baseUrl: string,
  headers: Record<string, string>,
  displayName: string,
  email: string | null,
  billAddr: BillAddrInput | null,
): Promise<string> {
  const payload: Record<string, unknown> = { DisplayName: displayName }
  if (email) payload.PrimaryEmailAddr = { Address: email }
  if (billAddr && Object.keys(billAddr).length > 0) payload.BillAddr = billAddr

  const res = await qboFetchWithBackoff(
    `${baseUrl}/customer?minorversion=${QBO_MINOR_VERSION}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
    'customer create',
  )
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`QBO customer create returned non-JSON (HTTP ${res.status}): ${text}`)
  }
  if (!res.ok || body.Fault || !body.Customer?.Id) {
    throw new Error(`QBO customer create failed (HTTP ${res.status}): ${JSON.stringify(body)}`)
  }
  return body.Customer.Id as string
}

async function findDefaultServiceItemId(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<string> {
  // Allow override via secret to avoid coupling to whatever happens to exist.
  const override = Deno.env.get('QBO_DEFAULT_ITEM_ID')
  if (override) return override

  const q = encodeURIComponent("select * from Item where Type = 'Service'")
  const url = `${baseUrl}/query?query=${q}&minorversion=${QBO_MINOR_VERSION}`
  const res = await qboFetchWithBackoff(url, { headers }, 'item query')
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`QBO item query returned non-JSON (HTTP ${res.status}): ${text}`)
  }
  if (!res.ok || body.Fault) {
    throw new Error(`QBO item query failed (HTTP ${res.status}): ${JSON.stringify(body)}`)
  }
  const item = body.QueryResponse?.Item?.[0]
  if (!item?.Id) {
    throw new Error(
      "No QBO Service Item found. Create one in QuickBooks or set QBO_DEFAULT_ITEM_ID secret.",
    )
  }
  return item.Id as string
}

async function findExistingInvoiceIdByDocNumber(
  baseUrl: string,
  headers: Record<string, string>,
  docNumber: string,
): Promise<string | null> {
  // Idempotency guard: if a previous run created the invoice but our DB write failed,
  // the retry would otherwise duplicate. Match on our deterministic DocNumber.
  const q = encodeURIComponent(
    `select * from Invoice where DocNumber = '${escapeQboQueryString(docNumber)}'`,
  )
  const url = `${baseUrl}/query?query=${q}&minorversion=${QBO_MINOR_VERSION}`
  const res = await qboFetchWithBackoff(url, { headers }, 'invoice idempotency query')
  if (!res.ok) {
    // Don't block the push for an idempotency-check failure — just log.
    console.warn(`[qbo-push-invoice] idempotency query non-OK (HTTP ${res.status})`)
    return null
  }
  const body = await res.json().catch(() => null)
  if (!body || body.Fault) return null
  const found = body.QueryResponse?.Invoice?.[0]
  return found?.Id ?? null
}

// -------------------------- caller auth --------------------------
// Verify the request is from either (a) a Supabase service_role token (server-to-server)
// or (b) a logged-in user whose profiles.role = 'admin'. Anything else is 401.
// Inlined per-function because Supabase edge functions don't share modules.

/**
 * Constant-time string comparison so an attacker can't time-side-channel
 * partial matches on the service-role key.
 */
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

  // Server-to-server: constant-time compare the bearer to SUPABASE_SERVICE_ROLE_KEY.
  // Trusting an unverified role claim from the JWT payload would let anyone with
  // the public anon key forge a token with {role:'service_role'} and bypass auth.
  if (constantTimeEqual(token, serviceRoleKey)) {
    return { ok: true }
  }

  // User token: verify with Supabase auth using the anon key + the user JWT, then look up profile.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser(token)
  if (userErr || !userData?.user) {
    return { ok: false, status: 401, error: 'Invalid or expired user token' }
  }

  // Look up the profile with the service-role client (bypasses RLS) so we don't
  // depend on the user being able to SELECT their own profile row.
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

  const missing: string[] = []
  if (!QBO_CLIENT_ID) missing.push('QBO_CLIENT_ID')
  if (!QBO_CLIENT_SECRET) missing.push('QBO_CLIENT_SECRET')
  if (!QBO_REALM_ID) missing.push('QBO_REALM_ID')
  if (!SUPABASE_URL) missing.push('SUPABASE_URL')
  if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY')
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
  if (missing.length > 0) {
    const msg = `Missing required env vars: ${missing.join(', ')}`
    console.error(`[qbo-push-invoice] ${msg}`)
    // Build a one-off admin if URL+service-role survived. If either of those
    // two is itself missing we can't report — log only.
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const oneOff = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      void reportError(oneOff, {
        code: 'MISSING_SECRETS',
        severity: 'critical',
        message: msg,
        context: { missing, stage: 'secret_validation' },
      })
    }
    return jsonResponse({ error: msg }, 500)
  }

  // 1b. Verify caller is either service_role or an admin user. Do this BEFORE
  // any DB or QBO work so we don't leak side effects to unauthenticated callers.
  const authCheck = await verifyCallerIsAdminOrService(
    req,
    SUPABASE_URL!,
    SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY!,
  )
  if (!authCheck.ok) {
    console.warn(`[qbo-push-invoice] auth rejected: ${authCheck.error}`)
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
  let invoiceDataId: string | undefined
  try {
    const body = await req.json()
    invoiceDataId = body?.invoiceDataId
  } catch {
    const oneOff = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    void reportError(oneOff, {
      code: 'VALIDATION',
      severity: 'warn',
      message: 'Invalid JSON body',
      context: { stage: 'body_parse' },
    })
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }
  if (!invoiceDataId || typeof invoiceDataId !== 'string') {
    const oneOff = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    void reportError(oneOff, {
      code: 'VALIDATION',
      severity: 'warn',
      message: 'invoiceDataId (string) is required',
      context: { stage: 'body_validation', received: typeof invoiceDataId },
    })
    return jsonResponse({ error: 'invoiceDataId (string) is required' }, 400)
  }

  console.log(`[qbo-push-invoice] starting push for invoice_data ${invoiceDataId}`)

  const admin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // 3. Load the invoice + lines + client from DB
  let invoice: any
  let lineItems: any[] = []
  let client: any = null
  try {
    const { data: invData, error: invErr } = await admin
      .from('invoice_data')
      .select('*')
      .eq('id', invoiceDataId)
      .single()
    if (invErr || !invData) {
      throw new Error(`invoice_data ${invoiceDataId} not found: ${invErr?.message ?? 'no row'}`)
    }
    invoice = invData

    const { data: lines, error: linesErr } = await admin
      .from('invoice_line_items')
      .select('*')
      .eq('invoice_data_id', invoiceDataId)
    if (linesErr) throw new Error(`invoice_line_items load failed: ${linesErr.message}`)
    lineItems = lines ?? []

    if (invoice.client_id) {
      const { data: c, error: cErr } = await admin
        .from('clients')
        .select('*')
        .eq('id', invoice.client_id)
        .maybeSingle()
      if (cErr) throw new Error(`clients load failed: ${cErr.message}`)
      client = c
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    console.error(`[qbo-push-invoice] DB read failed: ${msg}`)
    void reportError(admin, {
      code: 'DB_WRITE_FAILED',
      message: `DB read failed: ${msg}`,
      stack,
      context: { stage: 'load_invoice', invoiceDataId },
    })
    return jsonResponse({ error: `DB read failed: ${msg}` }, 500)
  }

  if (lineItems.length === 0) {
    void reportError(admin, {
      code: 'VALIDATION',
      severity: 'warn',
      message: 'Invoice has no line items',
      context: { stage: 'line_validation', invoiceDataId },
    })
    return jsonResponse(
      { error: 'Invoice has no line items; QBO requires at least one Line.' },
      400,
    )
  }

  // Mark in_progress to help detect retries / partial failures.
  try {
    await admin
      .from('invoice_data')
      .update({ qbo_sync_status: 'in_progress' })
      .eq('id', invoiceDataId)
  } catch (err) {
    console.warn(
      `[qbo-push-invoice] could not mark in_progress (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // 4. Acquire a QBO access_token via the shared helper. The helper:
  //    - takes a pg_advisory_lock so concurrent edge functions can't race
  //      the rotated refresh_token (Intuit invalidates the previous one)
  //    - reuses a cached access_token if it has >60s remaining
  //    - persists rotated refresh_token + access_token atomically under the lock
  let accessToken: string
  // The realm that owns the refresh_token MUST be the realm the API URL
  // targets. Use the OAuth-stored realm_id (returned by the helper) as the
  // source of truth, falling back to the env var only if it's somehow unset —
  // otherwise a QBO_REALM_ID env that drifts from the authorized company
  // pushes invoices into the wrong (or a non-existent) QuickBooks file.
  let realmId: string
  try {
    console.log('[qbo-push-invoice] requesting QBO access token (shared helper)')
    const tok = await getQboAccessToken(admin, Deno.env)
    accessToken = tok.access_token
    realmId = tok.realm_id || QBO_REALM_ID
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    const isAuth = (err as any)?.isAuthError === true
    const isTimeout = (err as any)?.isTimeout === true
    console.error(`[qbo-push-invoice] token refresh failed: ${msg}`)
    // Flag the row so the UI / operator knows interactive re-consent is needed.
    await admin
      .from('invoice_data')
      .update({ qbo_sync_status: isAuth ? 'auth_required' : 'failed' })
      .eq('id', invoiceDataId)
      .then(() => {}, () => {})
    if (isTimeout) {
      void reportError(admin, {
        code: 'UPSTREAM_TIMEOUT',
        message: `QBO token refresh timed out: ${msg}`,
        stack,
        context: { stage: 'token_refresh', invoiceDataId },
      })
      return jsonResponse({ error: 'QBO call timed out' }, 504)
    }
    // A qbo_oauth_tokens DB-read failure (surfaced by the shared helper) isn't
    // an auth failure — return 500 with a clear message so it isn't mistaken
    // for an expired refresh_token.
    if (msg.startsWith('qbo_oauth_tokens read failed')) {
      void reportError(admin, {
        code: 'DB_WRITE_FAILED',
        message: msg,
        stack,
        context: { stage: 'load_refresh_token', invoiceDataId, op: 'select', table: 'qbo_oauth_tokens' },
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
      context: { stage: 'token_refresh', invoiceDataId, isAuth },
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

  const baseUrl = `${QBO_API_HOST}/v3/company/${realmId}`
  const qboHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

  // 5. Resolve / create the QBO customer
  // Pick the best display name from invoice or client.
  const displayName: string =
    invoice.customer_name ||
    client?.display_name ||
    client?.name ||
    [client?.first_name, client?.last_name].filter(Boolean).join(' ') ||
    `Customer ${invoiceDataId.slice(0, 8)}`

  let customerId: string
  try {
    console.log(`[qbo-push-invoice] looking up QBO customer "${displayName}"`)
    const existing = await findCustomerIdByDisplayName(baseUrl, qboHeaders, displayName)
    if (existing) {
      console.log(`[qbo-push-invoice] found existing QBO customer Id=${existing}`)
      customerId = existing
    } else {
      console.log(`[qbo-push-invoice] customer not found, creating`)
      const billAddr: BillAddrInput = {}
      if (client?.billing_address_line1 || client?.address_line1)
        billAddr.Line1 = client.billing_address_line1 ?? client.address_line1
      if (client?.billing_city || client?.city)
        billAddr.City = client.billing_city ?? client.city
      if (client?.billing_state || client?.state)
        billAddr.CountrySubDivisionCode = client.billing_state ?? client.state
      if (client?.billing_postal_code || client?.postal_code || client?.zip)
        billAddr.PostalCode =
          client.billing_postal_code ?? client.postal_code ?? client.zip
      const email = client?.email ?? invoice.customer_email ?? null
      customerId = await createCustomer(
        baseUrl,
        qboHeaders,
        displayName,
        email,
        Object.keys(billAddr).length ? billAddr : null,
      )
      console.log(`[qbo-push-invoice] created QBO customer Id=${customerId}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    const isTimeout = (err as any)?.isTimeout === true
    console.error(`[qbo-push-invoice] customer resolution failed: ${msg}`)
    await admin
      .from('invoice_data')
      .update({ qbo_sync_status: 'failed' })
      .eq('id', invoiceDataId)
      .then(() => {}, () => {})
    void reportError(admin, {
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_502',
      message: `QBO customer resolution failed: ${msg}`,
      stack,
      context: { stage: 'customer_resolution', invoiceDataId, displayName },
    })
    return jsonResponse({ error: `QBO customer resolution failed: ${msg}` }, 502)
  }

  // 6. Resolve a default Service Item Id for lines
  let defaultItemId: string
  try {
    defaultItemId = await findDefaultServiceItemId(baseUrl, qboHeaders)
    console.log(`[qbo-push-invoice] using QBO default Service Item Id=${defaultItemId}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    const isTimeout = (err as any)?.isTimeout === true
    console.error(`[qbo-push-invoice] item resolution failed: ${msg}`)
    await admin
      .from('invoice_data')
      .update({ qbo_sync_status: 'failed' })
      .eq('id', invoiceDataId)
      .then(() => {}, () => {})
    void reportError(admin, {
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_502',
      message: `QBO item resolution failed: ${msg}`,
      stack,
      context: { stage: 'item_resolution', invoiceDataId },
    })
    return jsonResponse({ error: `QBO item resolution failed: ${msg}` }, 502)
  }

  // 7. Build the QBO Invoice payload
  // Deterministic DocNumber lets us look up an existing invoice on retry.
  const docNumber = `YW-${invoiceDataId.slice(0, 16)}`

  // Idempotency check: if we already pushed this DocNumber, just record + return.
  try {
    const alreadyPushedId = await findExistingInvoiceIdByDocNumber(
      baseUrl,
      qboHeaders,
      docNumber,
    )
    if (alreadyPushedId) {
      console.log(
        `[qbo-push-invoice] DocNumber ${docNumber} already exists in QBO as Id=${alreadyPushedId}; skipping create`,
      )
      const { error: updErr } = await admin
        .from('invoice_data')
        .update({ qbo_sync_status: 'synced', qbo_invoice_id: alreadyPushedId })
        .eq('id', invoiceDataId)
      if (updErr) {
        void reportError(admin, {
          code: 'DB_WRITE_FAILED',
          severity: 'critical',
          message: `QBO push succeeded (idempotent) but DB write failed: ${updErr.message}`,
          context: {
            stage: 'idempotent_db_write',
            invoiceDataId,
            qboInvoiceId: alreadyPushedId,
            dbCode: updErr.code,
            table: 'invoice_data',
          },
        })
        return jsonResponse(
          { error: `QBO push succeeded but DB write failed: ${updErr.message}` },
          500,
        )
      }
      return jsonResponse({ qboInvoiceId: alreadyPushedId, qboSyncStatus: 'synced' }, 200)
    }
  } catch (err) {
    // Not fatal — log and continue.
    console.warn(
      `[qbo-push-invoice] idempotency check error (continuing): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // Validation pass: catch malformed numbers and amount/qty*rate mismatches
  // BEFORE we build the payload so QBO doesn't reject the whole invoice for
  // an arithmetic disagreement that's safer to flag back to the caller.
  const lineValidationErrors: string[] = []
  lineItems.forEach((li, idx) => {
    const qtyRaw = Number(li.qty ?? li.quantity ?? 1)
    const unitPriceRaw = Number(li.rate ?? li.unit_price ?? 0)
    if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) {
      lineValidationErrors.push(`Line ${idx + 1}: qty ${li.qty ?? li.quantity} is not a positive finite number`)
    }
    if (!Number.isFinite(unitPriceRaw) || unitPriceRaw < 0) {
      lineValidationErrors.push(`Line ${idx + 1}: unit price ${li.rate ?? li.unit_price} is not a non-negative finite number`)
    }
    if (li.amount != null) {
      const provided = Number(li.amount)
      if (!Number.isFinite(provided)) {
        lineValidationErrors.push(`Line ${idx + 1}: amount ${li.amount} is not a finite number`)
      } else if (Number.isFinite(qtyRaw) && Number.isFinite(unitPriceRaw)) {
        const expected = Math.round(qtyRaw * unitPriceRaw * 100) / 100
        if (Math.abs(provided - expected) > 0.01) {
          lineValidationErrors.push(
            `Line ${idx + 1}: amount ${provided} does not match qty*rate ${expected} (tolerance $0.01)`,
          )
        }
      }
    }
  })
  if (lineValidationErrors.length > 0) {
    console.warn(
      `[qbo-push-invoice] line validation failed: ${lineValidationErrors.join('; ')}`,
    )
    await admin
      .from('invoice_data')
      .update({ qbo_sync_status: 'failed' })
      .eq('id', invoiceDataId)
      .then(() => {}, () => {})
    void reportError(admin, {
      code: 'VALIDATION',
      severity: 'warn',
      message: `Invoice line items failed validation: ${lineValidationErrors.join('; ')}`,
      context: { stage: 'line_validation', invoiceDataId, errors: lineValidationErrors },
    })
    return jsonResponse(
      { error: 'Invoice line items failed validation', details: lineValidationErrors },
      400,
    )
  }

  const qboLines = lineItems.map((li, idx) => {
    // Our schema uses `qty` + `rate`; fall back to `quantity` / `unit_price`
    // for forward-compat if that column naming ever lands.
    const qty = Number(li.qty ?? li.quantity ?? 1) || 1
    const unitPrice = Number(li.rate ?? li.unit_price ?? 0) || 0
    const amount =
      li.amount != null
        ? Number(li.amount)
        : Math.round(qty * unitPrice * 100) / 100
    return {
      LineNum: idx + 1,
      Description: li.description ?? li.name ?? 'Service',
      Amount: amount,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        ItemRef: { value: defaultItemId },
        Qty: qty,
        UnitPrice: unitPrice,
      },
    }
  })

  const txnDate = toYmd(invoice.invoice_date ?? invoice.issue_date ?? invoice.created_at)
  const dueDate = toYmd(invoice.due_date)
  const billEmail = invoice.customer_email ?? client?.email ?? null

  const invPayload: Record<string, unknown> = {
    CustomerRef: { value: customerId },
    Line: qboLines,
    DocNumber: docNumber,
  }
  if (txnDate) invPayload.TxnDate = txnDate
  if (dueDate) invPayload.DueDate = dueDate
  if (billEmail) invPayload.BillEmail = { Address: billEmail }

  // Optional BillAddr from client
  const billAddr: BillAddrInput = {}
  if (client?.billing_address_line1 || client?.address_line1)
    billAddr.Line1 = client.billing_address_line1 ?? client.address_line1
  if (client?.billing_city || client?.city)
    billAddr.City = client.billing_city ?? client.city
  if (client?.billing_state || client?.state)
    billAddr.CountrySubDivisionCode = client.billing_state ?? client.state
  if (client?.billing_postal_code || client?.postal_code || client?.zip)
    billAddr.PostalCode = client.billing_postal_code ?? client.postal_code ?? client.zip
  if (Object.keys(billAddr).length > 0) invPayload.BillAddr = billAddr

  if (invoice.currency_code) {
    invPayload.CurrencyRef = { value: invoice.currency_code }
  }

  // 8. POST invoice to QBO
  let qboInvoiceId: string
  try {
    console.log(`[qbo-push-invoice] POSTing invoice (DocNumber=${docNumber}) to QBO`)
    // Non-idempotent POST: do NOT auto-retry on 5xx because QBO may have
    // processed the request and a blind retry would duplicate. Idempotency on
    // a subsequent caller-driven retry is covered by
    // findExistingInvoiceIdByDocNumber above.
    const res = await qboFetchWithBackoff(
      `${baseUrl}/invoice?minorversion=${QBO_MINOR_VERSION}`,
      {
        method: 'POST',
        headers: qboHeaders,
        body: JSON.stringify(invPayload),
      },
      'invoice create',
      { retryOn5xx: false, timeoutMs: 30000 },
    )
    const text = await res.text()
    let body: any
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`QBO invoice POST returned non-JSON (HTTP ${res.status}): ${text}`)
    }
    // QBO sometimes returns 200 with a Fault — check both.
    if (!res.ok || body.Fault) {
      throw new Error(
        `QBO invoice POST failed (HTTP ${res.status}): ${JSON.stringify(body)}`,
      )
    }
    if (!body.Invoice?.Id) {
      throw new Error(`QBO invoice POST succeeded but no Invoice.Id in response: ${text}`)
    }
    qboInvoiceId = body.Invoice.Id as string
    console.log(`[qbo-push-invoice] QBO created Invoice Id=${qboInvoiceId}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    const isTimeout = (err as any)?.isTimeout === true
    console.error(`[qbo-push-invoice] invoice push failed: ${msg}`)
    await admin
      .from('invoice_data')
      .update({ qbo_sync_status: 'failed' })
      .eq('id', invoiceDataId)
      .then(() => {}, () => {})
    // Best-effort extract of the upstream HTTP status from the thrown message
    // so we can tag the report with UPSTREAM_<status>.
    const httpMatch = /HTTP (\d{3})/.exec(msg)
    const upstreamCode = isTimeout
      ? 'UPSTREAM_TIMEOUT'
      : httpMatch
        ? `UPSTREAM_${httpMatch[1]}`
        : 'UPSTREAM_502'
    void reportError(admin, {
      code: upstreamCode,
      message: `QBO invoice push failed: ${msg}`,
      stack,
      context: { stage: 'invoice_post', invoiceDataId, docNumber },
    })
    if (isTimeout) {
      return jsonResponse({ error: 'QBO call timed out' }, 504)
    }
    return jsonResponse({ error: `QBO invoice push failed: ${msg}` }, 502)
  }

  // 9. Persist the QBO invoice id back to our row
  try {
    const { error: updErr } = await admin
      .from('invoice_data')
      .update({
        qbo_sync_status: 'synced',
        qbo_invoice_id: qboInvoiceId,
      })
      .eq('id', invoiceDataId)
    if (updErr) {
      // The QBO invoice already exists — surface this loudly so it can be reconciled.
      console.error(
        `[qbo-push-invoice] QBO push succeeded (Id=${qboInvoiceId}) but DB write failed: ${updErr.message}`,
      )
      void reportError(admin, {
        code: 'DB_WRITE_FAILED',
        severity: 'critical',
        message: `QBO push succeeded but DB write failed: ${updErr.message}`,
        context: {
          stage: 'final_db_write',
          invoiceDataId,
          qboInvoiceId,
          dbCode: updErr.code,
          table: 'invoice_data',
        },
      })
      return jsonResponse(
        {
          error: `QBO push succeeded but DB write failed: ${updErr.message}`,
          qboInvoiceId,
        },
        500,
      )
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    console.error(`[qbo-push-invoice] DB write failed after QBO push: ${msg}`)
    void reportError(admin, {
      code: 'DB_WRITE_FAILED',
      severity: 'critical',
      message: `QBO push succeeded but DB write failed: ${msg}`,
      stack,
      context: { stage: 'final_db_write', invoiceDataId, qboInvoiceId, table: 'invoice_data' },
    })
    return jsonResponse(
      { error: `QBO push succeeded but DB write failed: ${msg}`, qboInvoiceId },
      500,
    )
  }

  console.log(
    `[qbo-push-invoice] done. invoice_data ${invoiceDataId} -> QBO Invoice ${qboInvoiceId}`,
  )
  return jsonResponse({ qboInvoiceId, qboSyncStatus: 'synced' }, 200)
})
