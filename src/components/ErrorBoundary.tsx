import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { reportErrorToServer } from "@/lib/error-capture";

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; error: Error | null };

const RELOAD_ATTEMPTS_KEY = "yp_eb_reload_attempts";
const RELOAD_ATTEMPTS_WINDOW_MS = 30_000;
const RELOAD_ATTEMPTS_MAX = 2;

// Per-tab dedup so an error that re-mounts the boundary doesn't generate a
// fresh RPC call every time React retries rendering.
const reportedSignatures = new Set<string>();

function readReloadAttempts(): { count: number; firstAt: number } {
  try {
    const raw = sessionStorage.getItem(RELOAD_ATTEMPTS_KEY);
    if (!raw) return { count: 0, firstAt: 0 };
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.firstAt > RELOAD_ATTEMPTS_WINDOW_MS) {
      return { count: 0, firstAt: 0 };
    }
    return parsed;
  } catch {
    return { count: 0, firstAt: 0 };
  }
}

function bumpReloadAttempts(): number {
  try {
    const prev = readReloadAttempts();
    const next = {
      count: prev.count + 1,
      firstAt: prev.firstAt || Date.now(),
    };
    sessionStorage.setItem(RELOAD_ATTEMPTS_KEY, JSON.stringify(next));
    return next.count;
  } catch {
    return 1;
  }
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[ErrorBoundary]", error, info.componentStack);
    const sig = `${error.message}:${(error.stack ?? "").slice(0, 200)}`;
    if (reportedSignatures.has(sig)) return;
    reportedSignatures.add(sig);
    void reportErrorToServer({
      severity: "error",
      errorCode: "REACT_ERROR_BOUNDARY",
      message: error.message || "Unknown render error",
      stack: error.stack ?? null,
      context: {
        componentStack: info.componentStack ?? null,
      },
    });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const stuck = readReloadAttempts().count >= RELOAD_ATTEMPTS_MAX;
      return (
        <div className="min-h-[400px] grid place-items-center p-4">
          <div className="max-w-md text-center bg-card border border-danger/30 rounded-lg p-6">
            <AlertTriangle className="w-10 h-10 text-danger mx-auto" />
            <h1 className="text-lg font-bold mt-3">Something went wrong</h1>
            <p className="text-sm text-muted-foreground mt-2 break-words">
              Our team has been notified.
            </p>
            {stuck ? (
              <a
                href="/"
                onClick={() => {
                  try {
                    sessionStorage.removeItem(RELOAD_ATTEMPTS_KEY);
                  } catch {
                    /* ignore */
                  }
                }}
                className="inline-block mt-4 px-4 py-2 rounded-md bg-amber-brand text-amber-brand-foreground text-sm font-semibold"
              >
                Go to home
              </a>
            ) : (
              <button
                onClick={() => {
                  bumpReloadAttempts();
                  this.setState({ hasError: false, error: null });
                  location.reload();
                }}
                className="mt-4 px-4 py-2 rounded-md bg-amber-brand text-amber-brand-foreground text-sm font-semibold"
              >
                Reload
              </button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
