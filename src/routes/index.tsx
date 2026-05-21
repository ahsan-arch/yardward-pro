import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    if (typeof window !== "undefined") {
      const authed = localStorage.getItem("fo:authed") === "1";
      const role = localStorage.getItem("fo:role") || "admin";
      if (!authed) throw redirect({ to: "/login" });
      throw redirect({
        to: role === "driver" ? "/driver" : role === "mechanic" ? "/mechanic" : "/admin",
      });
    }
    throw redirect({ to: "/login" });
  },
  component: () => null,
});
