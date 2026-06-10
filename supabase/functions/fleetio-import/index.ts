// Supabase Edge Function: fleetio-import
// Pulls vehicles, maintenance entries (service_entries), or fuel_entries from
// Fleetio's REST API and upserts them into our schema. Replaces the legacy
// admin.vehicles.index.tsx CSV-parse-in-browser stub.
//
// Invocation:
//   supabase.functions.invoke('fleetio-import', {
//     body: { kind: 'vehicles' | 'maintenance_logs' | 'fuel_logs', dryRun?: boolean }
//   })
//
// Auth:
//   service_role JWT (cron) OR a logged-in profiles.role='admin' user.
//
// Secrets:
//   FLEETIO_BEARER_TOKEN  - bare API key (we build the "Token token=<...>"
//                           Authorization header from it)
//   FLEETIO_ACCOUNT_TOKEN - Account-Token header value
//
// dryRun=true mirrors the qbo-push-time pattern: we fetch from Fleetio and run
// the full diff so the caller gets identical counts, but skip every upsert.
// Instead of opening a `fleetio_imports` audit row we log a single
// `integration_alerts` row (kind=fleetio_dryrun_summary) carrying the planned
// op counts plus a 5-row sample of the rows we would have written — that's
// enough for an admin to spot-check before flipping the toggle off.
//
// Returns: { imported, skipped, errors, importId, durationMs, dryRun, planned }
// where `planned` is null for live runs and { vehiclesToCreate?, vehiclesToUpdate?,
// maintenanceLogsToImport?, fuelLogsToImport?, samples } for dryRun.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// v1 is the live API surface — /api/v2 returns 404 {"status":404,"error":
// "not found"} (verified against a real account 2026-06). v1 responds with
// cursor-paginated envelopes: { start_cursor, next_cursor, records: [...] }.
const FLEETIO_BASE = 'https://secure.fleetio.com/api/v1'
const PAGE_SIZE = 100
const MAX_RETRIES = 3
const FETCH_TIMEOUT_MS = 15_000
// Safety cap so a runaway pagination cursor can never spin forever — Fleetio
// fleets in practice top out in the low thousands; 200 pages * 100 = 20k rows.
const MAX_PAGES = 200
const UPSERT_CHUNK_SIZE = 200

type Kind = 'vehicles' | 'maintenance_logs' | 'fuel_logs'

interface ImportBody {
  kind?: Kind
  dryRun?: boolean
}

interface PlannedSummary {
  vehiclesToCreate?: number
  vehiclesToUpdate?: number
  maintenanceLogsToImport?: number
  fuelLogsToImport?: number
  // First 5 rows of each category — enough for an admin to eyeball before
  // flipping dryRun off. We deliberately keep the row shape as the persisted
  // upsert payload (snake_case keys) so the sample matches what a live run
  // would have written verbatim.
  samples: {
    vehiclesToCreate?: unknown[]
    vehiclesToUpdate?: unknown[]
    maintenanceLogsToImport?: unknown[]
    fuelLogsToImport?: unknown[]
  }
}

interface ImportResult {
  imported: number
  skipped: number
  errors: string[]
  importId: string | null
  durationMs: number
  dryRun: boolean
  planned: PlannedSummary | null
}

