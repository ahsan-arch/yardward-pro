// QBO OAuth callback landing route.
//
// Intuit redirects the admin's browser here after they grant consent at
// appcenter.intuit.com. The URL carries ?code, ?realmId, ?state. We:
//   1. Read sessionStorage('qbo_oauth_state') — set by IntegrationsTab when
//      it called api.startQboOAuth() and navigated away.
//   2. Compare to the state in the URL (the edge function also constant-time
//      compares, but rejecting early here saves a roundtrip).
//   3. POST { code, realmId, state, expectedState } to qbo-oauth-callback,
//      which exchanges the code for refresh_token + persists.
//   4. Show success / failure inline, then auto-navigate back to
//      /admin/settings → Integrations after 3s on success.
//
// Why this lives at /admin/qbo-callback (not /admin/settings/qbo-callback):
//   The settings route is a leaf in TanStack file-based routing. Adding a
//   child would change its semantics. A sibling at the same depth keeps the
//   layout untouched.
//
// QBO_REDIRECT_URI must equal window.location.origin + "/admin/qbo-callback"
// and must match the Redirect URI registered in the Intuit Developer Portal.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AdminShell } from "@/components/layout/AdminLayout";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Loader2, CheckCircle2, XCircle, AlertCircle, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SearchParams = {
  code?: string;
  state?: string;
  realmId?: string;
  error?: string;
  error_description?: string;
};

export const Route = createFileRoute("/admin/qbo-callback")({
  head: () => ({ meta: [{ title: "Connecting QuickBooks… — Yardward Pro" }] }),
  validateSearch: (search): SearchParams => ({
    code: typeof search.code === "string" ? search.code : undefined,
    state: typeof search.state === "string" ? search.state : undefined,
    realmId: typeof search.realmId === "string" ? search.realmId : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    error_description:
      typeof search.error_description === "string" ? search.error_description : undefined,
  }),
  component: Page,
});

function Page() {
  const { code, state, realmId, error: oauthError, error_description } = Route.useSearch();
  const navigate = useNavigate();
  // useRef so React StrictMode's dev double-invoke doesn't fire the exchange
  // twice — once we've consumed the code we MUST NOT re-POST it. Intuit
  // authorization codes are single-use; a second exchange will return
  // "invalid_grant" and the success banner would flip to red mid-render.
  const startedRef = useRef(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "exchanging" }
    | {
        // realmId-missing fallback: Intuit silently downgrades certain re-auth
        // flows (typically a pre-existing OpenID-only grant on the user's
        // account) and returns the redirect WITH code+state but WITHOUT
        // realmId. In that case we keep state alive in sessionStorage and
        // let the admin paste their QBO Company ID by hand — the edge
        // function's contract is unchanged (realmId comes from the POST body
        // regardless of source).
        kind: "needs-realm";
        code: string;
        state: string;
        expectedState: string;
      }
    | {
        kind: "success";
        realmId: string;
        env: string;
        selfTestOk: boolean;
        selfTestMsg: string | null;
      }
    | { kind: "failure"; reason: string }
  >({ kind: "idle" });

  // Shared exchange helper — called by both the auto-from-URL path and the
  // manual-realmId-form submit. Pulls sessionStorage cleanup INTO this helper
  // so the needs-realm branch can defer the wipe until submit (a refresh
  // mid-paste must not strand the user with no state token).
  async function runExchange(args: {
    code: string;
    realmId: string;
    state: string;
    expectedState: string;
  }) {
    window.sessionStorage.removeItem("qbo_oauth_state");
    setStatus({ kind: "exchanging" });
    const res = await api.completeQboOAuth(args);
    if (!res.ok) {
      setStatus({ kind: "failure", reason: res.reason });
      return;
    }
    setStatus({
      kind: "success",
      realmId: res.realmId,
      env: res.env,
      selfTestOk: res.refreshedSelfTest,
      selfTestMsg: res.selfTestMsg,
    });
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (oauthError) {
      setStatus({
        kind: "failure",
        reason: `Intuit returned an OAuth error: ${oauthError}${
          error_description ? ` — ${error_description}` : ""
        }`,
      });
      return;
    }
    if (!code || !state) {
      setStatus({
        kind: "failure",
        reason:
          "Missing code or state in the URL. Either Intuit didn't include them, or this page was opened outside the OAuth flow.",
      });
      return;
    }
    const expectedState = window.sessionStorage.getItem("qbo_oauth_state");
    if (!expectedState) {
      setStatus({
        kind: "failure",
        reason:
          "No state token in sessionStorage. Restart the connection flow from Settings → Integrations.",
      });
      return;
    }
    if (!realmId) {
      // Intuit didn't include the realmId — switch to the manual-entry form.
      // DO NOT wipe sessionStorage here; we'll wipe inside runExchange after
      // the admin submits the form, so a refresh during paste doesn't burn
      // the state token.
      setStatus({ kind: "needs-realm", code, state, expectedState });
      return;
    }
    void runExchange({ code, realmId, state, expectedState });
    // We intentionally only fire-and-forget on mount; runExchange manages
    // its own state transitions.
  }, [code, state, realmId, oauthError, error_description]);

  // Auto-bounce back to Integrations 3s after success — only if the self-test
  // also passed, otherwise leave the admin on this page so they can read the
  // diagnostic.
  useEffect(() => {
    if (status.kind !== "success" || !status.selfTestOk) return;
    const t = window.setTimeout(() => {
      void navigate({ to: "/admin/settings", search: { tab: "integrations" } as unknown as never });
    }, 3000);
    return () => window.clearTimeout(t);
  }, [status, navigate]);

  return (
    <AdminShell title="Connecting QuickBooks">
      <div className="max-w-2xl mx-auto bg-card border border-border rounded-lg p-6">
        {(status.kind === "idle" || status.kind === "exchanging") && (
          <div className="flex items-center gap-3 text-sm">
            <Loader2 className="w-5 h-5 animate-spin text-amber-brand" />
            <span>Exchanging Intuit authorization code for a refresh token…</span>
          </div>
        )}

        {status.kind === "success" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="w-5 h-5" />
              <h2 className="font-semibold">QuickBooks connected</h2>
            </div>
            <dl className="text-sm space-y-1">
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-32">Realm id</dt>
                <dd className="font-mono">{status.realmId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-32">Environment</dt>
                <dd className="font-mono">{status.env}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground w-32">Self-test</dt>
                <dd className={status.selfTestOk ? "text-success" : "text-amber-brand"}>
                  {status.selfTestOk ? "passed" : "failed"}
                  {status.selfTestMsg ? ` — ${status.selfTestMsg}` : ""}
                </dd>
              </div>
            </dl>
            {status.selfTestOk ? (
              <p className="text-xs text-muted-foreground">
                Redirecting to Settings → Integrations…
              </p>
            ) : (
              <div className="bg-amber-brand/10 border border-amber-brand/30 rounded-md p-3 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-brand mt-0.5 shrink-0" />
                <span className="text-amber-brand">
                  Tokens are stored, but the self-test failed. The most common cause is
                  QBO_ENVIRONMENT not matching the realm you authorized (sandbox vs production).
                </span>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/admin/settings",
                  search: { tab: "integrations" } as unknown as never,
                })
              }
              data-testid="qbo-callback-back-to-settings"
            >
              Back to Settings
            </Button>
          </div>
        )}

        {status.kind === "needs-realm" && (
          <NeedsRealmForm
            onSubmit={(realmId) =>
              void runExchange({
                code: status.code,
                realmId,
                state: status.state,
                expectedState: status.expectedState,
              })
            }
            onCancel={() =>
              void navigate({
                to: "/admin/settings",
                search: { tab: "integrations" } as unknown as never,
              })
            }
          />
        )}

        {status.kind === "failure" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-danger">
              <XCircle className="w-5 h-5" />
              <h2 className="font-semibold">Could not connect QuickBooks</h2>
            </div>
            <p
              className="text-sm font-mono whitespace-pre-wrap break-words"
              data-testid="qbo-callback-error"
            >
              {status.reason}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/admin/settings",
                  search: { tab: "integrations" } as unknown as never,
                })
              }
            >
              Back to Settings
            </Button>
          </div>
        )}
      </div>
    </AdminShell>
  );
}

