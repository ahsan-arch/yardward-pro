import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Truck, Shield, Wrench, Loader2, Moon, Sun } from "lucide-react";
import { useApp, type Role } from "@/contexts/AppContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Sign in — FleetOps CRM" }] }),
  component: LoginPage,
});

function LoginPage() {
  const { login, signIn, theme, toggleTheme } = useApp();
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>("admin");
  const [email, setEmail] = useState("alex@fleetops.co");
  const [password, setPassword] = useState("demo1234");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<{ email?: string; password?: string; form?: string }>({});

  const presets: Record<Role, string> = {
    admin: "alex@fleetops.co",
    driver: "tom@fleetops.co",
    mechanic: "jamie@fleetops.co",
  };

  function pickRole(r: Role) {
    setRole(r);
    setEmail(presets[r]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof err = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) errs.email = "Enter a valid email";
    if (password.length < 6) errs.password = "Min 6 characters";
    setErr(errs);
    if (Object.keys(errs).length) return;
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
    toast.success("Welcome back to FleetOps");
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

  const opts: { value: Role; label: string; icon: any; desc: string }[] = [
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
          <div className="w-9 h-9 rounded-md bg-amber-brand grid place-items-center">
            <Truck className="w-5 h-5 text-amber-brand-foreground" />
          </div>
          <div className="font-bold text-lg tracking-tight">FleetOps CRM</div>
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
        <div className="relative text-xs text-navy-foreground/50 font-mono">
          © 2025 FleetOps Industries
        </div>
      </div>

      {/* Right: form */}
      <div className="flex flex-col p-6 sm:p-10">
        <div className="flex justify-between items-center">
          <div className="lg:hidden flex items-center gap-2">
            <div className="w-8 h-8 rounded-md bg-amber-brand grid place-items-center">
              <Truck className="w-4 h-4 text-amber-brand-foreground" />
            </div>
            <div className="font-bold">FleetOps</div>
          </div>
          <Button variant="ghost" size="icon" onClick={toggleTheme} className="ml-auto">
            {theme === "light" ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
          </Button>
        </div>

        <div className="flex-1 flex items-center">
          <form onSubmit={submit} className="w-full max-w-md mx-auto space-y-6">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold">Sign in</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Choose your role to continue. This is a demo — any password 6+ chars works.
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
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={cn(
                    "h-11 mt-1.5",
                    err.email && "border-danger focus-visible:ring-danger",
                  )}
                />
                {err.email && <p className="text-xs text-danger mt-1">{err.email}</p>}
              </div>
              <div>
                <div className="flex justify-between items-center">
                  <Label htmlFor="password">Password</Label>
                  <button type="button" className="text-xs text-amber-brand hover:underline">
                    Forgot?
                  </button>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={cn(
                    "h-11 mt-1.5",
                    err.password && "border-danger focus-visible:ring-danger",
                  )}
                />
                {err.password && <p className="text-xs text-danger mt-1">{err.password}</p>}
              </div>
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
                "Sign in to FleetOps"
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