// ---------------------------------------------------------------------------
// Auth helpers (inlined — edge functions can't share modules)
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
): Promise<{ failure: Response | null; userId: string | null }> {
  const authHeader = req.headers.get('Authorization') ?? req.headers.get('authorization')
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return {
      failure: new Response(
        JSON.stringify({ error: 'Missing or malformed Authorization header' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 },
      ),
      userId: null,
    }
  }
  const token = authHeader.slice(7).trim()

  if (serviceRoleKey && constantTimeEqual(token, serviceRoleKey)) {
    return { failure: null, userId: null }
  }

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userErr } = await userClient.auth.getUser(token)
  if (userErr || !userData?.user) {
    return {
      failure: new Response(
        JSON.stringify({ error: 'Invalid or expired user token' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 },
      ),
      userId: null,
    }
  }

  const { data: profile, error: profileErr } = await userClient
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()
  if (profileErr || !profile || profile.role !== 'admin') {
    return {
      failure: new Response(
        JSON.stringify({ error: 'Admin privileges required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 },
      ),
      userId: null,
    }
  }

  return { failure: null, userId: userData.user.id }
}

// ---------------------------------------------------------------------------
// Error reporting (fire-and-forget)
// ---------------------------------------------------------------------------

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
      p_function_name: 'fleetio-import',
      p_context: opts.context ?? {},
    })
  } catch (e) {
    console.error(
      '[fleetio-import] reportError failed (swallowed):',
      e instanceof Error ? e.message : String(e),
    )
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers — fetchWithTimeout + 429 retry with Retry-After + backoff
// ---------------------------------------------------------------------------

class FleetioError extends Error {
  status: number
  isTimeout: boolean
  constructor(message: string, opts: { status?: number; isTimeout?: boolean } = {}) {
    super(message)
    this.status = opts.status ?? 0
    this.isTimeout = !!opts.isTimeout
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') {
      throw new FleetioError(`Fleetio request timed out after ${ms}ms: ${url}`, {
        isTimeout: true,
      })
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function fleetioGet<T>(
  path: string,
  bearer: string,
  accountToken: string,
  attempt = 0,
): Promise<T> {
  const url = `${FLEETIO_BASE}${path}`
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Authorization: `Token token=${bearer}`,
      'Account-Token': accountToken,
      Accept: 'application/json',
    },
  })

  // Rate-limited: respect Retry-After then exponential backoff (cap 3 retries).
  if (res.status === 429 && attempt < MAX_RETRIES) {
    const retryAfterHeader = res.headers.get('Retry-After')
    const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN
    const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(2 ** attempt * 1000, 8000)
    console.warn(
      `[fleetio-import] 429 on ${path} (attempt ${attempt + 1}/${MAX_RETRIES}). ` +
        `Waiting ${waitMs}ms before retry.`,
    )
    await new Promise((r) => setTimeout(r, waitMs))
    return fleetioGet<T>(path, bearer, accountToken, attempt + 1)
  }

  if (!res.ok) {
    let bodyText = ''
    try {
      bodyText = await res.text()
    } catch {
      // ignore — we still want to throw with the status
    }
    throw new FleetioError(
      `Fleetio ${path} returned HTTP ${res.status}: ${bodyText.slice(0, 500)}`,
      { status: res.status },
    )
  }

  try {
    return (await res.json()) as T
  } catch (e) {
    throw new FleetioError(
      `Fleetio ${path}: non-JSON response: ${(e as Error).message}`,
      { status: res.status },
    )
  }
}

// ---------------------------------------------------------------------------
// Mappers — Fleetio domain -> our schema
// ---------------------------------------------------------------------------

interface FleetioVehicle {
  id: number | string
  name?: string | null
  vehicle_name?: string | null
  license_plate?: string | null
  year?: number | string | null
  vehicle_type_name?: string | null
  vin?: string | null
  current_meter_value?: number | string | null
  meter_unit?: string | null
  primary_meter_unit?: string | null
  archived_at?: string | null
  is_active?: boolean | null
}

interface FleetioServiceEntry {
  id: number | string
  vehicle_id: number | string
  label?: string | null
  vendor_name?: string | null
  vendor?: { name?: string | null } | null
  started_at?: string | null
  completed_at?: string | null
  service_date?: string | null
  // bare-array (classic) service_entries shape uses `date` and
  // `general_notes` (verified against the live v1 API)
  date?: string | null
  general_notes?: string | null
  meter_entry?: { value?: number | string | null } | null
  meter_value?: number | string | null
  total_amount_cents?: number | string | null
  total_amount?: number | string | null
  comments?: string | null
  description?: string | null
}

interface FleetioFuelEntry {
  id: number | string
  vehicle_id: number | string
  date?: string | null
  liquid_amount?: number | string | null
  us_gallons?: number | string | null
  total_amount?: number | string | null
  total_amount_cents?: number | string | null
  location?: string | null
  vendor_name?: string | null
  vendor?: { name?: string | null } | null
}