// Fallback form rendered when Intuit's redirect omits the realmId query
// param. This happens when the user's Intuit account already has an
// authorization for this app from a prior OpenID-only-scoped flow — Intuit
// then silently downgrades the new authorize to OIDC-only and skips the
// company picker. The clean fix is for the admin to disconnect the app
// inside QBO (Apps → My Apps → Disconnect) and retry. This form is the
// band-aid that unblocks them anyway: paste the 15-digit QBO Company ID
// (gear icon → Account and settings → Billing & Subscription → Company ID)
// and we POST it to qbo-oauth-callback which already accepts realmId from
// the body, no schema or backend changes needed.
function NeedsRealmForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (realmId: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Intuit realm IDs are numeric, typically 15 digits but we accept 10-20
  // to be conservative — old sandbox realms can be shorter.
  const trimmed = value.trim();
  const valid = /^\d{10,20}$/.test(trimmed);

  return (
    <div className="space-y-4" data-testid="qbo-callback-needs-realm">
      <div className="flex items-center gap-2 text-amber-brand">
        <KeyRound className="w-5 h-5" />
        <h2 className="font-semibold">One more step — enter your Company ID</h2>
      </div>
      <div className="bg-amber-brand/10 border border-amber-brand/30 rounded-md p-3 text-xs flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-amber-brand mt-0.5 shrink-0" />
        <div className="text-amber-brand">
          <p className="font-semibold mb-1">
            Intuit didn't include your Company ID in the redirect.
          </p>
          <p>
            This usually happens when a previous authorization is still cached on Intuit's side.
            Paste your QuickBooks Company ID below to finish connecting — you can find it inside
            QuickBooks Online → gear icon →
            <span className="font-medium"> Account and settings → Billing & Subscription</span> (the
            15-digit number labelled <span className="font-mono">Company ID</span>).
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="qbo-realm-input">QuickBooks Company ID</Label>
        <Input
          id="qbo-realm-input"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          placeholder="123456789012345"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
          className="font-mono"
          data-testid="qbo-callback-realm-input"
        />
        {trimmed && !valid && (
          <p className="text-xs text-danger">Company ID must be 10–20 digits, numbers only.</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          onClick={() => {
            if (!valid || submitting) return;
            setSubmitting(true);
            onSubmit(trimmed);
          }}
          disabled={!valid || submitting}
          data-testid="qbo-callback-realm-submit"
          className="bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90"
        >
          {submitting ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <CheckCircle2 className="w-3 h-3" />
          )}
          <span className="ml-1">Finish connecting</span>
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
