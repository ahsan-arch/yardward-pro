// Shared QuickBooks Online OAuth helper for Supabase edge functions.
//
// Why this exists:
//   qbo-push-invoice and qbo-push-time both refresh the same QBO refresh_token.
//   Intuit rotates the refresh_token on EVERY refresh — the previous token is
//   invalidated within minutes. If two edge functions refresh concurrently:
//     - the first POST returns tokens A2/R2 and persists R2
//     - the second POST (still using R1) races with the first persist:
//         * worst case: second POST sees R1 invalidated -> 401 -> integration bricks
//         * best case: second persist clobbers the first persist with stale tokens
//
// Fix: wrap the refresh+persist in a Postgres advisory lock + access-token cache.
//   0. lock-free fast path — read qbo_oauth_tokens; if access_token has >60s
//      left, return it immediately without acquiring the advisory lock. This
//      is the common case under high concurrency.
//   1. lock_qbo_oauth_refresh() — pg_advisory_lock blocks concurrent refreshes
//   2. read qbo_oauth_tokens row
//   3. if access_token is still valid (>60s remaining) reuse it (no Intuit call)
//      — this in-lock re-check makes the fast path race-safe: two callers
//      racing past a just-expired cache will both fall through, but only the
//      first inside the lock will refresh; the second sees a fresh cache.
//   4. otherwise POST /oauth2/v1/tokens, persist rotated refresh_token +
//      access_token + access_token_expires_at
//   5. finally unlock_qbo_oauth_refresh() — even on error paths

// We intentionally type the Supabase client and env as `any` here so this
// module is reusable from any edge function without dragging in shared type
// definitions. Each edge function passes its own createClient instance + Deno.env.

// deno-lint-ignore-file no-explicit-any

export type QboTokens = {
  access_token: string
  refresh_token: string
  expires_at: string // ISO of when access_token expires (with safety margin baked in)
  realm_id: string
}

// fetchWithTimeout: AbortController-backed fetch. Throws Error with
// `.isTimeout=true` on timeout so callers can map to 504. Inlined here so this
// shared module has no inter-function imports.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms = 20_000,
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

// Resolves the QBO API host from QBO_ENVIRONMENT. Defaults to sandbox so a
// missing/typoed env var never accidentally hits a production realm.
export function qboApiHost(env: { get: (k: string) => string | undefined }): string {
  return env.get('QBO_ENVIRONMENT') === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com'
}

/**
 * Acquires a QBO access_token suitable for immediate use.
 *
 * Contract:
 *   - Holds pg_advisory_lock('qbo_oauth_default') for the entire refresh+persist
 *     so concurrent edge function invocations cannot race the refresh_token.
 *   - If the cached access_token has > 60s remaining, returns it without
 *     hitting Intuit.
 *   - Otherwise POSTs to https://oauth.platform.intuit.com/oauth2/v1/tokens,
 *     persists rotated refresh_token + access_token + access_token_expires_at,
 *     then returns the new access_token.
 *   - The advisory lock is always released in finally (PG also auto-releases
 *     on session end as a backstop).
 *
 * Requires:
 *   - qbo_oauth_tokens row with id='default' must exist (run OAuth onboarding).
 *   - env must expose QBO_CLIENT_ID and QBO_CLIENT_SECRET.
 *   - supabase client must be authorized to call lock_qbo_oauth_refresh /
 *     unlock_qbo_oauth_refresh RPCs (service_role).
 */
