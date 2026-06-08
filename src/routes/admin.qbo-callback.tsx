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
import { Loader2, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

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
        kind: "success";
        realmId: string;
        env: string;
        selfTestOk: boolean;
        selfTestMsg: string | null;
      }
    | { kind: "failure"; reason: string }
  >({ kind: "idle" });

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
    if (!code || !state || !realmId) {
      setStatus({
        kind: "failure",
        reason:
          "Missing code / state / realmId in the URL. Either Intuit didn't include them, or this page was opened outside the OAuth flow.",
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
    // Clear immediately — the state is single-use. A page refresh after the
    // exchange must not allow a replay.
    window.sessionStorage.removeItem("qbo_oauth_state");

    setStatus({ kind: "exchanging" });
    (async () => {
      const res = await api.completeQboOAuth({
        code,
        realmId,
        state,
        expectedState,
      });
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
    })();
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
