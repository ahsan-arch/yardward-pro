import { createFileRoute, useRouter } from "@tanstack/react-router";

// Test-only route that throws so Playwright can exercise the router
// ErrorComponent ("Try again" recovery button) without having to trigger a
// real bug. Gated on import.meta.env.DEV so this route is a no-op in
// production builds — the throw will not fire and the page just shows a stub.
//
// We throw in beforeLoad (not during render) so TanStack Router's
// errorComponent renders the fallback instead of bubbling the error up into
// the inner <ErrorBoundary> class component that wraps <Outlet/>. We attach
// errorComponent directly to this route so the route-level boundary owns the
// fallback — the class ErrorBoundary would otherwise win the race and render
// its own "Reload" UI.
//
// The test flips window.__fo_test_force_error to true, navigates here, asserts
// the error fallback, flips the flag back to false, then clicks Try again and
// re-renders this route without the throw.

declare global {
  interface Window {
    __fo_test_force_error?: boolean;
  }
}

export const Route = createFileRoute("/debug/error-boundary-trigger")({
  beforeLoad: () => {
    if (import.meta.env.DEV && typeof window !== "undefined" && window.__fo_test_force_error) {
      throw new Error("Forced beforeLoad error for ErrorBoundary test");
    }
  },
  component: DebugErrorBoundaryTrigger,
  errorComponent: DebugErrorComponent,
});

function DebugErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-4 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function DebugErrorBoundaryTrigger() {
  return (
    <div data-testid="debug-error-boundary-trigger" className="p-8">
      <h1 className="text-lg font-semibold">Debug: ErrorBoundary trigger</h1>
      <p className="text-sm text-muted-foreground mt-2">
        Set <code>window.__fo_test_force_error = true</code> and reload to throw.
      </p>
    </div>
  );
}
