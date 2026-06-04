import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Truck, Loader2, Lock, CheckCircle2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase, USE_SUPABASE } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/reset-password")({
  head: () => ({ meta: [{ title: "Set new password — FleetOps CRM" }] }),
  component: ResetPasswordPage,
});

// The link in the reset email lands here with #access_token=...&type=recovery
// in the URL fragment. The Supabase JS client auto-detects that and emits a
// PASSWORD_RECOVERY auth state change. Until that fires the user can't yet
// update their password, so we render a "verifying link" spinner and only
// show the form once we know the recovery session is active.
function ResetPasswordPage() {
  const { updatePassword } = useAuth();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"verifying" | "ready" | "saving" | "done">(
    USE_SUPABASE ? "verifying" : "ready",
  );
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<{ pw?: string; confirm?: string; form?: string }>({});

  useEffect(() => {
    if (!USE_SUPABASE || !supabase) return;
    // Listen for PASSWORD_RECOVERY. Supabase fires it after the URL fragment
    // is parsed and the recovery session is established.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setPhase("ready");
    });
    // Also try the existing session — if the page was reloaded after the
    // recovery hash was consumed, the session is already active.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session && phase === "verifying") setPhase("ready");
    });
    // If neither fires within 4s, the link is probably stale or malformed.
    const stale = setTimeout(() => {
      setPhase((p) => (p === "verifying" ? "ready" : p));
      // Don't block the form — let the user try anyway. updateUser will
      // return a clear error if there's no recovery session.
    }, 4000);
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(stale);
    };
    // We intentionally read `phase` from the latest closure; lint exception
    // because adding it to deps would cause the effect to re-fire on every
    // phase change and tear down the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof err = {};
    if (pw.length < 6) errs.pw = "Min 6 characters";
    if (pw !== confirm) errs.confirm = "Passwords don't match";
    setErr(errs);
    if (Object.keys(errs).length) return;
    setPhase("saving");
    const { error } = await updatePassword(pw);
    if (error) {
      setErr({ form: error });
      toast.error(error);
      setPhase("ready");
      return;
    }
    setPhase("done");
    toast.success("Password updated");
    // Sign out so the next sign-in uses the new password explicitly.
    if (USE_SUPABASE && supabase) {
      await supabase.auth.signOut().catch(() => {});
    }
    setTimeout(() => navigate({ to: "/login" }), 1500);
  }

  return (
    <div className="min-h-screen grid place-items-center bg-background p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-md bg-amber-brand grid place-items-center">
            <Truck className="w-5 h-5 text-amber-brand-foreground" />
          </div>
          <div className="font-bold text-lg tracking-tight">FleetOps CRM</div>
        </div>

        {phase === "verifying" && (
          <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
            <p className="text-sm">Verifying reset link…</p>
          </div>
        )}

        {phase === "done" && (
          <div className="flex flex-col items-center gap-3 py-8">
            <CheckCircle2 className="w-10 h-10 text-success" />
            <div className="text-center">
              <h1 className="text-lg font-semibold">Password updated</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Redirecting to sign in…
              </p>
            </div>
          </div>
        )}

        {(phase === "ready" || phase === "saving") && (
          <>
            <div>
              <h1 className="text-2xl font-bold">Set a new password</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Choose a new password for your FleetOps account.
              </p>
            </div>
            <form onSubmit={onSubmit} noValidate className="space-y-4">
              <div>
                <Label htmlFor="new-password">New password</Label>
                <div className="relative mt-1.5">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="At least 6 characters"
                    aria-invalid={!!err.pw}
                    className={cn("h-11 pl-9", err.pw && "border-danger focus-visible:ring-danger")}
                    data-testid="new-password"
                  />
                </div>
                {err.pw && <p className="text-xs text-danger mt-1">{err.pw}</p>}
              </div>
              <div>
                <Label htmlFor="confirm-password">Confirm password</Label>
                <div className="relative mt-1.5">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="Re-enter password"
                    aria-invalid={!!err.confirm}
                    className={cn(
                      "h-11 pl-9",
                      err.confirm && "border-danger focus-visible:ring-danger",
                    )}
                    data-testid="confirm-password"
                  />
                </div>
                {err.confirm && (
                  <p className="text-xs text-danger mt-1">{err.confirm}</p>
                )}
              </div>
              {err.form && (
                <p className="text-xs text-danger" data-testid="reset-password-error">
                  {err.form}
                </p>
              )}
              <Button
                type="submit"
                disabled={phase === "saving"}
                data-testid="submit-new-password"
                className="w-full h-11 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold"
              >
                {phase === "saving" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Updating…
                  </>
                ) : (
                  "Update password"
                )}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
