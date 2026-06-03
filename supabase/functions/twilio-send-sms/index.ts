// Supabase Edge Function: twilio-send-sms
// Sends an SMS via Twilio Messages API and logs it to the sms_logs table.
//
// Invocation body: { to: string, body: string, driverId?: string, jobId?: string }
// Returns:         { smsId, twilioMessageId, deliveryStatus }
//
// Replaces the mock at src/lib/api.ts -> api.sendSms

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface SendSmsRequest {
  to?: string
  body?: string
  driverId?: string
  jobId?: string
}

// ---------------------------------------------------------------------------
// Auth (inlined — Edge Functions cannot share modules)
// Mirrors verifyAdminOrServiceRole used by sibling functions
// (preventive-maintenance-check, qbo-push-time). Returns a 401 Response on
// failure, or null when the caller is admin or carrying the service_role key.
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

interface TwilioMessageResponse {
  sid?: string
  status?: string
  to?: string
  from?: string
  body?: string
  date_created?: string
  account_sid?: string
  messaging_service_sid?: string | null
  num_segments?: string
  price?: string | null
  price_unit?: string | null
  uri?: string
  error_code?: number | null
  error_message?: string | null
  // Twilio error envelope:
  code?: number
  message?: string
  more_info?: string
}

// Basic E.164 sanity check: leading + then 8-15 digits.
const E164_RE = /^\+[1-9]\d{7,14}$/

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  })
}

serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405)
  }

  try {
    // 1. Validate secrets up front. Fail loudly if any are missing.
    const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')
    const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')
    const TWILIO_FROM_NUMBER = Deno.env.get('TWILIO_FROM_NUMBER')
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    const missing: string[] = []
    if (!TWILIO_ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID')
    if (!TWILIO_AUTH_TOKEN) missing.push('TWILIO_AUTH_TOKEN')
    if (!TWILIO_FROM_NUMBER) missing.push('TWILIO_FROM_NUMBER')
    if (!SUPABASE_URL) missing.push('SUPABASE_URL')
    if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY')
    if (missing.length > 0) {
      console.error('twilio-send-sms: missing required env vars:', missing.join(', '))
      return jsonResponse(
        { error: `Server misconfigured: missing env vars: ${missing.join(', ')}` },
        500,
      )
    }

    // 1b. Auth gate — admin user JWT or service_role bearer required.
    // SMS dispatch costs money and triggers carrier-level traffic, so we MUST
    // reject anonymous callers even though CORS lets anyone preflight us.
    const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
    if (!SUPABASE_ANON_KEY) {
      console.error('twilio-send-sms: missing SUPABASE_ANON_KEY for auth gate')
      return jsonResponse(
        { error: 'Server misconfigured: missing env vars: SUPABASE_ANON_KEY' },
        500,
      )
    }
    const authFailure = await verifyAdminOrServiceRole(
      req,
      SUPABASE_URL!,
      SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY!,
    )
    if (authFailure) {
      console.warn('twilio-send-sms: auth rejected')
      return authFailure
    }

    // 2. Parse and validate the request body.
    let payload: SendSmsRequest
    try {
      payload = (await req.json()) as SendSmsRequest
    } catch (_err) {
      return jsonResponse({ error: 'Invalid JSON body.' }, 400)
    }

    const to = typeof payload.to === 'string' ? payload.to.trim() : ''
    const messageBody = typeof payload.body === 'string' ? payload.body : ''
    const driverId =
      typeof payload.driverId === 'string' && payload.driverId.length > 0
        ? payload.driverId
        : null
    const jobId =
      typeof payload.jobId === 'string' && payload.jobId.length > 0 ? payload.jobId : null

    if (!to) {
      return jsonResponse({ error: 'Missing required field: to' }, 400)
    }
    if (!E164_RE.test(to)) {
      return jsonResponse(
        { error: `Field "to" must be E.164 format (e.g. +15551234567). Got: ${to}` },
        400,
      )
    }
    if (!messageBody || messageBody.length === 0) {
      return jsonResponse({ error: 'Missing required field: body' }, 400)
    }
    if (messageBody.length > 1600) {
      return jsonResponse(
        { error: `Field "body" exceeds Twilio's 1600 character limit (got ${messageBody.length}).` },
        400,
      )
    }

    console.log(
      `twilio-send-sms: dispatch start; to=${to}, bodyLen=${messageBody.length}, driverId=${driverId ?? 'none'}, jobId=${jobId ?? 'none'}`,
    )

    // 3. Build the Twilio request.
    //    - PascalCase form-encoded params.
    //    - URLSearchParams handles the "+" -> "%2B" encoding for us.
    //    - btoa is safe here because SID/token are ASCII.
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`
    const authHeader = 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)

    const form = new URLSearchParams({
      To: to,
      From: TWILIO_FROM_NUMBER!,
      Body: messageBody,
    })

    // 4. Call Twilio.
    let twilioRes: Response
    let twilioData: TwilioMessageResponse
    try {
      twilioRes = await fetch(twilioUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('twilio-send-sms: network error calling Twilio:', message)
      return jsonResponse(
        { error: `Twilio request failed (network): ${message}` },
        502,
      )
    }

    try {
      twilioData = (await twilioRes.json()) as TwilioMessageResponse
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('twilio-send-sms: failed to parse Twilio response JSON:', message)
      return jsonResponse(
        { error: `Twilio returned non-JSON response (HTTP ${twilioRes.status}).` },
        502,
      )
    }

    if (!twilioRes.ok) {
      // Twilio error envelope: { code, message, more_info, status }
      const twilioCode = twilioData.code ?? twilioRes.status
      const twilioMsg = twilioData.message ?? 'Unknown Twilio error'
      console.error(
        `twilio-send-sms: Twilio API error; httpStatus=${twilioRes.status}, code=${twilioCode}, message=${twilioMsg}, more_info=${twilioData.more_info ?? 'n/a'}`,
      )
      return jsonResponse(
        {
          error: `Twilio API error: ${twilioCode} ${twilioMsg}`,
          twilioCode,
          twilioStatus: twilioRes.status,
        },
        502,
      )
    }

    const twilioMessageId = twilioData.sid ?? null
    const deliveryStatus = twilioData.status ?? 'unknown'

    if (!twilioMessageId) {
      console.error('twilio-send-sms: Twilio 2xx but missing sid in response.')
      return jsonResponse(
        { error: 'Twilio returned success but no message SID.' },
        502,
      )
    }

    console.log(
      `twilio-send-sms: Twilio accepted message; sid=${twilioMessageId}, status=${deliveryStatus}, segments=${twilioData.num_segments ?? 'n/a'}`,
    )

    // 5. Log to sms_logs using the service-role client (bypasses RLS).
    const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const logRow: Record<string, unknown> = {
      to_number: to,
      from_number: TWILIO_FROM_NUMBER,
      body: messageBody,
      twilio_message_id: twilioMessageId,
      delivery_status: deliveryStatus,
      driver_id: driverId,
      job_id: jobId,
    }

    const { data: inserted, error: dbError } = await supabase
      .from('sms_logs')
      .insert(logRow)
      .select('id, driver_id, job_id, body, sent_at, twilio_message_id, delivery_status')
      .single()

    if (dbError) {
      // Twilio already accepted the message — surface that fact, but flag the DB failure.
      console.error(
        `twilio-send-sms: DB insert into sms_logs failed after successful Twilio send; sid=${twilioMessageId}, dbError=${dbError.message}`,
      )
      return jsonResponse(
        {
          error: `SMS sent via Twilio (sid=${twilioMessageId}) but failed to log: ${dbError.message}`,
          twilioMessageId,
          deliveryStatus,
        },
        500,
      )
    }

    console.log(
      `twilio-send-sms: success; smsId=${inserted?.id ?? 'null'}, twilioMessageId=${twilioMessageId}, deliveryStatus=${deliveryStatus}`,
    )

    return jsonResponse(
      {
        smsLog: inserted,
      },
      200,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('twilio-send-sms: unhandled error:', message)
    return jsonResponse({ error: message }, 500)
  }
})
