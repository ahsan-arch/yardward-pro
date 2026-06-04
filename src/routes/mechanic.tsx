import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

function homeForRole(role: string | null): "/admin" | "/driver" | "/mechanic" | "/login" {
  if (role === "admin") return "/admin";
  if (role === "driver") return "/driver";
  if (role === "mechanic") return "/mechanic";
  return "/login";
}

export const Route = createFileRoute("/mechanic")({
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem("fo:authed") !== "1") {
      throw redirect({ to: "/login" });
    }
    // Strict role isolation: only mechanics see /mechanic/*. Drivers go to
    // their own home, admins to theirs. This client-side check is paired
    // with server-side RLS (mechanic-only policies on maintenance_work_orders,
    // inventory_items, etc.).
    const role = localStorage.getItem("fo:role");
    if (role !== "mechanic") {
      throw redirect({ to: homeForRole(role) });
    }
  },
  component: () => <Outlet />,
});
