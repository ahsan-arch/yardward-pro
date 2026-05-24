import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Loader2, AlertTriangle, Clock, ArrowRight } from "lucide-react";
import type { DriverToken } from "@/types/domain";
import { driverById } from "@/data/mockData";

export const Route = createFileRoute("/t/$token")({
  head: () => ({ meta: [{ title: "Driver access — FleetOps" }] }),
  component: Page,
});

function Page() {
  const { token } = Route.useParams();
  const nav = useNavigate();
  const [state, setState] = useState<"checking" | "valid" | "invalid">("checking");
  const [tokenData, setTokenData] = useState<DriverToken | null>(null);

  useEffect(() => {
    (async () => {
      const r = await api.validateDriverToken(token);
      if (r.valid && r.token) {
        setTokenData(r.token);
        setState("valid");
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

  if (state === "invalid") {
    return (
      <div className="min-h-[calc(100vh-44px)] grid place-items-center bg-muted/30 p-4">
        <div className="bg-card border border-border rounded-xl p-6 max-w-sm text-center">
          <AlertTriangle className="w-10 h-10 text-danger mx-auto" />
          <h1 className="text-lg font-bold mt-3">Link expired or invalid</h1>
          <p className="text-sm text-muted-foreground mt-2">
            This access link has been used, has expired, or was never generated. Contact your
            dispatcher for a new link.
          </p>
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
        : "/driver";

  function start() {
    if (tokenData) {
      sessionStorage.setItem("fo:driver-token", tokenData.token);
      sessionStorage.setItem("fo:driver-token-scope", tokenData.scopedTo);
      sessionStorage.setItem("fo:driver-token-driver", tokenData.driverId);
      // Mark this browser session as a driver so the /driver/* route guards
      // (which check localStorage) let the user through without a login.
      localStorage.setItem("fo:authed", "1");
      localStorage.setItem("fo:role", "driver");
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