// Map Fleetio vehicle_type_name to our `vehicle_type` enum. Defaults to
// 'equipment' for unrecognised categories so the row still imports instead of
// being silently skipped on a CHECK violation.
function mapVehicleType(name: string | null | undefined): 'truck' | 'trailer' | 'equipment' {
  const v = (name ?? '').trim().toLowerCase()
  if (!v) return 'equipment'
  if (v.includes('truck') || v.includes('tractor') || v.includes('pickup')) return 'truck'
  if (v.includes('trailer')) return 'trailer'
  return 'equipment'
}

function toIntOrZero(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : (value as number)
  return Number.isFinite(n) ? Math.round(n as number) : 0
}

function toYmd(input: string | null | undefined): string | null {
  if (!input) return null
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) {
    // Already YYYY-MM-DD?
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input
    return null
  }
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

// Fleetio reports meter_unit as 'mi' or 'km'. Our `vehicles.odometer` is
// canonical km, so we convert miles -> km when needed.
function odometerToKm(value: unknown, unit: string | null | undefined): number {
  const raw = toIntOrZero(value)
  if (raw <= 0) return 0
  const u = (unit ?? '').trim().toLowerCase()
  if (u === 'mi' || u === 'miles' || u === 'mile') {
    return Math.round(raw * 1.609344)
  }
  return raw
}

function mapVehicleRow(v: FleetioVehicle): {
  id: string
  name: string
  plate: string
  year: number
  type: 'truck' | 'trailer' | 'equipment'
  vin: string
  odometer: number
  status: 'operational' | 'out-of-service'
} {
  const meterUnit = v.meter_unit ?? v.primary_meter_unit ?? null
  const active = v.is_active == null ? !v.archived_at : !!v.is_active
  const yearRaw =
    typeof v.year === 'string' ? Number(v.year) : typeof v.year === 'number' ? v.year : null
  const year = Number.isFinite(yearRaw as number) ? (yearRaw as number) : 1970
  return {
    id: `FLEETIO-${v.id}`,
    name: (v.vehicle_name ?? v.name ?? `Fleetio ${v.id}`).toString(),
    plate: (v.license_plate ?? '').toString(),
    year,
    type: mapVehicleType(v.vehicle_type_name),
    vin: (v.vin ?? '').toString(),
    odometer: odometerToKm(v.current_meter_value, meterUnit),
    status: active ? 'operational' : 'out-of-service',
  }
}

function mapMaintenanceRow(s: FleetioServiceEntry): {
  id: string
  vehicle_id: string
  type: string
  performed_by: string
  date: string
  mileage: number
  cost: number
  notes: string
} | null {
  const date =
    toYmd(s.service_date) ??
    toYmd(s.date) ??
    toYmd(s.completed_at) ??
    toYmd(s.started_at) ??
    null
  if (!date) return null
  const vendor =
    s.vendor_name ?? s.vendor?.name ?? '' // empty when in-house
  const cents =
    typeof s.total_amount_cents === 'string'
      ? Number(s.total_amount_cents)
      : typeof s.total_amount_cents === 'number'
        ? s.total_amount_cents
        : null
  let cost = 0
  if (cents != null && Number.isFinite(cents)) {
    cost = Math.round((cents / 100) * 100) / 100
  } else if (s.total_amount != null) {
    const n = typeof s.total_amount === 'string' ? Number(s.total_amount) : s.total_amount
    cost = Number.isFinite(n) ? Math.round((n as number) * 100) / 100 : 0
  }
  const mileage = toIntOrZero(s.meter_value ?? s.meter_entry?.value ?? 0)
  return {
    id: `FLEETIO-MAINT-${s.id}`,
    vehicle_id: `FLEETIO-${s.vehicle_id}`,
    type: (s.label ?? 'Service').toString(),
    performed_by: vendor.toString(),
    date,
    mileage,
    cost,
    notes: (s.description ?? s.comments ?? s.general_notes ?? '').toString(),
  }
}

