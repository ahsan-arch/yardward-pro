import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, useRouter, HeadContent, Scripts, Link } from "@tanstack/react-router";
import appCss from "../styles.css?url";
import { AppProvider, useApp } from "@/contexts/AppContext";
import { RoleSwitcher } from "@/components/crm/RoleSwitcher";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">Page not found.</p>
        <Link to="/" className="inline-block mt-6 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium">Go home</Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button onClick={() => { router.invalidate(); reset(); }} className="mt-4 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium">Try again</button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "FleetOps CRM — Trucking & Haulage Operations" },
      { name: "description", content: "Field-operations CRM for trucking and haulage. Schedule jobs, manage drivers, vehicles, work orders and parts." },
      { property: "og:title", content: "FleetOps CRM — Trucking & Haulage Operations" },
      { name: "twitter:title", content: "FleetOps CRM — Trucking & Haulage Operations" },
      { property: "og:description", content: "Field-operations CRM for trucking and haulage. Schedule jobs, manage drivers, vehicles, work orders and parts." },
      { name: "twitter:description", content: "Field-operations CRM for trucking and haulage. Schedule jobs, manage drivers, vehicles, work orders and parts." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/bc78272b-2124-472b-bd5c-0195fc2f6199/id-preview-610394ae--7352fdf1-63d9-455e-99b2-edc17dbee6ff.lovable.app-1779199524458.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/bc78272b-2124-472b-bd5c-0195fc2f6199/id-preview-610394ae--7352fdf1-63d9-455e-99b2-edc17dbee6ff.lovable.app-1779199524458.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  );
}

function Chrome() {
  const { authed } = useApp();
  return (
    <>
      {authed && <RoleSwitcher />}
      <Outlet />
      <Toaster position="top-right" />
    </>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <Chrome />
      </AppProvider>
    </QueryClientProvider>
  );
}
