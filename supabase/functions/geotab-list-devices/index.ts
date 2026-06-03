// Supabase Edge Function: geotab-list-devices
// Diagnostic-only. Lists every device in the connected Geotab fleet so we can
// map the user's real device IDs to YardwardPro vehicles. No DB writes.
//
// Invocation: supabase.functions.invoke('geotab-list-devices')
// Returns: { devices: Array<{ id, name, serialNumber, vehicleIdentificationNumber, licensePlate }>, count }

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const GEOTAB_AUTH_HOST = 'my.geotab.com'

// ---------------------------------------------------------------------------
// Auth (inlined — Edge Functions cannot share modules)
// Mirrors verifyAdminOrServiceRole used by sibling functions.
// ---------------------------------------------------------------------------
function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false
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
  if (!token) {
    return new Response(
      JSON.stringify({ error: 'Empty bearer token' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 },
    )
  }

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

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: profile, error: profileErr } = await adminClient
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

interface GeotabAuthOk {
  result: {
    path: string
    credentials: { userName: string; database: string; sessionId: string }
  }
}

interface GeotabDevice {
  id?: string
  name?: string
  serialNumber?: string
  vehicleIdentificationNumber?: string
  licensePlate?: string
  comment?: string
  deviceType?: string
  activeFrom?: string
  activeTo?: string
}

async function rpc<T>(host: string, method: string, params: unknown): Promise<T> {
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const res = await fetch(`https://${host}/apiv1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method, params }),
      signal: ctrl.signal,
    })
    const body = await res.json()
    if (body?.error) {
      const t = body.error?.data?.type ?? 'GeotabError'
      throw new Error(`Geotab ${method} failed (${t}): ${body.error?.message}`)
    }
    return body.result as T
  } finally {
    clearTimeout(timeout)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Auth gate — admin user JWT or service_role bearer required. This is a
    // diagnostic endpoint that exposes fleet device IDs, VINs, and serial
    // numbers, so it must NOT accept anonymous callers.
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({
          error:
            'Missing one of SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY for auth gate',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }
    const authFailure = await verifyAdminOrServiceRole(
      req,
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      SERVICE_ROLE_KEY,
    )
    if (authFailure) {
      console.warn('geotab-list-devices: auth rejected')
      return authFailure
    }

    const USER = Deno.env.get('GEOTAB_USERNAME')
    const PASS = Deno.env.get('GEOTAB_PASSWORD')
    const DB = Deno.env.get('GEOTAB_DATABASE')
    if (!USER || !PASS || !DB) {
      return new Response(
        JSON.stringify({ error: 'Missing GEOTAB_* secrets' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
      )
    }

    const auth = (await rpc<GeotabAuthOk['result']>(GEOTAB_AUTH_HOST, 'Authenticate', {
      database: DB,
      userName: USER,
      password: PASS,
    }))
    const host = !auth.path || auth.path === 'ThisServer' ? GEOTAB_AUTH_HOST : auth.path

    const devices = await rpc<GeotabDevice[]>(host, 'Get', {
      typeName: 'Device',
      credentials: auth.credentials,
    })

    // Trim each device down to the fields useful for mapping.
    const slim = devices.map((d) => ({
      id: d.id ?? null,
      name: d.name ?? null,
      serialNumber: d.serialNumber ?? null,
      vin: d.vehicleIdentificationNumber ?? null,
      licensePlate: d.licensePlate ?? null,
      deviceType: d.deviceType ?? null,
      comment: d.comment ?? null,
    }))

    return new Response(
      JSON.stringify({ devices: slim, count: slim.length }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
    )
  } catch (err) {
    console.error(err)
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 },
    )
  }
})
