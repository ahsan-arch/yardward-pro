// Supabase Edge Function: qbo-diagnose
// Diagnostic-only. Uses the shared getQboAccessToken helper to acquire an
// access token via the live qbo_oauth_tokens row (with advisory-lock + cache,
// same code path as qbo-push-invoice / qbo-push-time), then makes the lightest
// authenticated call (CompanyInfo) to confirm the realm authorizes the token.
//
// SECURITY:
//   - Admin-or-service-role auth gate at the top.
//   - Never returns access_token, refresh_token, or decoded JWT claims in the
//     response body. We only report safe metadata: presence, expiry timestamp,
//     CompanyInfo HTTP status, env, and realm id.
//
// No DB writes (other than whatever the shared helper does to rotate tokens).

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getQboAccessToken, qboApiHost } from '../_shared/qbo-oauth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonOk(b: unknown, status = 200) {
  return new Response(JSON.stringify(b, null, 2), {
    headers: { ...cors, 'Content-Type': 'application/json' },
    status,
  })
}

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
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 },
    )
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return new Response(
      JSON.stringify({ error: 'Empty bearer token' }),
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 },
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
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 },
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
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 },
    )
  }

  return null
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const REALM_ID = Deno.env.get('QBO_REALM_ID')
  const ENV = Deno.env.get('QBO_ENVIRONMENT') || 'sandbox'

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE_KEY) {
    return jsonOk(
      { error: 'Missing one of SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY' },
      500,
    )
  }

  // Auth gate — admin user JWT or service_role bearer required. Diagnostic
  // endpoints leak credential health (env, realm, expiry) so they MUST be
  // gated even though the body never contains the secrets themselves.
  const authFailure = await verifyAdminOrServiceRole(
    req,
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SERVICE_ROLE_KEY,
  )
  if (authFailure) {
    console.warn('qbo-diagnose: auth rejected')
    return authFailure
  }

  if (!REALM_ID) {
    return jsonOk({ error: 'Missing QBO_REALM_ID' }, 500)
  }

  const apiHost = qboApiHost(Deno.env)

  // Service-role client — the shared helper needs to call
  // lock_qbo_oauth_refresh / unlock_qbo_oauth_refresh RPCs and read/update
  // qbo_oauth_tokens, both of which require service_role.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ---- 1. Acquire an access token via the SHARED helper (same code path as
  //    qbo-push-invoice / qbo-push-time). Reports only safe metadata: success
  //    flag + expiry timestamp. NEVER includes access_token or refresh_token
  //    values, and NEVER decodes/returns JWT claims.
  let tokenOk = false
  let tokenExpiresAt: string | null = null
  let tokenError: string | null = null
  let tokenIsAuthError = false
  let accessToken: string | null = null
  try {
    const tok = await getQboAccessToken(admin, Deno.env)
    tokenOk = true
    tokenExpiresAt = tok.expires_at
    accessToken = tok.access_token
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    tokenIsAuthError = (err as { isAuthError?: boolean })?.isAuthError === true
    // Keep the error message but strip anything that could be a token body —
    // the helper's error text only contains the Intuit HTTP status + a small
    // error envelope, not the secrets themselves, but we cap length anyway.
    tokenError = msg.length > 500 ? msg.slice(0, 500) + '… (truncated)' : msg
  }

  if (!tokenOk) {
    return jsonOk({
      step: 'token-acquire',
      env: ENV,
      apiHost,
      realmIdInSecret: REALM_ID,
      tokenAcquire: {
        ok: false,
        error: tokenError,
        isAuthError: tokenIsAuthError,
      },
      conclusion: tokenIsAuthError
        ? 'invalid_grant: the stored refresh token is dead. Re-run the QBO OAuth consent flow and reseed qbo_oauth_tokens.'
        : 'Could not acquire a QBO access token via the shared helper. Check QBO_CLIENT_ID/SECRET and the qbo_oauth_tokens row.',
    }, 200)
  }

  // ---- 2. CompanyInfo (lightest auth-gated call). Confirms scope + realm.
  //    We DO NOT return the access_token in the body — only the HTTP status
  //    and (if Intuit returned an error envelope) the safe error message.
  const ciUrl = `${apiHost}/v3/company/${REALM_ID}/companyinfo/${REALM_ID}?minorversion=75`
  const ciRes = await fetch(ciUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
  const ciText = await ciRes.text()
  let ciBody: unknown = null
  try { ciBody = JSON.parse(ciText) } catch { /* ignore */ }

  // Surface only safe fields from the CompanyInfo body. If the response is an
  // error envelope (Fault), include just the message — never the raw body
  // (the success body contains company financial metadata we don't need to
  // echo). On success we just report ok + http status.
  type FaultErr = { Message?: string; Detail?: string; code?: string }
  type FaultBody = { Fault?: { Error?: FaultErr[]; type?: string } }
  const fault = (ciBody as FaultBody | null)?.Fault
  const ciSafeBody = ciRes.ok
    ? { received: true }
    : fault
      ? {
          faultType: fault.type ?? null,
          errors: (fault.Error ?? []).map((e) => ({
            code: e.code ?? null,
            message: e.Message ?? null,
            detail: e.Detail ?? null,
          })),
        }
      : { rawStatus: ciRes.status, note: 'non-JSON or non-Fault response' }

  return jsonOk({
    env: ENV,
    apiHost,
    realmIdInSecret: REALM_ID,
    tokenAcquire: {
      ok: true,
      // Only the expiry timestamp — NEVER the access_token / refresh_token.
      access_token_expires_at: tokenExpiresAt,
      source: 'shared helper (qbo_oauth_tokens + advisory lock)',
    },
    companyInfoTest: {
      url: ciUrl.replace(REALM_ID, '<realmId>'),
      status: ciRes.status,
      ok: ciRes.ok,
      response: ciSafeBody,
    },
    conclusion: ciRes.ok
      ? 'Credentials work. The shared helper acquired a token and the realm authorizes it for the configured environment.'
      : `CompanyInfo call returned ${ciRes.status}. ` +
        (ciRes.status === 401
          ? 'AuthorizationFailure: the token is valid but does not authorize this realm in this environment. Either QBO_REALM_ID is wrong, or the refresh token was issued for production while QBO_ENVIRONMENT is sandbox (or vice versa).'
          : `Unexpected status: ${ciRes.status}`),
  })
})