function mapFuelRow(f: FleetioFuelEntry): {
  id: string
  vehicle_id: string
  date: string
  gallons: number
  cost: number
  location: string
} | null {
  const date = toYmd(f.date)
  if (!date) return null
  const gallonsRaw =
    f.us_gallons ?? f.liquid_amount ?? 0
  const gallons =
    typeof gallonsRaw === 'string' ? Number(gallonsRaw) : (gallonsRaw as number)
  const cents =
    typeof f.total_amount_cents === 'string'
      ? Number(f.total_amount_cents)
      : typeof f.total_amount_cents === 'number'
        ? f.total_amount_cents
        : null
  let cost = 0
  if (cents != null && Number.isFinite(cents)) {
    cost = Math.round((cents / 100) * 100) / 100
  } else if (f.total_amount != null) {
    const n = typeof f.total_amount === 'string' ? Number(f.total_amount) : f.total_amount
    cost = Number.isFinite(n) ? Math.round((n as number) * 100) / 100 : 0
  }
  return {
    id: `FLEETIO-FUEL-${f.id}`,
    vehicle_id: `FLEETIO-${f.vehicle_id}`,
    date,
    gallons: Number.isFinite(gallons) ? Math.round(gallons * 100) / 100 : 0,
    cost,
    location: (f.location ?? f.vendor_name ?? f.vendor?.name ?? '').toString(),
  }
}

// ---------------------------------------------------------------------------
// Pagination — Fleetio v1 mixes TWO styles per endpoint (verified live):
//   - vehicles / fuel_entries: cursor envelope { start_cursor, next_cursor,
//     records: [...] }; next page via ?start_cursor=<next_cursor> (base64,
//     URL-encoded); next_cursor=null means last page.
//   - service_entries: BARE ARRAY body with classic ?page=N pagination;
//     stop on a short page.
// We detect the style from the first response and stick with it.
// ---------------------------------------------------------------------------

interface FleetioPageEnvelope<T> {
  start_cursor?: string | null
  next_cursor?: string | null
  records?: T[]
}

