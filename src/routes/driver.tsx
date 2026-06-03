import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { readDriverTokenSession, isPathAllowedForScope } from "@/hooks/use-driver-token-scope";

export const Route = createFileRoute("/driver")({
  beforeLoad: ({ location }) => {
    if (typeof window === "undefined") return;
    // Two ways to be authorised for /driver/*:
    //   1. Real login — legacy fo:authed flag set by AuthContext after
    //      Supabase signIn or the mock-mode role switch.
    //   2. A sessionStorage-backed driver-token landing from /t/<token>.
    // The token path additionally has to be SCOPE-compatible with the
    // requested path: a tokens-only link cannot wander into work-order, a
    // job-only link cannot reach end-of-day, etc.
    const legacyAuthed = localStorage.getItem("fo:authed") === "1";
    if (legacyAuthed) return;
    const tokenSession = readDriverTokenSession();
    if (!tokenSession) {
      throw redirect({ to: "/login" });
    }
    if (!isPathAllowedForScope(tokenSession.scope, location.pathname)) {
      // Scope mismatch — the link was minted for a narrower purpose than
      // what's being requested. Bounce to /login rather than silently
      // serving the page; the dispatcher mints links per task for a reason.
      throw redirect({ to: "/login" });
    }
  },
  component: () => <Outlet />,
});
