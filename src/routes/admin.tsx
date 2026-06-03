import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/admin")({
  beforeLoad: () => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem("fo:authed") !== "1") {
      throw redirect({ to: "/login" });
    }
    // Server-side RLS + edge-function role checks are the real authority,
    // but client-side guarding keeps non-admins out of admin surfaces (and
    // out of the admin nav UI they shouldn't see) before a request fires.
    if (localStorage.getItem("fo:role") !== "admin") {
      throw redirect({ to: "/login" });
    }
  },
  component: () => <Outlet />,
});
