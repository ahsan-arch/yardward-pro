import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { supabase, USE_SUPABASE } from "@/lib/supabase";
import { api } from "@/lib/api";
import { clearDriverTokenSession, readDriverTokenSession } from "@/hooks/use-driver-token-scope";
import {
  clearStoredAdminTabs,
  readStoredAdminTabs,
  resolveAllowedTabs,
  writeStoredAdminTabs,
  type AllowedTabs,
} from "@/lib/admin-tabs";

// When the tab returns to the foreground after being hidden longer than this,
// we re-validate the active driver token against the server. Short blurs (a
// quick tab switch, dragging a window) don't trigger the round-trip — the
// 60s threshold keeps the validate RPC quiet for normal use while still
// catching the case where a phone sits face-down for hours and the link has
// since been revoked by an admin.
const DRIVER_TOKEN_REVALIDATE_HIDDEN_MS = 60_000;
const EXPIRES_KEY = "fo:driver-token-expires-at";

// Minimum gap between admin-permission refetches on window focus. Same
// rationale as the driver-token threshold above: keep the round-trip quiet
// during normal alt-tabbing while still picking up an owner's permission
// change within a minute of the restricted admin returning to the tab.
const ADMIN_TABS_REFRESH_MIN_MS = 60_000;

// Enriched profile select: the three access columns + the named role's tab
// list via the profiles -> admin_roles FK embed (one round-trip).
const PROFILE_ACCESS_SELECT =
  "id, name, email, role, is_owner, admin_role_id, allowed_tabs_override, admin_roles(allowed_tabs), is_workshop_manager";

export type Role = "admin" | "driver" | "mechanic";
export type Theme = "light" | "dark";

type AppUser = { id: string; name: string; email: string };

type Ctx = {
  role: Role;
  setRole: (r: Role) => void;
  theme: Theme;
  toggleTheme: () => void;
  authed: boolean;
  loading: boolean;
  user: AppUser;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  // Sends a password-reset email via supabase.auth.resetPasswordForEmail.
  // The link in the email lands on /reset-password where the user enters
  // a new password (handled by the route's PASSWORD_RECOVERY onAuthStateChange).
  // Returns { error: null } on success, { error: "..." } on failure.
  sendPasswordReset: (email: string) => Promise<{ error: string | null }>;
  // After the user lands on /reset-password from the email link, this writes
  // the new password against the recovery session.
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>;
  logout: () => Promise<void>;
  // Legacy: lets the demo-mode role switcher swap personas without a real sign-in.
  login: (r: Role) => void;
  // True when the only reason we consider the visitor authenticated is a
  // sessionStorage-backed driver-token landing (the /t/<token> bridge).
  // UI surfaces that should NOT be available to a token-only session
  // (profile edit, password change, role switcher) read this flag.
  isDriverTokenSession: boolean;
  // Owner admins keep full access and are the only ones who can manage
  // which tabs other admins see (Settings -> Users & roles).
  isOwner: boolean;
  // Effective admin tab set for the signed-in admin. "all" for owners, for
  // admins with no role/override assigned, and whenever permission data is
  // unavailable (fail open — server triggers protect the assignment data).
  allowedTabs: AllowedTabs;
  // Mechanic-tier flag: gates the "All work orders" overview tab on
  // /mechanic/work-orders (client feedback — the assigned-to-me queue has no
  // shop-wide view). Meaningless for admin/driver sessions.
  isWorkshopManager: boolean;
};

const AuthCtx = createContext<Ctx | null>(null);

