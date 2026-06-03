// Session-scoped driver-token state. Replaces the legacy fo:authed/fo:role
// localStorage flags that the /t/$token landing page used to set, which had
// the side effect of elevating the visitor to a fully logged-in driver for
// EVERY future route (including /driver/profile, /admin redirect targets,
// etc.). That elevation outlived the tab, survived browser restarts, and
// was indistinguishable from a real password login.
//
// The replacement:
//   - sessionStorage (cleared on tab close) — not localStorage
//   - Three discrete keys we read together so a route guard can fail closed
//     when ANY piece is missing or inconsistent
//   - A scope check helper so each /driver/* subroute can declare which
//     scopes are allowed; tokens scoped to "tickets"/"inspection"/"forms"
//     cannot wander into the rest of the driver app

import { useEffect, useState } from "react";
import type { TokenScope } from "@/types/domain";

export type DriverTokenSession = {
  scope: TokenScope;
  driverId: string;
  expiresAt: string;
  token: string;
};

const SCOPE_KEY = "fo:driver-token-scope";
const DRIVER_KEY = "fo:driver-token-driver-id";
const EXPIRES_KEY = "fo:driver-token-expires-at";
// Kept under the old key for back-compat with consume calls in the form routes
// that already read this slot. The new keys live alongside it.
const TOKEN_KEY = "fo:driver-token";

const VALID_SCOPES: readonly TokenScope[] = ["forms", "job", "shift", "tickets"] as const;

function isTokenScope(v: string | null): v is TokenScope {
  return v != null && (VALID_SCOPES as readonly string[]).includes(v);
}

// One-shot read. Returns null when ANY required key is missing, the scope
// is unrecognised, or the recorded expiry has elapsed. Callers should
// treat a null return as "no scoped session" — never as "open access".
export function readDriverTokenSession(): DriverTokenSession | null {
  if (typeof window === "undefined") return null;
  const scope = sessionStorage.getItem(SCOPE_KEY);
  const driverId = sessionStorage.getItem(DRIVER_KEY);
  const expiresAt = sessionStorage.getItem(EXPIRES_KEY);
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!isTokenScope(scope) || !driverId || !expiresAt || !token) return null;
  if (new Date(expiresAt).getTime() < Date.now()) return null;
  return { scope, driverId, expiresAt, token };
}

// Burn the sessionStorage record. Driver form routes call this after a
// successful api.consumeDriverToken so a refresh of the same tab can't
// continue to use the (now server-side-burned) link.
export function clearDriverTokenSession(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(SCOPE_KEY);
  sessionStorage.removeItem(DRIVER_KEY);
  sessionStorage.removeItem(EXPIRES_KEY);
  // Also burn the legacy key the t.$token page used to write to localStorage
  // in case a user opened the app under a previous build and still has the
  // flag persisted. Defence in depth — newer builds never write these.
  try {
    if (localStorage.getItem("fo:authed") === "1" && localStorage.getItem("fo:role") === "driver") {
      // Don't yank a real Supabase-authenticated driver session: only clear
      // when the legacy flag is the SOLE evidence of being authed (i.e. no
      // Supabase session would also be present). Best-effort.
    }
  } catch {
    /* ignore */
  }
  // Notify same-tab subscribers (storage event only fires for OTHER tabs).
  // AuthContext's tab-focus revalidate listener listens for this to tear
  // down its visibilitychange/focus/online listeners when the session is
  // consumed mid-tab.
  try {
    window.dispatchEvent(new Event("fo:driver-token-session"));
  } catch {
    /* ignore — synthetic event constructor unavailable in some envs */
  }
}

// React hook. Subscribes to the `storage` event so cross-tab clears
// propagate, plus a custom `fo:driver-token-session` event we dispatch on
// same-tab writes (storage event doesn't fire for the originating tab).
export function useDriverTokenScope(): DriverTokenSession | null {
  const [session, setSession] = useState<DriverTokenSession | null>(() => readDriverTokenSession());

  useEffect(() => {
    if (typeof window === "undefined") return;
    function refresh() {
      setSession(readDriverTokenSession());
    }
    window.addEventListener("storage", refresh);
    window.addEventListener("fo:driver-token-session", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("fo:driver-token-session", refresh);
    };
  }, []);

  return session;
}

// Map of which driver routes each scope is allowed to reach. Add a new
// entry here when a new scope is introduced — the scope-gate guard reads
// this directly so there is one source of truth.
//
// Path prefixes are checked left-to-right so a more specific prefix wins
// (e.g. /driver/inspection matches "inspection" before the generic "/driver"
// match for "shift" can claim it).
const SCOPE_ALLOWED_PATHS: Record<TokenScope, readonly string[]> = {
  // Shift-scoped tokens get the whole driver workflow: SOD, EOD, work-order,
  // dashboard. (Subset of the legacy "any logged-in driver" surface, minus
  // profile / settings.)
  shift: ["/driver/start-of-day", "/driver/end-of-day", "/driver/work-order", "/driver"],
  // Job-scoped tokens cover only the single work-order submission they were
  // generated for. (Legacy callers used scope='job' to mean "deliver one WO
  // from this link.")
  job: ["/driver/work-order"],
  // Forms-scoped tokens cover the multi-form-per-day case the dispatcher
  // hands a driver who only needs to file paperwork: SOD, tool checklist,
  // inspection, forms hub.
  forms: [
    "/driver/start-of-day",
    "/driver/end-of-day",
    "/driver/tool-checklist",
    "/driver/inspection",
    "/driver/forms",
  ],
  // Tickets-scoped tokens land on the prepaid-ticket recording flow. Used by
  // QR codes printed on a client's ticket book — a driver scans the code,
  // selects the client, and records a debit. Cannot reach work-order / EOD
  // / etc. because that's not what the QR represents.
  tickets: ["/driver/tickets"],
};

// True iff `pathname` is reachable for a session with the given scope.
// Used by route beforeLoad guards and the layout-level redirect.
export function isPathAllowedForScope(scope: TokenScope, pathname: string): boolean {
  const allowed = SCOPE_ALLOWED_PATHS[scope] ?? [];
  return allowed.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
