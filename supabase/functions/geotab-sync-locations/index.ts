// Supabase Edge Function: geotab-sync-locations
// Pulls current GPS location for every vehicle from MyGeotab and upserts into
// public.vehicles (matched by geotab_device_id). Also appends a row to
// public.vehicle_locations (if the table exists) for historical analytics.
//
// Invocation:
//   - Cron (scheduled) or
//   - On-demand: supabase.functions.invoke('geotab-sync-locations')
//
// Returns: { synced: number, errors: string[] }

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

/**
 * Verify the caller is allowed to invoke this function.
 * Returns null on success, or a Response (401) to be returned to the caller.
 *
 * Allowed callers:
 *   1. Anything presenting a JWT whose `role` claim is `service_role`
 *      (cron jobs, server-to-server calls using the service-role key).
 *   2. A logged-in user whose `profiles.role` is `admin`.
 *
 * Everything else gets a 401.
 *
 * NOTE: This is inlined into each edge function on purpose — Supabase Edge
 * Functions are isolated, so we cannot share a module between them.
 */
/**
 * Constant-time string comparison so an attacker can't time-side-channel
 * partial matches on the service-role key.
 */
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

  // Server-to-server: compare the presented bearer to the configured
  // SUPABASE_SERVICE_ROLE_KEY in constant time. Trusting an unverified
  // role-claim from a JWT payload would let anyone with the public anon key
  // forge a token with {role:'service_role'} and bypass auth entirely.
  if (serviceRoleKey && constantTimeEqual(token, serviceRoleKey)) {
    return null
  }

  // Otherwise, verify it's a real user token and check the profiles.role.
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

const GEOTAB_AUTH_HOST = 'my.geotab.com'
const UPSERT_CHUNK_SIZE = 500
const MAX_RETRIES = 3

interface GeotabCredentials {
  userName: string
  database: string
  sessionId: string
}

interface GeotabAuthResult {
  path: string
  credentials: GeotabCredentials
}

interface DeviceStatusInfo {
  id?: string
  device?: { id?: string }
  driver?: { id?: string } | string
  dateTime?: string
  latitude?: number
  longitude?: number
  speed?: number
  bearing?: number
  isDeviceCommunicating?: boolean
  isDriving?: boolean
  currentStateDuration?: string
}

// Geotab StatusData rows carry a single diagnostic sample per device. We pull
// two diagnostics — odometer (km) and engine hours (seconds) — over the last
// few hours and keep only the latest sample per device for each.
interface StatusDataRow {
  device?: { id?: string }
  data?: number
  dateTime?: string
}

interface SyncResult {
  synced: number
  telemetrySynced: number
  skipped: number
  matched: number
  unmatched: number
  errors: string[]
  durationMs: number
}

// How far back to query StatusData. The *AdjustmentId* diagnostics only emit
// rows when the value CHANGES (e.g. while driving), so a truck parked for
// hours has no recent samples. 7 days catches the cold-start case where
// vehicles.odometer is 0 and a multi-day-old reading would otherwise be
// missed forever, breaking preventive-maintenance thresholds. Combined with
// the only-update-if-strictly-greater guard below, an old sample can never
// regress a more-recent DB value.
const STATUS_DATA_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const DIAGNOSTIC_ODOMETER_ID = 'DiagnosticOdometerAdjustmentId'
const DIAGNOSTIC_ENGINE_HOURS_ID = 'DiagnosticEngineHoursAdjustmentId'

/**
 * JSON-RPC 2.0 call to the MyGeotab API.
 * Errors arrive as HTTP 200 with an `error` object in the body — we must
 * inspect the body, not the HTTP status. Respects Retry-After on 429-ish
 * OverLimitException responses with simple exponential backoff.
 */
