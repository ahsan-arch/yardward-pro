import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import {
  firstAllowedAdminPath,
  readStoredAdminTabs,
  tabForAdminPath,
} from "@/lib/admin-tabs";

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
  beforeLoad: ({ location }) => {
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
    // Tab-level access: restricted admins (owner/custom-roles feature) are
    // bounced off tabs outside their allowed set. tabForAdminPath returns
    // null for exempt paths (qbo-callback) and readStoredAdminTabs fails
    // open to "all" when no restriction data exists — full-access admins
    // never hit the redirect.
    const tab = tabForAdminPath(location.pathname);
    if (tab !== null) {
      const allowed = readStoredAdminTabs();
      if (allowed !== "all" && !allowed.includes(tab)) {
        throw redirect({ to: firstAllowedAdminPath(allowed) });
      }
    }
  },
  component: () => <Outlet />,
});
