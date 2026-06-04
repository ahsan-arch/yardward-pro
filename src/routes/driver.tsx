import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { readDriverTokenSession, isPathAllowedForScope } from "@/hooks/use-driver-token-scope";

function homeForRole(role: string | null): "/admin" | "/driver" | "/mechanic" | "/login" {
  if (role === "admin") return "/admin";
  if (role === "driver") return "/driver";
  if (role === "mechanic") return "/mechanic";
  return "/login";
}

export const Route = createFileRoute("/driver")({
  beforeLoad: ({ location }) => {
    if (typeof window === "undefined") return;
    // Three ways to be authorised for /driver/*:
    //   1. Real login as a driver — fo:authed=1 AND fo:role=driver.
    //   2. A sessionStorage-backed driver-token landing from /t/<token>,
    //      whose scope must match the requested path.
    //   3. (No other paths — admins do NOT cross over into /driver/*; the
    //      strict role isolation policy bounces them to their own home.)
    const tokenSession = readDriverTokenSession();
    if (tokenSession) {
      if (!isPathAllowedForScope(tokenSession.scope, location.pathname)) {
        // Scope mismatch — the link was minted for a narrower purpose than
        // what's being requested. Bounce to /login rather than silently
        // serving the page; the dispatcher mints links per task for a reason.
        throw redirect({ to: "/login" });
      }
      return;
    }
    if (localStorage.getItem("fo:authed") !== "1") {
      throw redirect({ to: "/login" });
    }
    const role = localStorage.getItem("fo:role");
    if (role !== "driver") {
      throw redirect({ to: homeForRole(role) });
    }
  },
  component: () => <Outlet />,
});
