import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Loader2, AlertTriangle, Clock, ArrowRight } from "lucide-react";
import type { DriverToken } from "@/types/domain";
import { driverById } from "@/data/mockData";

export const Route = createFileRoute("/t/$token")({
  head: () => ({ meta: [{ title: "Driver access — Engage Hydrovac CRM" }] }),
  component: Page,
});

type LandingState = "checking" | "valid" | "used" | "expired" | "invalid";

function Page() {
  const { token } = Route.useParams();
  const nav = useNavigate();
  const [state, setState] = useState<LandingState>("checking");
  const [tokenData, setTokenData] = useState<DriverToken | null>(null);

  useEffect(() => {
    (async () => {
      // api.validateDriverToken hits Supabase under USE_SUPABASE and the local
      // store on mocks. Either way it returns the raw row so we can distinguish
      // "used" from "expired" from "never existed" and show a friendlier screen
      // than the catch-all "link invalid".
      const r = await api.validateDriverToken(token);
      if (r.valid && r.token) {
        setTokenData(r.token);
        setState("valid");
        return;
      }
      if (!r.token) {
        setState("invalid");
        return;
      }
      // We got the row back but it's not claimable. Was it consumed or did the
      // clock run out?
      if (r.token.usedAt) {
        setState("used");
      } else if (new Date(r.token.expiresAt).getTime() < Date.now()) {
        setState("expired");
      } else {
        setState("invalid");
      }
    })();
  }, [token]);

  if (state === "checking") {
    return (
      <div className="min-h-[calc(100vh-44px)] grid place-items-center bg-muted/30 p-4">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-amber-brand" />
          <p className="mt-3 text-sm text-muted-foreground">Validating access link…</p>
        </div>
      </div>
    );
  }

  if (state === "used" || state === "expired" || state === "invalid") {
    const copy =
      state === "used"
        ? {
            title: "Link already used",
            body: "This access link was used to submit a form and has been revoked. Each link is single-use — contact your dispatcher for a new one.",
          }
        : state === "expired"
          ? {
              title: "Link expired",
              body: "This access link is past its expiry window. Contact your dispatcher for a fresh link.",
            }
          : {
              title: "Link invalid",
              body: "This access link was never generated or has been revoked. Contact your dispatcher for a new link.",
            };
    return (
      <div className="min-h-[calc(100vh-44px)] grid place-items-center bg-muted/30 p-4">
        <div
          className="bg-card border border-border rounded-xl p-6 max-w-sm text-center"
          data-testid={`token-${state}`}
        >
          <AlertTriangle className="w-10 h-10 text-danger mx-auto" />
          <h1 className="text-lg font-bold mt-3">{copy.title}</h1>
          <p className="text-sm text-muted-foreground mt-2">{copy.body}</p>
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 mt-5 h-10 px-4 rounded-md bg-amber-brand text-amber-brand-foreground text-sm font-semibold"
          >
            Go to login
          </Link>
        </div>
      </div>
    );
  }

  const driver = tokenData ? driverById(tokenData.driverId) : null;
  const expiresIn = tokenData
    ? Math.max(0, Math.round((new Date(tokenData.expiresAt).getTime() - Date.now()) / 60_000))
    : 0;
  const scopeTarget =
    tokenData?.scopedTo === "forms"
      ? "/driver/forms"
      : tokenData?.scopedTo === "job"
        ? "/driver/work-order"
        : tokenData?.scopedTo === "tickets"
          ? "/driver/tickets"
          : "/driver";

  async function start() {
    if (tokenData) {
      // SECURITY: do NOT write fo:authed/fo:role to localStorage. The legacy
      // build did, which had the side effect of elevating the tokenized
      // visitor to a fully logged-in driver for ALL future routes — and the
      // elevation outlived the tab, the browser restart, every subsequent
      // navigation. A leaked link became a persistent fake driver session.
      //
      // Instead, we record the session in sessionStorage (cleared on tab
      // close) and the driver subroutes consult useDriverTokenScope() so
      // access is gated by (a) the scope being recognised, (b) the recorded
      // expiry being in the future, and (c) the requested route belonging
      // to the scope's allow-list. The legacy /driver guard's fo:authed
      // check is augmented to accept this session as a stand-in.
      sessionStorage.setItem("fo:driver-token", tokenData.token);
      sessionStorage.setItem("fo:driver-token-scope", tokenData.scopedTo);
      sessionStorage.setItem("fo:driver-token-driver-id", tokenData.driverId);
      sessionStorage.setItem("fo:driver-token-expires-at", tokenData.expiresAt);
      // Back-compat alias retained because driver.work-order / EOD / SOD
      // already read this slot when deciding whether to burn the token on
      // submission. Removing it would break the existing flushers.
      sessionStorage.setItem("fo:driver-token-driver", tokenData.driverId);
      // Burn the token server-side immediately. The session record above
      // is the ongoing credential; the token itself does not need to stay
      // claimable after this page. If the consume races with a duplicate
      // tab opening the same link, only one wins — both still get a valid
      // sessionStorage record because we already validated above, and the
      // server-side state is authoritative for any subsequent submission's
      // "already burned" warning toast.
      //
      // (We deliberately ignore the boolean return: the validator above
      // already returned state=valid, and a parallel consume losing the
      // race is benign for THIS tab — the form submits still call
      // consumeDriverToken which will return false and surface the
      // standard "couldn't be revoked" warning.)
      void api.consumeDriverToken(tokenData.token);
      // Fire a same-tab event so any mounted useDriverTokenScope() hooks
      // pick up the new session without waiting for the next navigation
      // to re-read from sessionStorage.
      try {
        window.dispatchEvent(new Event("fo:driver-token-session"));
      } catch {
        /* ignore */
      }
    }
    nav({ to: scopeTarget });
  }

  return (
    <div className="min-h-[calc(100vh-44px)] grid place-items-center bg-muted/30 p-4">
      <div className="bg-card border border-border rounded-xl p-6 max-w-sm w-full">
        <div className="text-center">
          <div className="w-14 h-14 rounded-full bg-amber-brand mx-auto grid place-items-center text-amber-brand-foreground font-bold text-xl">
            {driver?.initials ?? "?"}
          </div>
          <h1 className="text-lg font-bold mt-3">Hi {driver?.name.split(" ")[0] ?? "Driver"}</h1>
          <p className="text-xs text-muted-foreground mt-1">
            No login needed — this link is just for you.
          </p>
        </div>
        <div className="mt-5 space-y-2 text-sm border-t border-border pt-4">
          <Row k="Access scope" v={tokenData?.scopedTo.toUpperCase() ?? "—"} />
          <Row k="Expires" v={`in ${expiresIn} min`} />
          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground pt-1">
            <Clock className="w-3 h-3" /> Token will be revoked on submission or expiry
          </div>
        </div>
        <button
          onClick={start}
          className="mt-5 w-full h-12 rounded-md bg-amber-brand text-amber-brand-foreground font-bold inline-flex items-center justify-center gap-2"
        >
          Continue <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