async function geotabRpc<T = unknown>(
  host: string,
  method: string,
  params: unknown,
  attempt = 0,
): Promise<T> {
  const url = `https://${host}/apiv1`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method, params }),
      signal: controller.signal,
    })
  } catch (e) {
    if ((e as any)?.name === 'AbortError') {
      const err = new Error(`Geotab RPC ${method}: timed out after 15s`) as Error & {
        isTimeout?: boolean
      }
      err.isTimeout = true
      throw err
    }
    throw e
  } finally {
    clearTimeout(timer)
  }

  // Transport-level failure (rare; usually 200 even on app errors).
  let body: any
  try {
    body = await res.json()
  } catch (e) {
    throw new Error(
      `Geotab RPC ${method}: non-JSON response (HTTP ${res.status}): ${(e as Error).message}`,
    )
  }

  if (body?.error) {
    const type = body.error?.data?.type ?? 'GeotabError'
    const message = body.error?.message ?? 'Unknown Geotab error'

    // Rate-limited: respect Retry-After then back off exponentially.
    if (type === 'OverLimitException' && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get('Retry-After')
      const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN
      const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : Math.min(2 ** attempt * 1000, 8000)
      console.warn(
        `Geotab OverLimitException on ${method} (attempt ${attempt + 1}/${MAX_RETRIES}). ` +
        `Waiting ${waitMs}ms before retry.`,
      )
      await new Promise((r) => setTimeout(r, waitMs))
      return geotabRpc<T>(host, method, params, attempt + 1)
    }

    // Surface the exception type so callers can branch (e.g. on InvalidUserException).
    const err = new Error(`${type}: ${message}`)
    ;(err as any).geotabType = type
    throw err
  }

  return body.result as T
}

/** Authenticate against MyGeotab and resolve the actual data-host (`path`). */
async function authenticate(
  database: string,
  userName: string,
  password: string,
): Promise<{ host: string; credentials: GeotabCredentials }> {
  console.log(`Authenticating to MyGeotab database "${database}" as "${userName}"...`)
  const auth = await geotabRpc<GeotabAuthResult>(GEOTAB_AUTH_HOST, 'Authenticate', {
    database,
    userName,
    password,
  })
  if (!auth?.credentials?.sessionId) {
    throw new Error('Geotab Authenticate returned no sessionId')
  }
  // path === "ThisServer" means stay on my.geotab.com; otherwise switch hosts.
  const host = !auth.path || auth.path === 'ThisServer' ? GEOTAB_AUTH_HOST : auth.path
  console.log(`Authenticated. Geotab data host resolved to: ${host}`)
  return { host, credentials: auth.credentials }
}

/** Convert Geotab km/h speed to mph (rounded to one decimal). */
function kmhToMph(kmh: number | undefined): number | null {
  if (typeof kmh !== 'number' || !Number.isFinite(kmh)) return null
  return Math.round(kmh * 0.621371 * 10) / 10
}

/** Chunked array helper. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * StatusData responses contain one row per sample, so a device that reported
 * 30 odometer points in the last 3h is in there 30 times. We want only the
 * most recent value per device, so this reduces the array to a Map keyed by
 * device id with the latest dateTime winning ties.
 */
