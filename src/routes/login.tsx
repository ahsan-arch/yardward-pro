import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Truck, Shield, Wrench, Loader2, Moon, Sun, type LucideIcon } from "lucide-react";
import { BrandMark } from "@/components/crm/BrandMark";
import { useApp, type Role } from "@/contexts/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — Engage Hydrovac CRM" }] }),
  component: LoginPage,
});

import { DEMO_MODE } from "@/lib/demo-mode";

function LoginPage() {
  const { login, signIn, theme, toggleTheme, sendPasswordReset } = useApp();
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>("admin");
  const [email, setEmail] = useState(DEMO_MODE ? "alex@fleetops.co" : "");
  const [password, setPassword] = useState(DEMO_MODE ? "demo1234" : "");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ email?: string; password?: string; form?: string }>({});
  // Forgot-password inline flow. Expanded shows an email input + Send button
  // below the password field; submit fires sendPasswordReset and toasts. We
  // deliberately do NOT distinguish "email not found" — that would leak which
  // accounts exist. Always show "If that address is registered, a reset link
  // is on its way."
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSending, setForgotSending] = useState(false);

  const presets: Record<Role, string> = {
    admin: "alex@fleetops.co",
    driver: "tom@fleetops.co",
    mechanic: "jamie@fleetops.co",
  };

  function pickRole(r: Role) {
    setRole(r);
    // Only auto-fill the demo email when demo mode is on. In production
    // the role chip is just a hint of "what kind of account am I"; the
    // email stays whatever the user typed.
    if (DEMO_MODE) setEmail(presets[r]);
  }

  // Demo-creds carve-out: the three preset emails below are UI hints used by
  // E2E tests and product demos. They are NOT seeded in Supabase Auth in
  // production, so calling supabase.auth.signInWithPassword with them would
  // fail with "Invalid login credentials". When we detect the exact demo
  // tuple (preset email + "demo1234") we short-circuit the auth flow,
  // hydrate the legacy localStorage flags directly, and route to the role's
  // dashboard. Any other email — including real Supabase users — still
  // flows through AuthContext.signIn → supabase.auth.signInWithPassword.
  const DEMO_PASSWORD = "demo1234";
  const DEMO_ROLE_BY_EMAIL: Record<string, Role> = {
    "alex@fleetops.co": "admin",
    "tom@fleetops.co": "driver",
    "jamie@fleetops.co": "mechanic",
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof err = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) errs.email = "Enter a valid email";
    if (password.length < 8) errs.password = "Min 8 characters";
    setErr(errs);
    if (Object.keys(errs).length) return;

    // Demo short-circuit — only runs in dev / VITE_DEMO_MODE=true. In
    // production this entire block is dead code (DEMO_MODE is false), so
    // typing alex@fleetops.co / demo1234 falls through to the real Supabase
    // signIn path below and gets rejected with "Invalid login credentials".
    if (DEMO_MODE) {
      const demoRole = DEMO_ROLE_BY_EMAIL[email.trim().toLowerCase()];
      if (demoRole && password === DEMO_PASSWORD) {
        try {
          localStorage.setItem("fo:authed", "1");
          localStorage.setItem("fo:role", demoRole);
        } catch {
          /* storage may be unavailable in some embedded webviews */
        }
        login(demoRole);
        toast.success("Welcome back to Engage Hydrovac CRM");
        navigate({
          to: demoRole === "driver" ? "/driver" : demoRole === "mechanic" ? "/mechanic" : "/admin",
        });
        return;
      }
    }

    setLoading(true);
    // signIn is Supabase-backed when env vars present, otherwise legacy mock.
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) {
      setErr({ form: error });
      toast.error(error);
      return;
    }
    // Legacy fallback: when no Supabase env is set, hydrate role from the picker.
    if (!import.meta.env.VITE_SUPABASE_URL) login(role);
    toast.success("Welcome back to Engage Hydrovac CRM");
    // Prefer the user's actual role from Supabase (written to localStorage
    // by AuthContext.signIn) over the form picker, since the picker is just
    // a UI hint and may not match the real profile.role.
    const resolved =
      typeof window !== "undefined"
        ? ((localStorage.getItem("fo:role") as Role | null) ?? role)
        : role;
    navigate({
      to: resolved === "driver" ? "/driver" : resolved === "mechanic" ? "/mechanic" : "/admin",
    });
  }

  async function sendForgot() {
    const target = (forgotEmail || email).trim();
    if (!/^\S+@\S+\.\S+$/.test(target)) {
      toast.error("Enter a valid email to receive the reset link");
      return;
    }
    setForgotSending(true);
    const { error } = await sendPasswordReset(target);
    setForgotSending(false);
    if (error) {
      // The AuthContext.sendPasswordReset already handles the demo-creds
      // carve-out and returns a friendly message; surface as-is.
      toast.error(error);
      return;
    }
    // Generic confirmation — same message whether the email exists or not,
    // so we don't leak which addresses are registered.
    toast.success(
      `If ${target} has an account, a reset link is on its way. Check your inbox + spam.`,
    );
    setForgotOpen(false);
    setForgotEmail("");
  }

  const opts: { value: Role; label: string; icon: LucideIcon; desc: string }[] = [
    { value: "admin", label: "Admin", icon: Shield, desc: "Management" },
    { value: "driver", label: "Driver", icon: Truck, desc: "On-site" },
    { value: "mechanic", label: "Mechanic", icon: Wrench, desc: "Workshop" },
  ];

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Left: hero */}
      <div className="hidden lg:flex flex-col justify-between p-10 bg-navy text-navy-foreground relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)",
            backgroundSize: "24px 24px",
          }}
        />
        <div className="relative flex items-center gap-2">
          <BrandMark size="lg" />
          <div className="font-bold text-lg tracking-tight">Engage Hydrovac CRM</div>
        </div>
        <div className="relative space-y-4 max-w-md">
          <h2 className="text-4xl font-bold leading-tight">
            Run the yard.
            <br />
            From the cab to the office.
          </h2>
          <p className="text-navy-foreground/70 leading-relaxed">
            Schedule jobs, dispatch trucks, capture signed work orders on-site, and approve invoices
            in one tight loop.
          </p>
          <div className="flex gap-6 pt-4 font-mono text-xs">
            <div>
              <div className="text-2xl font-bold text-amber-brand">120+</div>
              <div className="text-navy-foreground/60">Fleets</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-amber-brand">99.8%</div>
              <div className="text-navy-foreground/60">Uptime</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-amber-brand">14k</div>
              <div className="text-navy-foreground/60">Jobs/mo</div>
            </div>
          </div>
        </div>
        <div className="relative text-xs text-navy-foreground/50 font-mono">© 2025 Engage Hydrovac</div>
      </div>

      {/* Right: form */}
      <div className="flex flex-col p-6 sm:p-10">
        <div className="flex justify-between items-center">
          <div className="lg:hidden flex items-center gap-2">
            <BrandMark />
            <div className="font-bold">Engage Hydrovac CRM</div>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme} className="ml-auto">
            {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </Button>
        </div>

        <div className="flex-1 flex items-center">
          <form onSubmit={submit} noValidate className="w-full max-w-md mx-auto space-y-6">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">Sign in</h1>
              <p className="text-sm text-muted-foreground mt-1">
                {DEMO_MODE
                  ? "Choose your role to continue. This is a demo — any password 6+ chars works."
                  : "Welcome back."}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {opts.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  onClick={() => pickRole(o.value)}
                  className={cn(
                    "flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-all",
                    role === o.value
                      ? "border-amber-brand bg-amber-brand/5"
                      : "border-border hover:border-muted-foreground/30",
                  )}
                >
                  <o.icon className={cn("w-5 h-5", role === o.value && "text-amber-brand")} />
                  <div className="text-sm font-semibold">{o.label}</div>
                  <div className="text-[10px] text-muted-foreground font-mono uppercase">
                    {o.desc}
                  </div>
                </button>
              ))}
            </div>

            <div className="space-y-3">
              <div>
                <Label htmlFor="email">Work email</Label>
                {/* type="text" (not "email") so the browser's HTML5 validator
                    doesn't pre-empt our React error copy. inputMode="email"
                    keeps the mobile keyboard correct. autoComplete still
                    hints to password managers. */}
                <Input
                  id="email"
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-invalid={!!err.email}
                  aria-describedby={err.email ? "email-error" : undefined}
                  className={cn(
                    "h-11 mt-1.5",
                    err.email && "border-danger focus-visible:ring-danger",
                  )}
                />
                {err.email && (
                  <p id="email-error" className="text-xs text-danger mt-1">
                    {err.email}
                  </p>
                )}
              </div>
              <div>
                <div className="flex justify-between items-center">
                  <Label htmlFor="password">Password</Label>
                  <button
                    type="button"
                    onClick={() => {
                      setForgotOpen((v) => !v);
                      if (!forgotEmail) setForgotEmail(email);
                    }}
                    data-testid="forgot-password-toggle"
                    className="text-xs text-amber-brand hover:underline"
                  >
                    Forgot?
                  </button>
                </div>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!err.password}
                  aria-describedby={err.password ? "password-error" : undefined}
                  className={cn(
                    "h-11 mt-1.5",
                    err.password && "border-danger focus-visible:ring-danger",
                  )}
                />
                {err.password && (
                  <p id="password-error" className="text-xs text-danger mt-1">
                    {err.password}
                  </p>
                )}
              </div>
              {forgotOpen && (
                <div
                  className="border border-border rounded-md p-3 bg-muted/30 space-y-2"
                  data-testid="forgot-password-panel"
                >
                  <p className="text-xs text-muted-foreground">
                    Enter the email on your account. We'll send a reset link.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      type="text"
                      inputMode="email"
                      autoComplete="email"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      placeholder="you@company.com"
                      data-testid="forgot-password-email"
                      className="h-9 flex-1"
                    />
                    <Button
                      type="button"
                      disabled={forgotSending}
                      onClick={() => void sendForgot()}
                      data-testid="forgot-password-submit"
                      className="h-9 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-medium"
                    >
                      {forgotSending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Send link"}
                    </Button>
                  </div>
                </div>
              )}
              {err.form && (
                <p className="text-xs text-danger -mt-1 px-1" data-testid="login-error">
                  {err.form}
                </p>
              )}
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-amber-brand text-amber-brand-foreground hover:bg-amber-brand/90 font-semibold"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Signing in…
                </>
              ) : (
                "Sign in to Engage Hydrovac CRM"
              )}
            </Button>

            <p className="text-xs text-center text-muted-foreground">
              Don't have an account?{" "}
              <span className="text-amber-brand font-medium cursor-pointer hover:underline">
                Request access
              </span>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
