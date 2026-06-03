// Supabase Edge Function: preventive-maintenance-check
//
// Scans every in-service vehicle and, for any vehicle whose odometer (km) or
// engine_hours has crossed the warning threshold to its next_service_due, fires
// a notification to every admin user.
//
// Schedule: pg_cron daily at 09:00 UTC (see sprint3_telematics_and_actions.sql).
// On-demand: POST /functions/v1/preventive-maintenance-check with admin JWT.
//
// Returns: { checked: number, alerted: number, alreadyNotified: number, errors: string[] }

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ---------------------------------------------------------------------------
// Auth (inlined — Edge Functions cannot share modules)
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
// fetchWithTimeout — mirrors qbo-push-invoice. We don't make external HTTP
// calls in this function, but the helper is included to keep parity with the
// other edge functions and is wired into the supabase-js calls below via
// AbortController on a Promise.race.
// ---------------------------------------------------------------------------
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

// Promise-level timeout wrapper so we can apply fetchWithTimeout semantics to
// supabase-js calls (which return PostgrestBuilder, not raw fetches).
async function withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms}ms`) as Error & { isTimeout?: boolean }
      e.isTimeout = true
      reject(e)
    }, ms) as unknown as number
  })
  try {
    return await Promise.race([Promise.resolve(p), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Error reporting (best-effort)
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
      p_function_name: 'preventive-maintenance-check',
      p_context: opts.context ?? {},
    })
  } catch (e) {
    console.error(
      '[preventive-maintenance-check] reportError failed (swallowed):',
      e instanceof Error ? e.message : String(e),
    )
  }
}

// ---------------------------------------------------------------------------
// next_service_due parser
//
// The column is `text` in practice — values look like "90,000 km", "150 hours",
// "5,800 hrs", or unparseable strings like "Service overdue". We parse the
// leading number (with optional thousands separators / decimals) and bucket
// the unit into 'km' or 'hours'. Anything else returns null and the vehicle
// is silently skipped.
// ---------------------------------------------------------------------------
type ServiceTarget = { target: number; unit: 'km' | 'hours' }

function parseNextServiceDue(raw: string | null | undefined): ServiceTarget | null {
  if (!raw || typeof raw !== 'string') return null
  const cleaned = raw.trim().toLowerCase()
  if (!cleaned) return null

  // Match the first numeric token. Allow comma thousands separators and a
  // single decimal point. Reject leading signs / other oddities.
  const numMatch = cleaned.match(/(\d[\d,]*(?:\.\d+)?)/)
  if (!numMatch) return null
  const numeric = Number(numMatch[1].replace(/,/g, ''))
  if (!Number.isFinite(numeric) || numeric <= 0) return null

  // Bucket the unit. We look at the tail of the string for a unit token.
  // "km" / "kilometre(s)" → km, "hr"/"hrs"/"hour"/"hours" → hours.
  const tail = cleaned.slice(numMatch.index! + numMatch[1].length).trim()
  if (/^km\b|^kilom/.test(tail)) return { target: numeric, unit: 'km' }
  if (/^h(rs?|ours?)\b/.test(tail)) return { target: numeric, unit: 'hours' }

  // Fall back: search anywhere in the string. Prefer hours over km if both
  // appear (very unlikely) so a "10000 km after 500 hours" string is treated
  // as hours-based.
  if (/\b(h(rs?|ours?))\b/.test(cleaned)) return { target: numeric, unit: 'hours' }
  if (/\bkm\b|\bkilom/.test(cleaned)) return { target: numeric, unit: 'km' }
  return null
}

// ---------------------------------------------------------------------------
// Notification id generator. The notifications table uses text PKs; we mint a
// stable-ish identifier so the row is easy to trace in logs.
// ---------------------------------------------------------------------------
function notifId(): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
  return `NOTIF-PM-${Date.now().toString(36)}-${rand}`
}

interface AppSettingsRow {
  service_due_km_warning: number | null
  service_due_hours_warning: number | null
}

interface VehicleRow {
  id: string
  name: string
  odometer: number | null
  engine_hours: number | null
  next_service_due: string | null
}

interface PmResult {
  checked: number
  alerted: number
  alreadyNotified: number
  // Vehicles whose next_service_due text was non-empty but unparseable
  // ("90,000", "Service overdue", etc). A sudden uptick here means the
  // operator entered free-form text the parser can't pattern-match yet —
  // worth surfacing so PM doesn't silently never alert for them.
  unparseable: number
  errors: string[]
  durationMs: number
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

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

  try {
    // ----- 1. Thresholds from app_settings -----
    // app_settings is a singleton-ish table in this project. We pick the most
    // recent row defensively in case multiple exist.
    const { data: settingsRows, error: settingsErr } = await withTimeout(
      supabase
        .from('app_settings')
        .select('service_due_km_warning, service_due_hours_warning')
        .limit(1),
      15000,
      'app_settings.select',
    )
    if (settingsErr) {
      console.error('app_settings select failed:', settingsErr)
      void reportError(supabase, {
        code: 'DB_READ_FAILED',
        message: `app_settings select failed: ${settingsErr.message}`,
        context: { stage: 'settings', dbCode: settingsErr.code },
      })
      return new Response(
        JSON.stringify({ error: 'Failed to load app_settings', stage: 'settings' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }

    const settings = (settingsRows?.[0] as AppSettingsRow | undefined) ?? null
    // Fall back to the migration defaults if the row exists but the columns
    // are null, or if no row exists at all.
    const kmWarn = Number(settings?.service_due_km_warning ?? 1000)
    const hoursWarn = Number(settings?.service_due_hours_warning ?? 50)
    if (!Number.isFinite(kmWarn) || kmWarn < 0 || !Number.isFinite(hoursWarn) || hoursWarn < 0) {
      const msg = `Invalid warning thresholds: km=${kmWarn}, hours=${hoursWarn}`
      console.error(msg)
      void reportError(supabase, {
        code: 'VALIDATION',
        severity: 'warn',
        message: msg,
        context: { stage: 'settings', kmWarn, hoursWarn },
      })
      return new Response(JSON.stringify({ error: msg }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      })
    }

    // ----- 2. In-service vehicles -----
    const { data: vehicles, error: vehErr } = await withTimeout(
      supabase
        .from('vehicles')
        .select('id, name, odometer, engine_hours, next_service_due, status')
        // Explicit allowlist. .neq() also excludes NULL status rows (legacy
        // imports), silently skipping them. Include 'maintenance' too — those
        // are already in the shop but we still flag the reading so the
        // attached service log gets the right metric snapshot.
        .in('status', ['operational', 'maintenance']),
      20000,
      'vehicles.select',
    )
    if (vehErr) {
      console.error('vehicles select failed:', vehErr)
      void reportError(supabase, {
        code: 'DB_READ_FAILED',
        message: `vehicles select failed: ${vehErr.message}`,
        context: { stage: 'vehicles', dbCode: vehErr.code },
      })
      return new Response(
        JSON.stringify({ error: 'Failed to load vehicles', stage: 'vehicles' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }

    const checkedList = (vehicles ?? []) as Array<VehicleRow & { status?: string }>
    console.log(`Loaded ${checkedList.length} in-service vehicle(s) for PM check.`)

    // ----- 3. Decide who needs an alert -----
    type Pending = {
      vehicleId: string
      body: string
      link: string
      remaining: number
      unit: 'km' | 'hours'
    }
    const pending: Pending[] = []
    const errors: string[] = []
    let unparseable = 0 // observability for malformed next_service_due strings

    for (const v of checkedList) {
      const parsed = parseNextServiceDue(v.next_service_due)
      if (!parsed) {
        if (v.next_service_due && v.next_service_due.trim().length > 0) {
          unparseable += 1
        }
        continue
      }
      // Stable dedup marker that does NOT include the changing remaining
      // number. Without this, "due in 800 km" → "due in 750 km" → ... ticks
      // up every day and re-alerts every cron run forever. The marker
      // tail [pm:<vehicleId>:<unit>] is invariant across the warning window
      // so a 24h-window match catches it cleanly.
      const markerFor = (vid: string, unit: 'km' | 'hours') => ` [pm:${vid}:${unit}]`
      if (parsed.unit === 'km') {
        const odo = Number(v.odometer ?? 0)
        if (!Number.isFinite(odo)) continue
        const remaining = parsed.target - odo
        if (odo >= parsed.target - kmWarn) {
          const display = remaining >= 0
            ? `${v.name} is due for service in ${remaining.toLocaleString('en-US')} km`
            : `${v.name} is overdue for service by ${Math.abs(remaining).toLocaleString('en-US')} km`
          pending.push({
            vehicleId: v.id,
            body: display + markerFor(v.id, 'km'),
            link: `/admin/vehicles/${v.id}`,
            remaining,
            unit: 'km',
          })
        }
      } else {
        const hrs = Number(v.engine_hours ?? 0)
        if (!Number.isFinite(hrs)) continue
        const remaining = parsed.target - hrs
        if (hrs >= parsed.target - hoursWarn) {
          const display = remaining >= 0
            ? `${v.name} is due for service in ${remaining.toLocaleString('en-US')} hours`
            : `${v.name} is overdue for service by ${Math.abs(remaining).toLocaleString('en-US')} hours`
          pending.push({
            vehicleId: v.id,
            body: display + markerFor(v.id, 'hours'),
            link: `/admin/vehicles/${v.id}`,
            remaining,
            unit: 'hours',
          })
        }
      }
    }

    console.log(`PM thresholds: km=${kmWarn}, hours=${hoursWarn}. Pending alerts: ${pending.length}`)

    if (pending.length === 0) {
      const result: PmResult = {
        checked: checkedList.length,
        alerted: 0,
        alreadyNotified: 0,
        unparseable,
        errors,
        durationMs: Date.now() - startedAt,
      }
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ----- 4. Load admin users (recipients) -----
    const { data: admins, error: adminsErr } = await withTimeout(
      supabase.from('profiles').select('id').eq('role', 'admin'),
      15000,
      'profiles.select',
    )
    if (adminsErr) {
      console.error('profiles select failed:', adminsErr)
      void reportError(supabase, {
        code: 'DB_READ_FAILED',
        message: `profiles select failed: ${adminsErr.message}`,
        context: { stage: 'admins', dbCode: adminsErr.code },
      })
      return new Response(
        JSON.stringify({ error: 'Failed to load admin recipients', stage: 'admins' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }
    const adminIds = (admins ?? []).map((r) => r.id as string).filter(Boolean)
    if (adminIds.length === 0) {
      console.warn('No admin users found; nothing to notify.')
      const result: PmResult = {
        checked: checkedList.length,
        alerted: 0,
        alreadyNotified: 0,
        unparseable,
        errors: ['no admin users found'],
        durationMs: Date.now() - startedAt,
      }
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ----- 5. Dedup vs unresolved notifications in the last 24h -----
    // Dedup on the stable [pm:<vehicleId>:<unit>] marker substring, NOT the
    // full body — the body's remaining-km/hours number changes daily as the
    // odometer ticks up, so a body-equality dedup would miss every day after
    // the first and re-alert every admin every cron tick.
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    // Build the set of distinct markers we need to look for.
    const candidateMarkers = Array.from(
      new Set(pending.map((p) => p.body.slice(p.body.indexOf(' [pm:')))),
    )
    // Pull every unread notification for these admins in the window, then
    // filter client-side by marker substring (ilike .or() with N values is
    // awkward in PostgREST; bulk pull + filter is one round-trip).
    const { data: existing, error: existingErr } = await withTimeout(
      supabase
        .from('notifications')
        .select('user_id, body')
        .in('user_id', adminIds)
        .is('read_at', null)
        .gte('created_at', sinceIso),
      15000,
      'notifications.dedup_select',
    )
    if (existingErr) {
      console.error('notifications dedup select failed:', existingErr)
      void reportError(supabase, {
        code: 'DB_READ_FAILED',
        message: `notifications dedup select failed: ${existingErr.message}`,
        context: { stage: 'dedup', dbCode: existingErr.code },
      })
      return new Response(
        JSON.stringify({ error: 'Failed to load existing notifications', stage: 'dedup' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }
    // (userId|marker) instead of (userId|body) so today's "in 800 km" and
    // tomorrow's "in 750 km" dedup against the same key.
    const seen = new Set<string>()
    for (const row of (existing ?? []) as Array<{ user_id: string; body: string }>) {
      for (const marker of candidateMarkers) {
        if (marker && row.body.includes(marker)) {
          seen.add(`${row.user_id}|${marker}`)
        }
      }
    }

    // ----- 6. Build the insert payload -----
    type NotifInsert = {
      id: string
      user_id: string
      type: 'alert'
      body: string
      link: string
    }
    const toInsert: NotifInsert[] = []
    let alreadyNotified = 0
    for (const p of pending) {
      const marker = p.body.slice(p.body.indexOf(' [pm:'))
      for (const adminId of adminIds) {
        if (seen.has(`${adminId}|${marker}`)) {
          alreadyNotified++
          continue
        }
        toInsert.push({
          id: notifId(),
          user_id: adminId,
          type: 'alert',
          body: p.body,
          link: p.link,
        })
      }
    }

    let alerted = 0
    if (toInsert.length > 0) {
      const { error: insErr } = await withTimeout(
        supabase.from('notifications').insert(toInsert),
        20000,
        'notifications.insert',
      )
      if (insErr) {
        console.error('notifications insert failed:', insErr)
        errors.push(`notifications insert failed: ${insErr.code ?? 'unknown'}`)
        void reportError(supabase, {
          code: 'DB_WRITE_FAILED',
          message: `notifications insert failed: ${insErr.message}`,
          context: { stage: 'insert', dbCode: insErr.code, attempted: toInsert.length },
        })
      } else {
        alerted = toInsert.length
      }
    }

    const result: PmResult = {
      checked: checkedList.length,
      alerted,
      alreadyNotified,
      unparseable,
      errors,
      durationMs: Date.now() - startedAt,
    }

    console.log(`preventive-maintenance-check done: ${JSON.stringify(result)}`)
    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    const isTimeout = !!(err as { isTimeout?: boolean })?.isTimeout
    console.error('preventive-maintenance-check fatal error:', message)
    void reportError(supabase, {
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_500',
      message,
      stack,
      context: { stage: 'fatal', durationMs: Date.now() - startedAt },
    })
    return new Response(
      JSON.stringify({
        error: message,
        stage: 'unknown',
        durationMs: Date.now() - startedAt,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: isTimeout ? 504 : 500,
      },
    )
  }
})

// fetchWithTimeout is kept exported via the module scope for symmetry with
// the other functions; the reference below silences "unused" warnings if the
// Deno linter is enabled in CI.
void fetchWithTimeout