export async function getQboAccessToken(
  supabase: any,
  env: { get: (k: string) => string | undefined },
): Promise<QboTokens> {
  const clientId = env.get('QBO_CLIENT_ID')
  const clientSecret = env.get('QBO_CLIENT_SECRET')
  if (!clientId || !clientSecret) {
    throw new Error('QBO_CLIENT_ID and QBO_CLIENT_SECRET must be set')
  }

  // 0. Lock-free fast path — under high QBO concurrency, most calls find a
  // fresh cached access_token and don't need to refresh. Serializing every
  // call on the advisory lock only to do a cache-hit read wastes a roundtrip
  // and creates a bottleneck. Read the row WITHOUT the lock first; if the
  // cached access_token is still good for >60s, return immediately.
  //
  // Race safety: if two callers hit this fast path simultaneously when the
  // cache just expired, both fall through to the lock path. The first
  // acquires + refreshes + persists; the second waits on the lock, acquires,
  // then the lock-held re-check (step 3 below) finds the cache fresh and
  // skips the refresh. The in-lock re-check MUST stay in place for this.
  {
    const { data: fastRow, error: fastErr } = await supabase
      .from('qbo_oauth_tokens')
      .select('access_token, access_token_expires_at, refresh_token, realm_id')
      .eq('id', 'default')
      .single()
    // Swallow fastErr: a transient read error here is fine because the lock
    // path will re-read authoritatively and surface any real failure.
    if (!fastErr && fastRow && fastRow.access_token) {
      const fastExpiresAtMs = fastRow.access_token_expires_at
        ? Date.parse(fastRow.access_token_expires_at)
        : 0
      if (fastExpiresAtMs > Date.now() + 60_000) {
        return {
          access_token: fastRow.access_token,
          refresh_token: fastRow.refresh_token,
          expires_at: fastRow.access_token_expires_at,
          realm_id: fastRow.realm_id,
        }
      }
    }
  }

  // 1. Acquire advisory lock — blocks until any in-flight refresh completes.
  const { error: lockErr } = await supabase.rpc('lock_qbo_oauth_refresh')
  if (lockErr) {
    throw new Error(`lock_qbo_oauth_refresh failed: ${lockErr.message}`)
  }

  try {
    // 2. Load the singleton tokens row.
    const { data: row, error: rowErr } = await supabase
      .from('qbo_oauth_tokens')
      .select('*')
      .eq('id', 'default')
      .single()
    if (rowErr) {
      throw new Error(`qbo_oauth_tokens read failed: ${rowErr.message}`)
    }
    if (!row) {
      throw new Error('qbo_oauth_tokens row missing — run OAuth onboarding')
    }

    const cachedExpiresAtMs = row.access_token_expires_at
      ? Date.parse(row.access_token_expires_at)
      : 0
    const nowMs = Date.now()

    // 3. Cache hit: token still good for >60s — reuse, skip Intuit roundtrip.
    if (row.access_token && cachedExpiresAtMs > nowMs + 60_000) {
      return {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        expires_at: row.access_token_expires_at,
        realm_id: row.realm_id,
      }
    }

    // 4. Refresh. The canonical URL per Intuit's OIDC discovery doc is
    // /oauth2/v1/tokens/bearer (the bare /oauth2/v1/tokens path 404s).
    // Both refresh_token and authorization_code grants use this same
    // endpoint.
    const tokenRes = await fetchWithTimeout(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret),
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: row.refresh_token,
        }),
      },
      12_000,
    )

    if (!tokenRes.ok) {
      const detail = await tokenRes.text()
      // Tag as authError when Intuit explicitly says invalid_grant so callers
      // can map to a 401 + 'run OAuth re-consent' instead of a generic 502.
      let qboError: string | undefined
      try {
        qboError = JSON.parse(detail)?.error
      } catch {
        /* non-JSON body — leave qboError undefined */
      }
      const err = new Error(
        `QBO refresh failed ${tokenRes.status}: ${detail}`,
      ) as Error & { qboError?: string; isAuthError?: boolean }
      err.qboError = qboError
      err.isAuthError = qboError === 'invalid_grant'
      throw err
    }

    const tokenJson = await tokenRes.json()
    // 30s safety margin so a token returned at the edge of its validity isn't
    // sent to QBO after expiry due to clock drift / handler latency.
    const expiresAtMs = nowMs + tokenJson.expires_in * 1000 - 30_000
    const expiresAtIso = new Date(expiresAtMs).toISOString()
    const updatedAtIso = new Date().toISOString()

    const { error: upErr } = await supabase
      .from('qbo_oauth_tokens')
      .update({
        refresh_token: tokenJson.refresh_token,
        access_token: tokenJson.access_token,
        access_token_expires_at: expiresAtIso,
        updated_at: updatedAtIso,
      })
      .eq('id', 'default')
    if (upErr) {
      throw new Error(`Failed to persist rotated QBO tokens: ${upErr.message}`)
    }

    return {
      access_token: tokenJson.access_token,
      refresh_token: tokenJson.refresh_token,
      expires_at: expiresAtIso,
      realm_id: row.realm_id,
    }
  } finally {
    // Release the advisory lock. Swallow errors — PG auto-releases advisory
    // locks on session end, so a failed unlock here doesn't leak the lock
    // long-term, but we still want to free it ASAP for the next caller.
    await supabase
      .rpc('unlock_qbo_oauth_refresh')
      .then(() => {}, () => {
        /* lock auto-releases on session end as backstop */
      })
  }
}
