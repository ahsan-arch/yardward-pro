import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

type Props = { children: ReactNode; fallback?: ReactNode };
type State = { hasError: boolean; error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Hook for future Sentry / Logflare wiring
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="min-h-[400px] grid place-items-center p-4">
          <div className="max-w-md text-center bg-card border border-danger/30 rounded-lg p-6">
            <AlertTriangle className="w-10 h-10 text-danger mx-auto" />
            <h1 className="text-lg font-bold mt-3">Something went wrong</h1>
            <p className="text-sm text-muted-foreground mt-2 break-words">
              {this.state.error?.message ?? "Unknown error"}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                location.reload();
              }}
              className="mt-4 px-4 py-2 rounded-md bg-amber-brand text-amber-brand-foreground text-sm font-semibold"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