function latestByDevice(rows: StatusDataRow[]): Map<string, number> {
  const latest = new Map<string, { value: number; ts: number }>()
  for (const row of rows) {
    const deviceId = row?.device?.id
    const value = row?.data
    const dt = row?.dateTime
    if (!deviceId || typeof value !== 'number' || !Number.isFinite(value)) continue
    const ts = typeof dt === 'string' ? Date.parse(dt) : NaN
    if (!Number.isFinite(ts)) continue
    const prev = latest.get(deviceId)
    if (!prev || ts > prev.ts) latest.set(deviceId, { value, ts })
  }
  const out = new Map<string, number>()
  for (const [k, v] of latest) out.set(k, v.value)
  return out
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
      p_function_name: 'geotab-sync-locations',
      p_context: opts.context ?? {},
    })
  } catch (e) {
    console.error(
      '[geotab-sync-locations] reportError failed (swallowed):',
      e instanceof Error ? e.message : String(e),
    )
  }
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ----- 0. Verify caller (service_role JWT or admin user) -----
  // SUPABASE_URL + SUPABASE_ANON_KEY must be available BEFORE auth runs so the
  // helper can construct a user-scoped client. We validate them up-front and
  // defer the rest of the secret-validation pass until after auth succeeds.
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  const SERVICE_ROLE_KEY_FOR_AUTH = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY_FOR_AUTH) {
    const msg = `Missing required environment variables: ${
      [
        !SUPABASE_URL && 'SUPABASE_URL',
        !SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY',
        !SERVICE_ROLE_KEY_FOR_AUTH && 'SUPABASE_SERVICE_ROLE_KEY',
      ]
        .filter(Boolean)
        .join(', ')
    }`
    console.error(msg)
    // Early-failure path: admin client doesn't exist yet. If we have URL +
    // service-role key we can still surface this critical config error.
    if (SUPABASE_URL && SERVICE_ROLE_KEY_FOR_AUTH) {
      const oneOff = createClient(SUPABASE_URL, SERVICE_ROLE_KEY_FOR_AUTH, {
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
  const authFailure = await verifyAdminOrServiceRole(
    req,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SERVICE_ROLE_KEY_FOR_AUTH,
  )
  if (authFailure) return authFailure

  const startedAt = Date.now()

  try {
    // ----- 1. Validate remaining required secrets -----
    const GEOTAB_USERNAME = Deno.env.get('GEOTAB_USERNAME')
    const GEOTAB_PASSWORD = Deno.env.get('GEOTAB_PASSWORD')
    const GEOTAB_DATABASE = Deno.env.get('GEOTAB_DATABASE')
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    const missing: string[] = []
    if (!GEOTAB_USERNAME) missing.push('GEOTAB_USERNAME')
    if (!GEOTAB_PASSWORD) missing.push('GEOTAB_PASSWORD')
    if (!GEOTAB_DATABASE) missing.push('GEOTAB_DATABASE')
    if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')

    if (missing.length) {
      const msg = `Missing required environment variables: ${missing.join(', ')}`
      console.error(msg)
      // SERVICE_ROLE_KEY_FOR_AUTH is guaranteed non-null here (checked above);
      // use it to build a one-off admin client for reporting even when the
      // function-specific secret env happens to be the missing one.
      const oneOff = createClient(SUPABASE_URL, SERVICE_ROLE_KEY_FOR_AUTH, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      void reportError(oneOff, {
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

    // ----- 2. Parse (optional) body -----
    // Accepts: {} or { includeStale?: boolean }
    let body: { includeStale?: boolean } = {}
    if (req.method === 'POST') {
      const text = await req.text()
      if (text.trim().length) {
        try {
          body = JSON.parse(text)
        } catch (e) {
          const msg = `Invalid JSON body: ${(e as Error).message}`
          console.error(msg)
          // admin client not yet constructed — build a one-off for the report.
          const oneOff = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY!, {
            auth: { persistSession: false, autoRefreshToken: false },
          })
          void reportError(oneOff, {
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
    // default: include stale rows. Strictly require a boolean to override.
    const includeStale = typeof body.includeStale === 'boolean' ? body.includeStale : true

    // ----- 3. Supabase service-role client (writes bypass RLS) -----
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // ----- 4. Talk to Geotab -----
    let host: string
    let credentials: GeotabCredentials
    let statuses: DeviceStatusInfo[]

    try {
      const authResult = await authenticate(GEOTAB_DATABASE!, GEOTAB_USERNAME!, GEOTAB_PASSWORD!)
      host = authResult.host
      credentials = authResult.credentials

      console.log(`Fetching DeviceStatusInfo from ${host}...`)
      const getParams: Record<string, unknown> = {
        typeName: 'DeviceStatusInfo',
        credentials,
      }

      try {
        statuses = await geotabRpc<DeviceStatusInfo[]>(host, 'Get', getParams)
      } catch (e) {
        // If the cached session expired between Authenticate and Get, re-auth
        // once and retry. We deliberately do NOT retry on InvalidUserException
        // — that signals bad credentials, which retrying cannot fix.
        if ((e as any)?.geotabType === 'InvalidSessionIdException') {
          console.warn('Session invalid; re-authenticating once...')
          const re = await authenticate(GEOTAB_DATABASE!, GEOTAB_USERNAME!, GEOTAB_PASSWORD!)
          host = re.host
          credentials = re.credentials
          getParams.credentials = credentials
          statuses = await geotabRpc<DeviceStatusInfo[]>(host, 'Get', getParams)
        } else {
          throw e
        }
      }

      console.log(`Geotab returned ${statuses?.length ?? 0} DeviceStatusInfo records.`)
    } catch (e) {
      const msg = `Geotab API failed: ${(e as Error).message}`
      const isTimeout = !!(e as { isTimeout?: boolean })?.isTimeout
      const status = isTimeout ? 504 : 502
      console.error(msg)
      // InvalidUserException (bad credentials) is an AUTH_FAILED; everything
      // else from the upstream is mapped to UPSTREAM_<status> (or _TIMEOUT).
      const geotabType = (e as { geotabType?: string })?.geotabType
      const isAuth = geotabType === 'InvalidUserException'
      void reportError(supabase, {
        code: isAuth
          ? 'AUTH_FAILED'
          : isTimeout
            ? 'UPSTREAM_TIMEOUT'
            : `UPSTREAM_${status}`,
        severity: isAuth ? 'warn' : 'error',
        message: msg,
        stack: (e as Error).stack ?? null,
        context: { stage: 'upstream', geotabType },
      })
      return new Response(JSON.stringify({ error: msg, stage: 'upstream' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status,
      })
    }

    if (!Array.isArray(statuses)) {
      const msg = `Geotab returned unexpected payload (expected array, got ${typeof statuses})`
      console.error(msg)
      void reportError(supabase, {
        code: 'UPSTREAM_502',
        message: msg,
        context: { stage: 'upstream', payloadType: typeof statuses },
      })
      return new Response(JSON.stringify({ error: msg, stage: 'upstream' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 502,
      })
    }

    // ----- 5. Look up which vehicles exist in our DB (to skip unknown devices) -----
    // We pull odometer + engine_hours in the SAME query as the id mapping so we
    // can do the strict-greater guard client-side later without a second round
    // trip per chunk. The maps are keyed by geotab_device_id (what Geotab gives
    // us) but also indexed by vehicle id (what we'll upsert by).
    const incomingDeviceIds = Array.from(
      new Set(
        statuses
          .map((s) => s?.device?.id)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    )

    const knownDeviceIds = new Set<string>()
    const vehicleIdByDeviceId = new Map<string, string>()
    const currentTelemetryByDeviceId = new Map<
      string,
      { odometer: number | null; engine_hours: number | null }
    >()
    if (incomingDeviceIds.length) {
      // Chunk the IN list to avoid URL-length issues with huge fleets.
      for (const ids of chunk(incomingDeviceIds, 500)) {
        const { data, error } = await supabase
          .from('vehicles')
          .select('id, geotab_device_id, odometer, engine_hours')
          .in('geotab_device_id', ids)
        if (error) {
          console.error('vehicle lookup failed:', error)
          void reportError(supabase, {
            code: 'DB_WRITE_FAILED',
            message: `vehicle lookup failed: ${error.message}`,
            context: { stage: 'database', op: 'select', dbCode: error.code, table: 'vehicles' },
          })
          return new Response(
            JSON.stringify({
              error: 'Failed to load vehicles for device lookup',
              stage: 'database',
              code: error.code,
            }),
            {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              status: 500,
            },
          )
        }
        for (const row of data ?? []) {
          if (row.geotab_device_id) {
            knownDeviceIds.add(row.geotab_device_id)
            vehicleIdByDeviceId.set(row.geotab_device_id, row.id)
            currentTelemetryByDeviceId.set(row.geotab_device_id, {
              odometer: row.odometer ?? null,
              engine_hours: row.engine_hours ?? null,
            })
          }
        }
      }
    }
    console.log(
      `Matched ${knownDeviceIds.size}/${incomingDeviceIds.length} Geotab devices to vehicles.`,
    )

    // ----- 6. Shape per-vehicle position patches -----
    // We build a map keyed by vehicle.id (the upsert conflict target) so that
    // section 7 can merge in odometer/engine_hours from the StatusData call
    // before issuing a single batched upsert. Devices with no usable lat/lng
    // are skipped here entirely — telemetry-only rows are added back in §7.
    const errors: string[] = []
    let skipped = 0

    // Per-vehicle patch staged for the batched upsert. `id` is required by
    // onConflict: 'id'. Telemetry columns (odometer/engine_hours) are filled
    // in section 7 — initialized to undefined so we can detect "no inbound
    // telemetry" later and fall back to the current persisted value.
    type VehiclePatch = {
      id: string
      latitude?: number
      longitude?: number
      speed_kmh?: number | null
      speed_mph?: number | null
      bearing?: number | null
      is_device_communicating?: boolean | null
      is_driving?: boolean | null
      last_seen_at?: string
      location_updated_at?: string
      odometer?: number
      engine_hours?: number
    }
    const patchesByVehicleId = new Map<string, VehiclePatch>()

    const locationLogs: Array<{
      vehicle_id: string
      geotab_device_id: string
      latitude: number
      longitude: number
      speed_kmh: number | null
      bearing: number | null
      is_driving: boolean | null
      recorded_at: string
    }> = []

    const nowIso = new Date().toISOString()

    for (const s of statuses) {
      const deviceId = s?.device?.id
      if (!deviceId) {
        skipped++
        continue
      }
      if (!knownDeviceIds.has(deviceId)) {
        // Device exists in Geotab but not in our vehicles table — skip silently.
        skipped++
        continue
      }
      if (typeof s.latitude !== 'number' || typeof s.longitude !== 'number') {
        skipped++
        errors.push(`device ${deviceId}: missing lat/lon`)
        continue
      }
      if (!includeStale && s.isDeviceCommunicating === false) {
        skipped++
        continue
      }

      const vehicleId = vehicleIdByDeviceId.get(deviceId)
      if (!vehicleId) {
        // Defensive: knownDeviceIds said yes but the id map missed it. Skip
        // rather than risking an INSERT branch on the upsert.
        skipped++
        continue
      }

      const speedKmh = typeof s.speed === 'number' ? s.speed : null
      const bearing = typeof s.bearing === 'number' ? s.bearing : null
      const lastSeen = typeof s.dateTime === 'string' ? s.dateTime : nowIso

      patchesByVehicleId.set(vehicleId, {
        id: vehicleId,
        latitude: s.latitude,
        longitude: s.longitude,
        speed_kmh: speedKmh,
        speed_mph: kmhToMph(speedKmh ?? undefined),
        bearing,
        is_device_communicating: typeof s.isDeviceCommunicating === 'boolean'
          ? s.isDeviceCommunicating
          : null,
        is_driving: typeof s.isDriving === 'boolean' ? s.isDriving : null,
        last_seen_at: lastSeen,
        location_updated_at: nowIso,
      })

      locationLogs.push({
        vehicle_id: vehicleId,
        geotab_device_id: deviceId,
        latitude: s.latitude,
        longitude: s.longitude,
        speed_kmh: speedKmh,
        bearing,
        is_driving: typeof s.isDriving === 'boolean' ? s.isDriving : null,
        recorded_at: lastSeen,
      })
    }

    console.log(
      `Prepared ${patchesByVehicleId.size} vehicle position patches (skipped ${skipped}).`,
    )

    // ----- 7. Fetch odometer + engine hours via StatusData and merge -----
    // DeviceStatusInfo gives us positions but not diagnostic values. To keep
    // vehicles.odometer / engine_hours fresh we run two extra Get calls (one
    // per diagnostic) over the last few hours and pick the latest sample per
    // device. Failures here must NOT fail the whole sync — we still want the
    // position batch to land. Errors are logged + reported and we continue.
    let telemetryRowCount = 0
    try {
      const fromDate = new Date(Date.now() - STATUS_DATA_LOOKBACK_MS).toISOString()
      const toDate = new Date().toISOString()

      const buildParams = (diagnosticId: string) => ({
        typeName: 'StatusData',
        search: {
          diagnosticSearch: { id: diagnosticId },
          fromDate,
          toDate,
        },
        credentials,
      })

      console.log(
        `Fetching StatusData (odometer + engine hours) from ${fromDate} to ${toDate}...`,
      )
      const [odometerRows, engineHoursRows] = await Promise.all([
        geotabRpc<StatusDataRow[]>(host, 'Get', buildParams(DIAGNOSTIC_ODOMETER_ID)),
        geotabRpc<StatusDataRow[]>(host, 'Get', buildParams(DIAGNOSTIC_ENGINE_HOURS_ID)),
      ])
      const latestOdometerKm = latestByDevice(
        Array.isArray(odometerRows) ? odometerRows : [],
      )
      const latestEngineHoursSec = latestByDevice(
        Array.isArray(engineHoursRows) ? engineHoursRows : [],
      )
      console.log(
        `StatusData: ${latestOdometerKm.size} odometer / ` +
          `${latestEngineHoursSec.size} engine-hours device samples.`,
      )

      // Merge telemetry into the position patches. A device with telemetry
      // but no position update gets a new (telemetry-only) entry so the
      // batched upsert still picks it up. We only apply the inbound value
      // when STRICTLY GREATER than the current DB value — equal/lower is
      // either a stale sample (within the 7d window) or an out-of-band
      // correction we shouldn't clobber.
      const allDeviceIds = new Set<string>([
        ...latestOdometerKm.keys(),
        ...latestEngineHoursSec.keys(),
      ])
      for (const deviceId of allDeviceIds) {
        if (!knownDeviceIds.has(deviceId)) continue
        const vehicleId = vehicleIdByDeviceId.get(deviceId)
        if (!vehicleId) continue

        const current = currentTelemetryByDeviceId.get(deviceId)
        const km = latestOdometerKm.get(deviceId)
        const seconds = latestEngineHoursSec.get(deviceId)

        let nextOdometer: number | undefined
        let nextEngineHours: number | undefined
        if (typeof km === 'number') {
          const candidate = Math.round(km)
          if (current?.odometer == null || candidate > current.odometer) {
            nextOdometer = candidate
          }
        }
        if (typeof seconds === 'number') {
          const candidate = Math.round(seconds / 3600)
          if (current?.engine_hours == null || candidate > current.engine_hours) {
            nextEngineHours = candidate
          }
        }
        if (nextOdometer === undefined && nextEngineHours === undefined) {
          // No strictly-greater telemetry to write for this device.
          continue
        }

        const existing = patchesByVehicleId.get(vehicleId)
        if (existing) {
          if (nextOdometer !== undefined) existing.odometer = nextOdometer
          if (nextEngineHours !== undefined) existing.engine_hours = nextEngineHours
        } else {
          // Telemetry-only row (no fresh position this run). Still safe to
          // batch because we're upserting by `id` and the id exists.
          patchesByVehicleId.set(vehicleId, {
            id: vehicleId,
            ...(nextOdometer !== undefined ? { odometer: nextOdometer } : {}),
            ...(nextEngineHours !== undefined ? { engine_hours: nextEngineHours } : {}),
          })
        }
        telemetryRowCount++
      }
    } catch (e) {
      const msg = `StatusData fetch failed: ${(e as Error).message}`
      console.error(msg)
      errors.push(msg)
      void reportError(supabase, {
        code: 'UPSTREAM_502',
        severity: 'warn',
        message: msg,
        stack: (e as Error).stack ?? null,
        context: { stage: 'status_data' },
      })
    }

    // ----- 7b. Single batched upsert for all vehicle rows -----
    // Replaces the per-vehicle UPDATE loop: N vehicles now cost 1 round-trip
    // (per chunk) instead of N. Conflict target is the primary key `id`, so
    // upsert can never INSERT a new row (id is required and we only build
    // rows for ids we just SELECTed in §5). To keep the column list uniform
    // across all rows in the batch — mixed-key payloads can confuse PostgREST
    // and waste an INSERT column slot — we fill odometer/engine_hours with
    // the CURRENT persisted value on rows whose inbound telemetry was stale
    // (option (a) from the spec). The write is a no-op for those columns.
    let synced = 0
    if (patchesByVehicleId.size > 0) {
      // Build a vehicle_id -> current-telemetry map once so the row-shaping
      // loop below stays O(n) instead of O(n*m) on a per-vehicle reverse scan
      // of vehicleIdByDeviceId.
      const currentTelemetryByVehicleId = new Map<
        string,
        { odometer: number | null; engine_hours: number | null }
      >()
      for (const [deviceId, vehicleId] of vehicleIdByDeviceId) {
        const t = currentTelemetryByDeviceId.get(deviceId)
        if (t) currentTelemetryByVehicleId.set(vehicleId, t)
      }

      // SPLIT the batch by SHAPE: PostgREST treats a missing key on any row
      // in a heterogeneous batch as a NULL write. If we mixed telemetry-only
      // patches (no position columns) with position-bearing patches in one
      // batch, the telemetry-only rows would clobber latitude/longitude/etc
      // with NULL — destroying existing position data on any vehicle whose
      // position didn't refresh this run.
      //
      // The two batches differ only in which COLUMNS appear; both still
      // upsert by `id`. Within each batch every row has the same keys, so
      // PostgREST does the right thing.
      const positionRows: Array<Record<string, unknown>> = []
      const telemetryOnlyRows: Array<Record<string, unknown>> = []
      for (const patch of patchesByVehicleId.values()) {
        const current = currentTelemetryByVehicleId.get(patch.id)
        const hasPosition =
          typeof patch.latitude === 'number' && typeof patch.longitude === 'number'
        if (hasPosition) {
          positionRows.push({
            ...patch,
            // Uniform shape within the position batch — backfill stale
            // odometer/engine_hours to the current persisted value so this
            // batch's column list stays consistent across rows.
            odometer: patch.odometer ?? current?.odometer ?? null,
            engine_hours: patch.engine_hours ?? current?.engine_hours ?? null,
          })
        } else {
          // Telemetry-only patch: ONLY emit { id, odometer?, engine_hours? }.
          // Position columns are entirely absent from this batch, so PostgREST
          // leaves them untouched on the existing row.
          telemetryOnlyRows.push({
            id: patch.id,
            ...(patch.odometer !== undefined ? { odometer: patch.odometer } : {}),
            ...(patch.engine_hours !== undefined ? { engine_hours: patch.engine_hours } : {}),
          })
        }
      }
      const batchRows = [...positionRows, ...telemetryOnlyRows] // used only for error-reporting size/firstIds below

      try {
        // Chunk to respect PostgREST request-size limits on huge fleets.
        // Run the two shape-batches independently so their column sets stay
        // uniform; each chunked sub-batch shares its parent shape.
        const allBatches: Array<Array<Record<string, unknown>>> = []
        for (const sub of chunk(positionRows, UPSERT_CHUNK_SIZE)) allBatches.push(sub)
        for (const sub of chunk(telemetryOnlyRows, UPSERT_CHUNK_SIZE)) allBatches.push(sub)
        for (const batch of allBatches) {
          const { error } = await supabase
            .from('vehicles')
            .upsert(batch, { onConflict: 'id' })
          if (error) {
            const firstIds = batch.slice(0, 3).map((r) => r.id)
            console.error('vehicle batched upsert failed', {
              batchSize: batch.length,
              firstIds,
              error,
            })
            errors.push(
              `vehicle batched upsert failed (size ${batch.length}): ${error.message}`,
            )
            // Best-effort write to integration_alerts for admin triage. We
            // intentionally do not await — a logging failure must not mask
            // the real error path.
            void supabase
              .from('integration_alerts')
              .insert({
                kind: 'geotab_vehicles_batch_upsert_failed',
                message: `vehicle batched upsert failed: ${error.message}`,
                context: {
                  batchSize: batch.length,
                  firstIds,
                  dbCode: error.code ?? null,
                  hint: error.hint ?? null,
                },
              })
              .then(({ error: alertErr }) => {
                if (alertErr) {
                  console.error(
                    'integration_alerts insert failed (swallowed):',
                    alertErr.message,
                  )
                }
              })
            // Mirror the original behavior: also report via report_error so
            // existing dashboards keep firing.
            void reportError(supabase, {
              code: 'DB_WRITE_FAILED',
              message: `vehicle batched upsert failed: ${error.message}`,
              context: {
                stage: 'database',
                op: 'upsert',
                table: 'vehicles',
                batchSize: batch.length,
                firstIds,
                dbCode: error.code,
              },
            })
            continue
          }
          synced += batch.length
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        const firstIds = batchRows.slice(0, 3).map((r) => r.id)
        console.error('vehicle batched upsert threw', { error: message, firstIds })
        errors.push(`vehicle batched upsert threw: ${message}`)
        void supabase
          .from('integration_alerts')
          .insert({
            kind: 'geotab_vehicles_batch_upsert_failed',
            message: `vehicle batched upsert threw: ${message}`,
            context: { batchSize: batchRows.length, firstIds },
          })
          .then(({ error: alertErr }) => {
            if (alertErr) {
              console.error(
                'integration_alerts insert failed (swallowed):',
                alertErr.message,
              )
            }
          })
      }
    }
    // telemetrySynced retained in the response shape for backward compat with
    // existing dashboards. With the batched upsert we no longer track it as
    // a separate write count, so we report the number of vehicles that
    // received any strictly-greater telemetry merge.
    const telemetrySynced = telemetryRowCount

    // ----- 8. Append vehicle_locations log (best-effort; ignore if table absent) -----
    if (locationLogs.length) {
      for (const batch of chunk(locationLogs, UPSERT_CHUNK_SIZE)) {
        const { error } = await supabase.from('vehicle_locations').insert(batch)
        if (error) {
          // Table may not exist in some deployments — log once, do not fail the run.
          const msg = error.code === '42P01'
            ? 'vehicle_locations table missing; skipping history log'
            : `vehicle_locations insert failed for one batch: ${error.code ?? 'unknown'}`
          console.warn(msg, error)
          errors.push(msg)
          // If the table is genuinely missing, no point retrying remaining batches.
          if (error.code === '42P01') break
          continue
        }
      }
    }

    const result: SyncResult = {
      synced,
      telemetrySynced,
      skipped,
      matched: knownDeviceIds.size,
      unmatched: incomingDeviceIds.length - knownDeviceIds.size,
      errors,
      durationMs: Date.now() - startedAt,
    }

    console.log(`geotab-sync-locations done: ${JSON.stringify(result)}`)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    console.error('geotab-sync-locations fatal error:', message)
    // We may not have a `supabase` admin in scope here (this catch wraps the
    // entire body including secret-validation). Build a one-off using the
    // verified-bootstrap key if available.
    if (SUPABASE_URL && SERVICE_ROLE_KEY_FOR_AUTH) {
      const oneOff = createClient(SUPABASE_URL, SERVICE_ROLE_KEY_FOR_AUTH, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      void reportError(oneOff, {
        code: 'UPSTREAM_500',
        message,
        stack,
        context: { stage: 'fatal', durationMs: Date.now() - startedAt },
      })
    }
    return new Response(
      JSON.stringify({ error: message, stage: 'unknown', durationMs: Date.now() - startedAt }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      },
    )
  }
})
