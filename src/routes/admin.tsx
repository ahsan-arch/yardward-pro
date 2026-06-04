import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

// Wrong-role visitors get bounced to their OWN home rather than /login — they
// already have a valid session, so logging them out would be hostile. Drivers
// always go to /driver, mechanics to /mechanic. Unknown role falls through to
// /login so a malformed localStorage doesn't strand the user in a loop.
function homeForRole(role: string | null): "/admin" | "/driver" | "/mechanic" | "/login" {
  if (role === "admin") return "/admin";
  if (role === "driver") return "/driver";
  if (role === "mechanic") return "/mechanic";
  return "/login";
}

export const Route = createFileRoute("/admin")({
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem("fo:authed") !== "1") {
      throw redirect({ to: "/login" });
    }
    // Server-side RLS + edge-function role checks are the real authority,
    // but client-side guarding keeps non-admins out of admin surfaces (and
    // out of the admin nav UI they shouldn't see) before a request fires.
    const role = localStorage.getItem("fo:role");
    if (role !== "admin") {
      throw redirect({ to: homeForRole(role) });
    }
  },
  component: () => <Outlet />,
});
