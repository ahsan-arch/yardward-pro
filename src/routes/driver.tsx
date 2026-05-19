import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/driver")({
  beforeLoad: () => {
    if (typeof window !== "undefined" && localStorage.getItem("fo:authed") !== "1") {
      throw redirect({ to: "/login" });
    }
  },
  component: () => <Outlet />,
});