const MOCK_USERS: Record<Role, AppUser> = {
  admin: { id: "A-01", name: "Alex Chen", email: "alex@fleetops.co" },
  driver: { id: "D-01", name: "Tom Morrison", email: "tom@fleetops.co" },
  mechanic: { id: "M-01", name: "Jamie Reyes", email: "jamie@fleetops.co" },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>("admin");
  const [theme, setTheme] = useState<Theme>("light");
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(USE_SUPABASE);
  const [user, setUser] = useState<AppUser>(MOCK_USERS.admin);
  const [isDriverTokenSession, setIsDriverTokenSession] = useState(false);
  // Seeded synchronously from localStorage so the first client paint of the
  // admin sidebar is already filtered for restricted admins (no flash of
  // forbidden tabs), and unchanged ("all") for everyone else.
  const [isOwner, setIsOwner] = useState(!USE_SUPABASE);
  const [allowedTabs, setAllowedTabs] = useState<AllowedTabs>(() => readStoredAdminTabs());
  const [isWorkshopManager, setIsWorkshopManager] = useState(!USE_SUPABASE);

  // Theme hydration (independent of auth mode)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = (localStorage.getItem("fo:theme") as Theme) || "light";
    setTheme(t);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("fo:theme", theme);
  }, [theme]);

  // Driver-token-session hydration. Runs independently of the Supabase path
  // because a /t/<token> visitor never goes through supabase.auth — they
  // arrive via the tokenized bridge and we want the route guards to see
  // `authed=true` without writing the legacy localStorage fo:authed flag
  // (which used to persist the elevation forever).
  useEffect(() => {
    if (typeof window === "undefined") return;
    function syncTokenSession() {
      const ts = readDriverTokenSession();
      if (ts) {
        setIsDriverTokenSession(true);
        // Token sessions never override a real Supabase login (a logged-in
        // admin who happened to scan a driver QR code on their own phone
        // shouldn't be demoted to driver). Only flip role/authed when we
        // haven't already hydrated a real session.
        setAuthed((prev) => prev || true);
        setRoleState((prev) => (prev === "admin" || prev === "mechanic" ? prev : "driver"));
      } else {
        setIsDriverTokenSession(false);
      }
    }
    syncTokenSession();
    window.addEventListener("storage", syncTokenSession);
    window.addEventListener("fo:driver-token-session", syncTokenSession);
    return () => {
      window.removeEventListener("storage", syncTokenSession);
      window.removeEventListener("fo:driver-token-session", syncTokenSession);
    };
  }, []);

  // Tab-focus revalidate for /t/<token> driver sessions.
  //
  // When a tokenized driver session is active we register visibilitychange
  // + focus listeners that re-check the token against the server whenever
  // the tab returns visible after being hidden for >60s. The check protects
  // against the case where an admin revokes a link (or it naturally expires)
  // while the driver's phone sat untouched on the dashboard — without this,
  // they'd keep submitting against a token the server has already burned.
  //
  // Why this lives in AuthContext instead of DriverLayout:
  //   - Some token-scoped routes (e.g. /driver/tickets) render OUTSIDE the
  //     DriverShell when entered via /t/<token>, so a layout-mounted effect
  //     would miss them.
  //   - AuthContext already owns the isDriverTokenSession flag, so we can
  //     gate registration on a single piece of truth.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isDriverTokenSession) return;

    let cancelled = false;
    let lastHiddenAt: number | null =
      typeof document !== "undefined" && document.visibilityState === "hidden"
        ? Date.now()
        : null;
    // Single-flight guard — visibilitychange and focus can both fire on
    // resume, and we don't want two parallel validate RPCs racing each other.
    let revalidateInFlight = false;
    // When the tab returns visible but navigator.onLine === false we defer
    // the round-trip; the `online` listener picks it up on reconnect.
    let pendingOfflineRevalidate = false;

    async function runRevalidate() {
      if (cancelled || revalidateInFlight) return;
      const ts = readDriverTokenSession();
      if (!ts) return; // Session already cleared elsewhere (consume / logout).
      revalidateInFlight = true;
      try {
        const result = await api.validateDriverToken(ts.token);
        if (cancelled) return;
        if (!result.valid) {
          // Expired, revoked, or unknown server-side. Burn the local session
          // so route guards bounce on the next navigation, then surface a
          // clear toast and send the user to /login. window.location is used
          // (vs. router.navigate) so we don't depend on a router context
          // being mounted here — and so the fresh load drops any in-memory
          // state the now-invalid session may have populated.
          clearDriverTokenSession();
          setIsDriverTokenSession(false);
          setAuthed(false);
          toast.error("Your session has expired — please request a new link");
          try {
            window.location.assign("/login");
          } catch {
            /* ignore — toast already informed the user */
          }
          return;
        }
        // Success: silently refresh the stored expiry if the server returned
        // a later one (e.g. a sliding-window extension). No toast on success
        // — drivers shouldn't be pinged for healthy revalidates.
        const fresh = result.token?.expiresAt;
        if (fresh) {
          const currentStored = sessionStorage.getItem(EXPIRES_KEY);
          if (!currentStored || new Date(fresh).getTime() > new Date(currentStored).getTime()) {
            try {
              sessionStorage.setItem(EXPIRES_KEY, fresh);
            } catch {
              /* sessionStorage write can throw in some embedded webviews */
            }
          }
        }
      } catch {
        // Network error / Supabase unavailable. We don't tear the session
        // down on a transient failure — that would punish a driver whose
        // van just rolled through a tunnel. The next visibility/focus
        // event (or the online listener) will retry.
      } finally {
        revalidateInFlight = false;
      }
    }

    function maybeRevalidate() {
      if (cancelled) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        // Defer until the `online` event fires.
        pendingOfflineRevalidate = true;
        return;
      }
      void runRevalidate();
    }

    function onVisibilityChange() {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") {
        lastHiddenAt = Date.now();
        return;
      }
      // visibilityState === "visible"
      if (lastHiddenAt == null) return;
      const hiddenMs = Date.now() - lastHiddenAt;
      lastHiddenAt = null;
      if (hiddenMs < DRIVER_TOKEN_REVALIDATE_HIDDEN_MS) return;
      maybeRevalidate();
    }

    function onFocus() {
      // Focus may fire on a same-tab refocus where visibilityState never
      // flipped (e.g. clicking back into the window from another app on
      // desktop). Use the same hidden-duration gate so we don't validate
      // on every alt-tab.
      if (lastHiddenAt == null) return;
      const hiddenMs = Date.now() - lastHiddenAt;
      lastHiddenAt = null;
      if (hiddenMs < DRIVER_TOKEN_REVALIDATE_HIDDEN_MS) return;
      maybeRevalidate();
    }

    function onOnline() {
      if (!pendingOfflineRevalidate) return;
      pendingOfflineRevalidate = false;
      void runRevalidate();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
    };
  }, [isDriverTokenSession]);

  // Admin tab-permission refresh on window focus. If an owner restricts (or
  // widens) an admin's access while that admin is signed in, the change is
  // picked up the next time their tab regains focus — throttled to once per
  // ADMIN_TABS_REFRESH_MIN_MS. Silent on failure: the current (possibly
  // stale) set stays in effect until the next successful refresh, and the
  // server-side triggers remain the real authority over the permission data.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!USE_SUPABASE || !supabase) return;
    if (!authed || role !== "admin" || isDriverTokenSession) return;

    let cancelled = false;
    let inFlight = false;
    // Hydration just populated the set — don't refetch on the mount-focus.
    let lastRunAt = Date.now();

    async function refresh() {
      if (cancelled || inFlight || !supabase) return;
      if (Date.now() - lastRunAt < ADMIN_TABS_REFRESH_MIN_MS) return;
      lastRunAt = Date.now();
      inFlight = true;
      try {
        const { data: p, error } = await supabase
          .from("profiles")
          .select("is_owner, allowed_tabs_override, admin_roles(allowed_tabs)")
          .eq("id", user.id)
          .single();
        if (cancelled || error || !p) return;
        const allowed = resolveAllowedTabs({
          isOwner: Boolean(p.is_owner),
          override: p.allowed_tabs_override ?? null,
          roleTabs: p.admin_roles?.allowed_tabs ?? null,
        });
        setIsOwner(Boolean(p.is_owner));
        setAllowedTabs(allowed);
        writeStoredAdminTabs(allowed);
      } catch {
        /* transient — retry on a later focus */
      } finally {
        inFlight = false;
      }
    }

    function onFocus() {
      void refresh();
    }
    function onVisibilityChange() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refresh();
      }
    }

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [authed, role, isDriverTokenSession, user.id]);

  // Auth hydration
  useEffect(() => {
    if (!USE_SUPABASE || !supabase) {
      // Legacy mock-mode hydration
      if (typeof window === "undefined") return;
      const r = (localStorage.getItem("fo:role") as Role) || "admin";
      const a = localStorage.getItem("fo:authed") === "1";
      setRoleState(r);
      setAuthed(a);
      if (a) setUser(MOCK_USERS[r]);
      // Demo personas always get the full owner experience.
      setIsOwner(true);
      setAllowedTabs("all");
      setIsWorkshopManager(true);
      return;
    }

    let cancelled = false;

    async function hydrateFromSession(session: { user: { id: string; email?: string } } | null) {
      if (!supabase) return;
      if (!session) {
        if (!cancelled) {
          setAuthed(false);
          setLoading(false);
          // Clear the legacy guard flag so route beforeLoad redirects work.
          try {
            localStorage.removeItem("fo:authed");
            localStorage.removeItem("fo:role");
          } catch {
            /* ignore */
          }
          clearStoredAdminTabs();
        }
        return;
      }
      const enriched = await supabase
        .from("profiles")
        .select(PROFILE_ACCESS_SELECT)
        .eq("id", session.user.id)
        .single();
      let profile: {
        id: string;
        name: string;
        email: string;
        role: string;
        is_owner?: boolean;
        allowed_tabs_override?: string[] | null;
        admin_roles?: { allowed_tabs: string[] } | null;
        is_workshop_manager?: boolean;
      } | null = enriched.data;
      let error = enriched.error;
      if (error) {
        // Fall back to the pre-access-columns select so an environment where
        // the owner/roles SQL hasn't been applied yet degrades to today's
        // behavior (full access) instead of mass-logging admins out — an
        // enriched-select failure would otherwise flip authed=false below.
        const legacy = await supabase
          .from("profiles")
          .select("id, name, email, role")
          .eq("id", session.user.id)
          .single();
        profile = legacy.data;
        error = legacy.error;
      }
      if (cancelled) return;
      if (error || !profile) {
        setAuthed(false);
        setLoading(false);
        return;
      }
      const allowed = resolveAllowedTabs({
        isOwner: Boolean(profile.is_owner),
        override: profile.allowed_tabs_override ?? null,
        roleTabs: profile.admin_roles?.allowed_tabs ?? null,
      });
      setRoleState(profile.role as Role);
      setUser({ id: profile.id, name: profile.name, email: profile.email });
      setIsOwner(Boolean(profile.is_owner));
      setIsWorkshopManager(Boolean(profile.is_workshop_manager));
      setAllowedTabs(allowed);
      setAuthed(true);
      setLoading(false);
      // Bridge the Supabase session to the legacy localStorage flags so the
      // route-level beforeLoad guards in /admin, /driver, /mechanic, /t/$token
      // continue to work without each having to read a Supabase session.
      try {
        localStorage.setItem("fo:authed", "1");
        localStorage.setItem("fo:role", profile.role);
      } catch {
        /* ignore */
      }
      writeStoredAdminTabs(allowed);
    }

    supabase.auth.getSession().then(({ data }) => hydrateFromSession(data.session));

    // Single shared handler for PASSWORD_RECOVERY navigation. Used by both
    // the auth-state-change listener (fires when supabase-js parses the
    // recovery hash) and the one-shot mount-time check (catches the case
    // where the hash is already in the URL but the event hasn't fired
    // synchronously yet). Both paths preserve the URL hash so the
    // recovery session info isn't lost across the navigation — even
    // though supabase-js stores it in localStorage independently, keeping
    // the hash is belt-and-braces for any client lib that re-reads it.
    let recoveryNavigated = false;
    function navigateToResetPassword() {
      if (typeof window === "undefined") return;
      if (window.location.pathname.startsWith("/reset-password")) return;
      if (recoveryNavigated) return; // already kicked off — don't double-nav
      recoveryNavigated = true;
      const hash = window.location.hash || "";
      window.location.assign(`/reset-password${hash}`);
    }

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      hydrateFromSession(session);
      // Supabase's recovery email link sets redirect_to to site_url (not
      // the per-call redirect_to we pass — known gotrue quirk). Users land
      // on the SPA root with a #type=recovery hash; we route them to the
      // reset form.
      if (event === "PASSWORD_RECOVERY") navigateToResetPassword();
    });

    // One-shot mount-time check for the same case (event may have fired
    // before this listener attached, or may not fire if the session was
    // already established in a prior render cycle).
    if (
      typeof window !== "undefined" &&
      window.location.hash.includes("type=recovery")
    ) {
      navigateToResetPassword();
    }

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const setRole = (r: Role) => {
    setRoleState(r);
    if (!USE_SUPABASE) localStorage.setItem("fo:role", r);
  };
  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  const login = (r: Role) => {
    if (USE_SUPABASE) {
      // In Supabase mode, role-only login is meaningless — no-op.
      // Prefer signIn(email, password).
      return;
    }
    setAuthed(true);
    setRole(r);
    setUser(MOCK_USERS[r]);
    localStorage.setItem("fo:authed", "1");
  };

  const signIn = async (email: string, password: string) => {
    if (!USE_SUPABASE || !supabase) {
      // Legacy: any non-empty creds count as success; role is what the caller set.
      login(role);
      return { error: null };
    }
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    // Eagerly set the legacy localStorage flags so route beforeLoad guards
    // pass on the next navigation. Without this there's a race window
    // between the post-login navigate() and the async onAuthStateChange
    // → hydrateFromSession path that would otherwise set them, causing
    // the user to be bounced back to /login.
    if (data.user) {
      try {
        localStorage.setItem("fo:authed", "1");
        const { data: profile } = await supabase
          .from("profiles")
          .select(PROFILE_ACCESS_SELECT)
          .eq("id", data.user.id)
          .single();
        if (profile?.role) {
          localStorage.setItem("fo:role", profile.role);
          // Eagerly mirror the tab set too, for the same race reason — the
          // first post-login navigation's beforeLoad must not see a stale
          // (previous user's) or missing tab set.
          writeStoredAdminTabs(
            resolveAllowedTabs({
              isOwner: Boolean(profile.is_owner),
              override: profile.allowed_tabs_override ?? null,
              roleTabs: profile.admin_roles?.allowed_tabs ?? null,
            }),
          );
        } else {
          // Enriched select failed (e.g. the owner/roles SQL isn't applied in
          // this environment). Fall back to the legacy role-only select so the
          // post-login navigation still passes the fo:role guard, and drop any
          // stale tab set so the tab guard fails open; hydrate backfills.
          clearStoredAdminTabs();
          const { data: legacy } = await supabase
            .from("profiles")
            .select("role")
            .eq("id", data.user.id)
            .single();
          if (legacy?.role) localStorage.setItem("fo:role", legacy.role);
        }
      } catch {
        /* non-fatal — hydrateFromSession will retry */
      }
    }
    return { error: null };
  };

  const sendPasswordReset = async (email: string) => {
    if (!USE_SUPABASE || !supabase) {
      // Mock mode: pretend success so the demo UI feels real.
      return { error: null };
    }
    const trimmed = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) {
      return { error: "Enter a valid email address" };
    }
    // Demo creds carve-out — alex@/tom@/jamie@fleetops.co aren't real Auth
    // users, so Supabase would return "user not found". Short-circuit with a
    // helpful message rather than the raw error.
    const demoEmails = [
      "alex@fleetops.co",
      "tom@fleetops.co",
      "jamie@fleetops.co",
    ];
    if (demoEmails.includes(trimmed.toLowerCase())) {
      return {
        error: "Demo accounts don't have email reset — sign in with password 'demo1234'.",
      };
    }
    const redirectTo =
      typeof window !== "undefined"
        ? `${window.location.origin}/reset-password`
        : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(trimmed, {
      redirectTo,
    });
    if (error) return { error: error.message };
    return { error: null };
  };

  const updatePassword = async (newPassword: string) => {
    if (!USE_SUPABASE || !supabase) {
      return { error: null };
    }
    if (newPassword.length < 8) {
      return { error: "Password must be at least 8 characters" };
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return { error: error.message };
    return { error: null };
  };

  const logout = async () => {
    if (USE_SUPABASE && supabase) {
      await supabase.auth.signOut();
    }
    setAuthed(false);
    setIsDriverTokenSession(false);
    setIsOwner(!USE_SUPABASE);
    setAllowedTabs("all");
    setIsWorkshopManager(!USE_SUPABASE);
    localStorage.removeItem("fo:authed");
    clearStoredAdminTabs();
    // Also burn any in-tab driver-token session so logging out via the
    // profile menu doesn't leave the bridge alive for the rest of the tab.
    try {
      sessionStorage.removeItem("fo:driver-token");
      sessionStorage.removeItem("fo:driver-token-scope");
      sessionStorage.removeItem("fo:driver-token-driver");
      sessionStorage.removeItem("fo:driver-token-driver-id");
      sessionStorage.removeItem("fo:driver-token-expires-at");
    } catch {
      /* ignore */
    }
  };

  return (
    <AuthCtx.Provider
      value={{
        role,
        setRole,
        theme,
        toggleTheme,
        authed,
        loading,
        user,
        signIn,
        sendPasswordReset,
        updatePassword,
        logout,
        login,
        isDriverTokenSession,
        isOwner,
        allowedTabs,
        isWorkshopManager,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("useAuth must be within AuthProvider");
  return c;
}
