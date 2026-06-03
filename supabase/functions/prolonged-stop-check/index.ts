// Supabase Edge Function: prolonged-stop-check
//
// Detects clocked-in drivers whose assigned vehicle has been parked
// (speed_kmh < 3) continuously for longer than
// app_settings.prolonged_stop_minutes at a location that is NOT one of their
// active/scheduled-today job sites. When found, inserts an 'alert' notification
// for every admin user. Dedup window is 1 hour: if an unresolved alert for the
// same driver at a nearby centroid (< 100m) already exists, we skip.
//
// Invocation:
//   - Cron (every 10 min, scheduled in migration 20260602074451)
//   - On-demand: supabase.functions.invoke('prolonged-stop-check')
//
// Returns: { checked: number, alerted: number, durationMs: number }

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Distance in meters at which we still consider the parked centroid to be
// "on" an active job site (i.e. it's an EXPECTED stop, not an alert).
const JOB_SITE_RADIUS_M = 500

// Minimum number of consecutive parked telemetry points required to count as a
// real stop. Guards against a single noisy 0-km/h sample between two driving
// points landing as a fake "stop" with a misleading centroid.
const MIN_PARKED_SAMPLES = 5

// Distance in meters at which two centroids are considered the "same place"
// for dedup purposes — picks up the same idle truck on successive 10-min runs.
const DEDUP_RADIUS_M = 100

// Below this speed in km/h we treat the vehicle as effectively parked.
const PARKED_SPEED_KMH = 3

// Lookback for time_entries selection.
const CLOCKED_IN_LOOKBACK_HOURS = 24

// Dedup window — repeat alerts for the same driver+centroid suppressed inside this.
const DEDUP_WINDOW_MS = 60 * 60 * 1000 // 1 hour

/**
 * Verify the caller is allowed to invoke this function.
 * Returns null on success, or a Response (401) to be returned to the caller.
 * Inlined per the geotab-sync-locations pattern — Edge Functions are isolated
 * so we cannot share a module between them.
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

  // Service-role bypass for cron / server-to-server.
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

/**
 * Fire-and-forget error reporter — same pattern as geotab-sync-locations.
 * Swallows its own failures so reporting can never mask the original error.
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
      p_function_name: 'prolonged-stop-check',
      p_context: opts.context ?? {},
    })
  } catch (e) {
    console.error(
      '[prolonged-stop-check] reportError failed (swallowed):',
      e instanceof Error ? e.message : String(e),
    )
  }
}

/**
 * Haversine great-circle distance between two lat/lng pairs, in meters.
 * Sufficient precision for the 100m/500m thresholds we care about.
 */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6_371_000 // mean Earth radius in meters
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

interface LocationRow {
  latitude: number
  longitude: number
  speed_kmh: number | null
  recorded_at: string
}

interface JobSiteRow {
  id: string
  status: string
  scheduled_at: string
  location_lat: number | null
  location_lng: number | null
}

interface StopEvent {
  centroidLat: number
  centroidLng: number
  durationMin: number
  startedAt: string
  endedAt: string
  pointCount: number
}

/**
 * Walk a time-ordered list of locations (ascending recorded_at) and return
 * EVERY continuous run where every point has speed_kmh < PARKED_SPEED whose
 * duration meets the threshold. The caller then filters runs against active
 * job-site centroids — if we only returned the longest run, a 60-min stop
 * at an expected job site would silently mask a 50-min unexpected stop in
 * the same window.
 */