async function fetchAllPages<T>(
  endpoint: 'vehicles' | 'service_entries' | 'fuel_entries',
  bearer: string,
  accountToken: string,
): Promise<T[]> {
  const out: T[] = []
  let cursor: string | null = null
  let classic = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/${endpoint}?per_page=${PAGE_SIZE}${
      classic ? `&page=${page}` : cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''
    }`
    const body = await fleetioGet<FleetioPageEnvelope<T> | T[]>(path, bearer, accountToken)
    if (Array.isArray(body)) {
      classic = true
      out.push(...body)
      if (body.length < PAGE_SIZE) break
      continue
    }
    const records = body?.records
    if (!Array.isArray(records)) {
      throw new FleetioError(
        `Fleetio ${endpoint} page ${page}: expected records array, got ${typeof records}`,
        { status: 200 },
      )
    }
    out.push(...records)
    const next = body?.next_cursor ?? null
    if (!next || next === cursor) break
    cursor = next
  }
  return out
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const startedAt = Date.now()

  // ----- 0. Required SUPABASE env -----
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    const msg = `Missing required environment variables: ${
      [
        !SUPABASE_URL && 'SUPABASE_URL',
        !SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY',
        !SERVICE_ROLE_KEY && 'SUPABASE_SERVICE_ROLE_KEY',
      ]
        .filter(Boolean)
        .join(', ')
    }`
    console.error(msg)
    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      const oneOff = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      void reportError(oneOff, {
        code: 'MISSING_SECRETS',
        severity: 'critical',
        message: msg,
        context: { stage: 'bootstrap' },
      })
    }
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }

  // ----- 1. Verify caller -----
  const { failure: authFailure, userId } = await verifyAdminOrServiceRole(
    req,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SERVICE_ROLE_KEY,
  )
  if (authFailure) return authFailure

  // ----- 2. Validate Fleetio secrets (after auth so we don't leak shape to anon) -----
  const FLEETIO_BEARER_TOKEN = Deno.env.get('FLEETIO_BEARER_TOKEN')
  const FLEETIO_ACCOUNT_TOKEN = Deno.env.get('FLEETIO_ACCOUNT_TOKEN')
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  if (!FLEETIO_BEARER_TOKEN || !FLEETIO_ACCOUNT_TOKEN) {
    const missing = [
      !FLEETIO_BEARER_TOKEN && 'FLEETIO_BEARER_TOKEN',
      !FLEETIO_ACCOUNT_TOKEN && 'FLEETIO_ACCOUNT_TOKEN',
    ].filter(Boolean)
    const msg = `Missing required environment variables: ${missing.join(', ')}`
    console.error(msg)
    void reportError(supabase, {
      code: 'MISSING_SECRETS',
      severity: 'critical',
      message: msg,
      context: { missing, stage: 'secret_validation' },
    })
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }

  // ----- 3. Parse body -----
  let body: ImportBody = {}
  if (req.method === 'POST') {
    const text = await req.text()
    if (text.trim().length) {
      try {
        body = JSON.parse(text) as ImportBody
      } catch (e) {
        const msg = `Invalid JSON body: ${(e as Error).message}`
        void reportError(supabase, {
          code: 'VALIDATION',
          severity: 'warn',
          message: msg,
          stack: (e as Error).stack ?? null,
          context: { stage: 'body_parse' },
        })
        return new Response(JSON.stringify({ error: msg }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 400,
        })
      }
    }
  }
  const kind = body.kind ?? 'vehicles'
  const dryRun = body.dryRun === true
  if (kind !== 'vehicles' && kind !== 'maintenance_logs' && kind !== 'fuel_logs') {
    const msg = `Invalid kind "${String(kind)}" (expected vehicles | maintenance_logs | fuel_logs)`
    return new Response(JSON.stringify({ error: msg }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }

  // ----- 4. Record the import audit row -----
  let importId: string | null = null
  if (!dryRun) {
    const { data: importRow, error: importErr } = await supabase
      .from('fleetio_imports')
      .insert({
        kind,
        started_at: new Date().toISOString(),
        started_by: userId,
      })
      .select('id')
      .single()
    if (importErr) {
      console.error('[fleetio-import] failed to insert fleetio_imports row:', importErr)
      void reportError(supabase, {
        code: 'DB_WRITE_FAILED',
        message: `fleetio_imports insert failed: ${importErr.message}`,
        context: { stage: 'audit_insert', dbCode: importErr.code, kind },
      })
      return new Response(
        JSON.stringify({
          error: 'Failed to record import run',
          stage: 'database',
          code: importErr.code,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }
    importId = importRow?.id ?? null
  }

  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    importId,
    durationMs: 0,
    dryRun,
    planned: dryRun
      ? {
          samples: {},
        }
      : null,
  }

  try {
    // ----- 5. Dispatch by kind -----
    if (kind === 'vehicles') {
      console.log('[fleetio-import] fetching vehicles...')
      const remote = await fetchAllPages<FleetioVehicle>(
        'vehicles',
        FLEETIO_BEARER_TOKEN,
        FLEETIO_ACCOUNT_TOKEN,
      )
      console.log(`[fleetio-import] Fleetio returned ${remote.length} vehicles`)

      const rows = remote.map(mapVehicleRow)
      if (!dryRun) {
        for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
          const { error } = await supabase
            .from('vehicles')
            .upsert(batch, { onConflict: 'id' })
          if (error) {
            console.error('[fleetio-import] vehicles upsert failed:', error)
            result.errors.push(`vehicles upsert: ${error.message}`)
            // Bail on the first real DB error rather than silently swallow.
            throw new FleetioError(
              `vehicles upsert failed: ${error.message}`,
              { status: 500 },
            )
          }
          result.imported += batch.length
        }
      } else {
        // dryRun: classify each candidate as create vs update by checking
        // which ids already exist. We chunk the IN-list to stay under the
        // URL/param limit; the same chunk size used elsewhere is fine here.
        const existingIds = new Set<string>()
        for (const ids of chunk(rows.map((r) => r.id), 500)) {
          const { data, error } = await supabase
            .from('vehicles')
            .select('id')
            .in('id', ids)
          if (error) {
            throw new FleetioError(
              `vehicles dryRun lookup failed: ${error.message}`,
              { status: 500 },
            )
          }
          for (const row of data ?? []) existingIds.add(row.id)
        }
        const toCreate = rows.filter((r) => !existingIds.has(r.id))
        const toUpdate = rows.filter((r) => existingIds.has(r.id))
        result.imported = rows.length
        result.planned = {
          vehiclesToCreate: toCreate.length,
          vehiclesToUpdate: toUpdate.length,
          samples: {
            vehiclesToCreate: toCreate.slice(0, 5),
            vehiclesToUpdate: toUpdate.slice(0, 5),
          },
        }
      }
    } else if (kind === 'maintenance_logs') {
      console.log('[fleetio-import] fetching service_entries...')
      const remote = await fetchAllPages<FleetioServiceEntry>(
        'service_entries',
        FLEETIO_BEARER_TOKEN,
        FLEETIO_ACCOUNT_TOKEN,
      )
      console.log(`[fleetio-import] Fleetio returned ${remote.length} service entries`)

      // Pre-load the set of Fleetio-sourced vehicle ids we already have so we
      // can skip orphan service entries (vehicle deleted in our DB, or never
      // imported). Doing this with one IN-list is far cheaper than per-row
      // existence checks.
      const candidateVehicleIds = Array.from(
        new Set(remote.map((s) => `FLEETIO-${s.vehicle_id}`)),
      )
      const knownVehicleIds = new Set<string>()
      for (const ids of chunk(candidateVehicleIds, 500)) {
        const { data, error } = await supabase
          .from('vehicles')
          .select('id')
          .in('id', ids)
        if (error) {
          throw new FleetioError(
            `vehicles lookup failed: ${error.message}`,
            { status: 500 },
          )
        }
        for (const row of data ?? []) knownVehicleIds.add(row.id)
      }

      const rows: ReturnType<typeof mapMaintenanceRow>[] = []
      for (const s of remote) {
        const mapped = mapMaintenanceRow(s)
        if (!mapped) {
          result.skipped++
          continue
        }
        if (!knownVehicleIds.has(mapped.vehicle_id)) {
          result.skipped++
          continue
        }
        rows.push(mapped)
      }

      const concrete = rows.filter((r): r is NonNullable<typeof r> => r != null)
      if (!dryRun) {
        for (const batch of chunk(concrete, UPSERT_CHUNK_SIZE)) {
          const { error } = await supabase
            .from('maintenance_logs')
            .upsert(batch, { onConflict: 'id' })
          if (error) {
            console.error('[fleetio-import] maintenance_logs upsert failed:', error)
            result.errors.push(`maintenance_logs upsert: ${error.message}`)
            throw new FleetioError(
              `maintenance_logs upsert failed: ${error.message}`,
              { status: 500 },
            )
          }
          result.imported += batch.length
        }
      } else {
        result.imported = concrete.length
        result.planned = {
          maintenanceLogsToImport: concrete.length,
          samples: {
            maintenanceLogsToImport: concrete.slice(0, 5),
          },
        }
      }
    } else {
      // fuel_logs
      console.log('[fleetio-import] fetching fuel_entries...')
      const remote = await fetchAllPages<FleetioFuelEntry>(
        'fuel_entries',
        FLEETIO_BEARER_TOKEN,
        FLEETIO_ACCOUNT_TOKEN,
      )
      console.log(`[fleetio-import] Fleetio returned ${remote.length} fuel entries`)

      const candidateVehicleIds = Array.from(
        new Set(remote.map((f) => `FLEETIO-${f.vehicle_id}`)),
      )
      const knownVehicleIds = new Set<string>()
      for (const ids of chunk(candidateVehicleIds, 500)) {
        const { data, error } = await supabase
          .from('vehicles')
          .select('id')
          .in('id', ids)
        if (error) {
          throw new FleetioError(
            `vehicles lookup failed: ${error.message}`,
            { status: 500 },
          )
        }
        for (const row of data ?? []) knownVehicleIds.add(row.id)
      }

      const rows: NonNullable<ReturnType<typeof mapFuelRow>>[] = []
      for (const f of remote) {
        const mapped = mapFuelRow(f)
        if (!mapped) {
          result.skipped++
          continue
        }
        if (!knownVehicleIds.has(mapped.vehicle_id)) {
          result.skipped++
          continue
        }
        rows.push(mapped)
      }

      if (!dryRun) {
        for (const batch of chunk(rows, UPSERT_CHUNK_SIZE)) {
          const { error } = await supabase
            .from('fuel_logs')
            .upsert(batch, { onConflict: 'id' })
          if (error) {
            console.error('[fleetio-import] fuel_logs upsert failed:', error)
            result.errors.push(`fuel_logs upsert: ${error.message}`)
            throw new FleetioError(
              `fuel_logs upsert failed: ${error.message}`,
              { status: 500 },
            )
          }
          result.imported += batch.length
        }
      } else {
        result.imported = rows.length
        result.planned = {
          fuelLogsToImport: rows.length,
          samples: {
            fuelLogsToImport: rows.slice(0, 5),
          },
        }
      }
    }

    // ----- 6. Finalise audit row on success -----
    // dryRun path: log a single integration_alerts row with the planned op
    // counts + samples so admins have a server-side record of every preview
    // that was run. Mirrors the qbo_dryrun_summary pattern. Best-effort: a
    // failure here doesn't poison the in-memory result we hand back to the
    // caller — the UI counts are what the admin actually needs.
    if (dryRun) {
      try {
        const { error: alertErr } = await supabase
          .from('integration_alerts')
          .insert({
            kind: 'fleetio_dryrun_summary',
            message: `Fleetio dryRun for kind=${kind}: would touch ${result.imported} rows (skipped ${result.skipped})`,
            context: {
              source: 'fleetio-import',
              kind,
              userId,
              imported: result.imported,
              skipped: result.skipped,
              planned: result.planned,
              durationMs: Date.now() - startedAt,
            },
          })
        if (alertErr) {
          console.warn(
            '[fleetio-import] dryRun audit insert failed:',
            alertErr.message,
          )
          result.errors.push(`dryRun audit: ${alertErr.message}`)
        }
      } catch (e) {
        console.warn(
          '[fleetio-import] dryRun audit insert threw:',
          e instanceof Error ? e.message : String(e),
        )
      }
    }
    if (!dryRun && importId) {
      const { error: updErr } = await supabase
        .from('fleetio_imports')
        .update({
          completed_at: new Date().toISOString(),
          imported_count: result.imported,
          skipped_count: result.skipped,
          error_count: result.errors.length,
          last_error: result.errors[0] ?? null,
        })
        .eq('id', importId)
      if (updErr) {
        console.warn('[fleetio-import] failed to finalise audit row:', updErr.message)
        // Non-fatal — the data already landed; surface in errors.
        result.errors.push(`audit update: ${updErr.message}`)
      }
    }

    result.durationMs = Date.now() - startedAt
    console.log(`[fleetio-import] done: ${JSON.stringify(result)}`)
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    const isFleetio = err instanceof FleetioError
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? (err.stack ?? null) : null
    const isTimeout = isFleetio && (err as FleetioError).isTimeout
    const upstreamStatus = isFleetio ? (err as FleetioError).status : 0
    const status = isTimeout ? 504 : upstreamStatus >= 500 ? 502 : 500
    console.error('[fleetio-import] fatal:', message)

    // Best-effort: mark the audit row failed so admins can see it on retry.
    if (importId) {
      try {
        await supabase
          .from('fleetio_imports')
          .update({
            completed_at: new Date().toISOString(),
            imported_count: result.imported,
            skipped_count: result.skipped,
            error_count: Math.max(1, result.errors.length),
            last_error: message.slice(0, 2000),
          })
          .eq('id', importId)
      } catch (e) {
        console.warn(
          '[fleetio-import] failed to mark audit row failed:',
          e instanceof Error ? e.message : String(e),
        )
      }
    }

    void reportError(supabase, {
      code: isTimeout
        ? 'UPSTREAM_TIMEOUT'
        : upstreamStatus
          ? `UPSTREAM_${upstreamStatus}`
          : 'UPSTREAM_500',
      severity: 'error',
      message,
      stack,
      context: { stage: 'sync', kind, importId, upstreamStatus },
    })

    result.errors.push(message)
    result.durationMs = Date.now() - startedAt
    return new Response(
      JSON.stringify({
        error: message,
        stage: isFleetio ? 'upstream' : 'unknown',
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
        importId,
        durationMs: result.durationMs,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status },
    )
  }
})