function findAllParkedRuns(
  locations: LocationRow[],
  thresholdMin: number,
): StopEvent[] {
  if (locations.length === 0) return []

  const out: StopEvent[] = []
  let runStart = -1
  let sumLat = 0
  let sumLng = 0

  const flush = (endIdx: number) => {
    if (runStart < 0) return
    const startRow = locations[runStart]
    const endRow = locations[endIdx]
    const points = endIdx - runStart + 1
    const durationMin =
      (new Date(endRow.recorded_at).getTime() - new Date(startRow.recorded_at).getTime()) / 60000
    // Require >= MIN_PARKED_SAMPLES so a single noisy 0-km/h point sandwiched
    // between two driving points can't anchor a brief "stop" with a misleading
    // centroid.
    if (durationMin >= thresholdMin && points >= MIN_PARKED_SAMPLES) {
      out.push({
        centroidLat: sumLat / points,
        centroidLng: sumLng / points,
        durationMin: Math.round(durationMin),
        startedAt: startRow.recorded_at,
        endedAt: endRow.recorded_at,
        pointCount: points,
      })
    }
  }

  for (let i = 0; i < locations.length; i++) {
    const row = locations[i]
    const speed = typeof row.speed_kmh === 'number' ? row.speed_kmh : null

    // Treat NULL speed as "unknown" — break the run rather than assuming parked,
    // otherwise a vehicle with patchy telemetry would constantly false-alert.
    const isParked = speed !== null && speed < PARKED_SPEED_KMH

    if (isParked) {
      if (runStart < 0) {
        runStart = i
        sumLat = row.latitude
        sumLng = row.longitude
      } else {
        sumLat += row.latitude
        sumLng += row.longitude
      }
    } else {
      if (runStart >= 0) flush(i - 1)
      runStart = -1
      sumLat = 0
      sumLng = 0
    }
  }
  if (runStart >= 0) flush(locations.length - 1)

  return out
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ----- 0. Bootstrap secrets + caller auth -----
  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    const msg = `Missing required environment variables: ${
      [
        !SUPABASE_URL && 'SUPABASE_URL',
        !SUPABASE_ANON_KEY && 'SUPABASE_ANON_KEY',
        !SUPABASE_SERVICE_ROLE_KEY && 'SUPABASE_SERVICE_ROLE_KEY',
      ]
        .filter(Boolean)
        .join(', ')
    }`
    console.error(msg)
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const oneOff = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
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
    SUPABASE_SERVICE_ROLE_KEY,
  )
  if (authFailure) return authFailure

  const startedAt = Date.now()
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let checked = 0
  let alerted = 0

  try {
    // ----- 1. Read prolonged_stop_minutes from app_settings -----
    const { data: settings, error: settingsErr } = await supabase
      .from('app_settings')
      .select('prolonged_stop_minutes')
      .eq('id', 'default')
      .maybeSingle()
    if (settingsErr) {
      void reportError(supabase, {
        code: 'DB_READ_FAILED',
        message: `app_settings read failed: ${settingsErr.message}`,
        context: { stage: 'settings', dbCode: settingsErr.code },
      })
      return new Response(
        JSON.stringify({ error: 'Failed to read app_settings', stage: 'settings' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }
    const thresholdMin: number =
      settings?.prolonged_stop_minutes && Number.isFinite(settings.prolonged_stop_minutes)
        ? Number(settings.prolonged_stop_minutes)
        : 45 // matches the DEFAULT in the migration

    // ----- 2. Pull clocked-in drivers from the last 24 hours -----
    const sinceClockIn = new Date(
      Date.now() - CLOCKED_IN_LOOKBACK_HOURS * 3600 * 1000,
    ).toISOString()
    const { data: openShifts, error: shiftsErr } = await supabase
      .from('time_entries')
      .select('id, driver_id, clock_in')
      .is('clock_out', null)
      .gt('clock_in', sinceClockIn)
    if (shiftsErr) {
      void reportError(supabase, {
        code: 'DB_READ_FAILED',
        message: `time_entries read failed: ${shiftsErr.message}`,
        context: { stage: 'shifts', dbCode: shiftsErr.code },
      })
      return new Response(
        JSON.stringify({ error: 'Failed to read open shifts', stage: 'shifts' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }
    const openDriverIds = Array.from(
      new Set((openShifts ?? []).map((r) => r.driver_id).filter((v): v is string => !!v)),
    )

    if (openDriverIds.length === 0) {
      const result = { checked: 0, alerted: 0, durationMs: Date.now() - startedAt }
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // ----- 3. Look up driver -> vehicle_assignment_id + display name -----
    // drivers.vehicle_assignment_id is text (the vehicles.id PK), per schema.
    const { data: driverRows, error: driversErr } = await supabase
      .from('drivers')
      .select('id, vehicle_assignment_id, profiles!inner(name)')
      .in('id', openDriverIds)
    if (driversErr) {
      void reportError(supabase, {
        code: 'DB_READ_FAILED',
        message: `drivers read failed: ${driversErr.message}`,
        context: { stage: 'drivers', dbCode: driversErr.code },
      })
      return new Response(
        JSON.stringify({ error: 'Failed to read drivers', stage: 'drivers' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }

    // Build a fast driver-id -> { vehicleId, name } map. PostgREST returns the
    // nested profiles join as either a single object or an array depending on
    // the relationship inference — handle both.
    const driverMeta = new Map<string, { vehicleId: string | null; name: string }>()
    for (const d of driverRows ?? []) {
      const prof = (d as { profiles?: { name?: string } | { name?: string }[] }).profiles
      const name = Array.isArray(prof) ? prof[0]?.name ?? '' : prof?.name ?? ''
      driverMeta.set(d.id as string, {
        vehicleId: (d.vehicle_assignment_id ?? null) as string | null,
        name: name || 'Driver',
      })
    }

    // ----- 4. Resolve active admins (recipients) once -----
    const { data: adminRows, error: adminsErr } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'admin')
      .eq('status', 'active')
    if (adminsErr) {
      void reportError(supabase, {
        code: 'DB_READ_FAILED',
        message: `admin lookup failed: ${adminsErr.message}`,
        context: { stage: 'admins', dbCode: adminsErr.code },
      })
      return new Response(
        JSON.stringify({ error: 'Failed to read admins', stage: 'admins' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }
    const adminIds = (adminRows ?? []).map((r) => r.id as string).filter(Boolean)
    if (adminIds.length === 0) {
      // No admins to notify — still process, but log so the operator notices.
      console.warn('[prolonged-stop-check] no active admins found; alerts will be skipped')
    }

    // ----- 5. Pre-pull dedup window of existing prolonged-stop alerts -----
    // We only want to dedup on this function's own alerts, not unrelated admin
    // notifications, so we filter by the marker prefix used in the body.
    const dedupSince = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString()
    const { data: recentAlerts, error: recentErr } = await supabase
      .from('notifications')
      .select('id, body, created_at')
      .eq('type', 'alert')
      .gt('created_at', dedupSince)
      .like('body', '[prolonged-stop]%')
      .is('read_at', null)
    if (recentErr) {
      // Non-fatal: dedup is best-effort. Log and continue without dedup.
      console.warn('[prolonged-stop-check] dedup lookup failed:', recentErr.message)
    }
    // Parse the embedded JSON tail we write into each alert body so we can
    // recover { driverId, lat, lng } without an extra column.
    interface DedupKey {
      driverId: string
      lat: number
      lng: number
    }
    const recentKeys: DedupKey[] = []
    for (const row of recentAlerts ?? []) {
      const m = (row.body as string).match(/\[meta\]({.*})$/)
      if (!m) continue
      try {
        const meta = JSON.parse(m[1]) as Partial<DedupKey>
        if (
          typeof meta.driverId === 'string' &&
          typeof meta.lat === 'number' &&
          typeof meta.lng === 'number'
        ) {
          recentKeys.push({ driverId: meta.driverId, lat: meta.lat, lng: meta.lng })
        }
      } catch {
        // ignore malformed meta — they just won't contribute to dedup
      }
    }

    // ----- 6. Per-driver: locations -> stop event -> job-site check -----
    // Lookback window = threshold + 30 min buffer so a stop that started
    // just before the strict threshold window still has its full duration
    // measurable. Without the buffer, a 50-min run that started 10 min
    // before the window edge would be truncated to 40 min and miss the
    // threshold despite being a real prolonged stop.
    const sinceLocations = new Date(
      Date.now() - (thresholdMin + 30) * 60 * 1000,
    ).toISOString()

    // Active job window for "scheduled today" check (driver's local-day approximated by UTC).
    const dayStart = new Date()
    dayStart.setUTCHours(0, 0, 0, 0)
    const dayEnd = new Date(dayStart)
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

    const notificationsToInsert: Array<{
      id: string
      user_id: string
      type: 'alert'
      body: string
      link: string | null
    }> = []

    for (const driverId of openDriverIds) {
      checked++
      const meta = driverMeta.get(driverId)
      const vehicleId = meta?.vehicleId ?? null
      const driverName = meta?.name ?? 'Driver'
      if (!vehicleId) {
        // No vehicle assigned — can't evaluate stop. Skip silently.
        continue
      }

      // 6a. Pull location history for this vehicle within the lookback window.
      const { data: locs, error: locErr } = await supabase
        .from('vehicle_locations')
        .select('latitude, longitude, speed_kmh, recorded_at')
        .eq('vehicle_id', vehicleId)
        .gt('recorded_at', sinceLocations)
        .order('recorded_at', { ascending: true })
      if (locErr) {
        console.warn(
          `[prolonged-stop-check] vehicle_locations read failed for vehicle ${vehicleId}:`,
          locErr.message,
        )
        continue
      }
      const locations = (locs ?? []) as LocationRow[]
      if (locations.length < 2) continue

      // 6b. Find ALL qualifying parked runs (not just the longest). An
      // expected long stop at the job site must not mask a shorter
      // unexpected stop elsewhere in the same window.
      const stops = findAllParkedRuns(locations, thresholdMin)
      if (stops.length === 0) continue

      // 6c. Pull this driver's active or scheduled-today job sites once for the proximity test.
      const { data: jobRows, error: jobsErr } = await supabase
        .from('jobs')
        .select('id, status, scheduled_at, location_lat, location_lng')
        .eq('driver_id', driverId)
        .or(
          `status.eq.active,and(scheduled_at.gte.${dayStart.toISOString()},scheduled_at.lt.${dayEnd.toISOString()})`,
        )
      if (jobsErr) {
        console.warn(
          `[prolonged-stop-check] jobs read failed for driver ${driverId}:`,
          jobsErr.message,
        )
        continue
      }
      const candidateJobs = ((jobRows ?? []) as JobSiteRow[]).filter(
        (j) => typeof j.location_lat === 'number' && typeof j.location_lng === 'number',
      )

      for (const stop of stops) {
        // 6d. If centroid is within JOB_SITE_RADIUS_M of any candidate, it's expected.
        const expected = candidateJobs.some(
          (j) =>
            haversineMeters(
              stop.centroidLat,
              stop.centroidLng,
              j.location_lat as number,
              j.location_lng as number,
            ) <= JOB_SITE_RADIUS_M,
        )
        if (expected) continue

        // 6e. Dedup against recent unresolved alerts at a similar centroid.
        const dup = recentKeys.some(
          (k) =>
            k.driverId === driverId &&
            haversineMeters(stop.centroidLat, stop.centroidLng, k.lat, k.lng) <= DEDUP_RADIUS_M,
        )
        if (dup) continue

        // 6f. Compose admin notification rows. Include a [meta] JSON tail so
        // the next run can dedup against this one without a schema change.
        const latStr = stop.centroidLat.toFixed(5)
        const lngStr = stop.centroidLng.toFixed(5)
        const meta_payload = JSON.stringify({
          driverId,
          lat: Number(latStr),
          lng: Number(lngStr),
        })
        const body =
          `[prolonged-stop] ${driverName} has been parked at ${latStr},${lngStr} ` +
          `for ${stop.durationMin} min — no active job site nearby. [meta]${meta_payload}`

        for (const adminId of adminIds) {
          notificationsToInsert.push({
            id: crypto.randomUUID(),
            user_id: adminId,
            type: 'alert',
            body,
            link: `/admin/drivers/${driverId}`,
          })
        }

        // Optimistically push this stop into recentKeys so a second driver
        // with the SAME centroid doesn't create a duplicate alert in this run.
        recentKeys.push({ driverId, lat: Number(latStr), lng: Number(lngStr) })
        alerted++
      }
    }

    // ----- 7. Insert all notifications in one batch -----
    if (notificationsToInsert.length) {
      const { error: insertErr } = await supabase
        .from('notifications')
        .insert(notificationsToInsert)
      if (insertErr) {
        void reportError(supabase, {
          code: 'DB_WRITE_FAILED',
          message: `notifications insert failed: ${insertErr.message}`,
          context: {
            stage: 'notify',
            dbCode: insertErr.code,
            attempted: notificationsToInsert.length,
          },
        })
        // We've already counted `alerted` — surface the partial failure but
        // still return 200 so the cron job retries on its next tick.
        console.error(
          '[prolonged-stop-check] failed to insert alerts:',
          insertErr.message,
        )
      }
    }

    const result = {
      checked,
      alerted,
      durationMs: Date.now() - startedAt,
    }
    console.log(`prolonged-stop-check done: ${JSON.stringify(result)}`)

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack ?? null : null
    console.error('prolonged-stop-check fatal error:', message)
    void reportError(supabase, {
      code: 'UPSTREAM_500',
      message,
      stack,
      context: { stage: 'fatal', durationMs: Date.now() - startedAt, checked, alerted },
    })
    return new Response(
      JSON.stringify({ error: message, stage: 'unknown', durationMs: Date.now() - startedAt }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    )
  }
})
