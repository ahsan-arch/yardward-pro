import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Role = "admin" | "driver" | "mechanic";
export type Theme = "light" | "dark";

type Ctx = {
  role: Role;
  setRole: (r: Role) => void;
  theme: Theme;
  toggleTheme: () => void;
  authed: boolean;
  login: (role: Role) => void;
  logout: () => void;
  user: { id: string; name: string; email: string };
};

const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [role, setRoleState] = useState<Role>("admin");
  const [theme, setTheme] = useState<Theme>("light");
  const [authed, setAuthed] = useState(false);
  const [user, setUser] = useState({ id: "A-01", name: "Alex Chen", email: "alex@fleetops.co" });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = (localStorage.getItem("fo:theme") as Theme) || "light";
    const r = (localStorage.getItem("fo:role") as Role) || "admin";
    const a = localStorage.getItem("fo:authed") === "1";
    setTheme(t);
    setRoleState(r);
    setAuthed(a);
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("fo:theme", theme);
  }, [theme]);

  const setRole = (r: Role) => {
    setRoleState(r);
    localStorage.setItem("fo:role", r);
  };
  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  const login = (r: Role) => {
    setAuthed(true);
    setRole(r);
    setUser(
      r === "driver"
        ? { id: "D-01", name: "Tom Morrison", email: "tom@fleetops.co" }
        : r === "mechanic"
          ? { id: "M-01", name: "Jamie Reyes", email: "jamie@fleetops.co" }
          : { id: "A-01", name: "Alex Chen", email: "alex@fleetops.co" },
    );
    localStorage.setItem("fo:authed", "1");
  };
  const logout = () => {
    setAuthed(false);
    localStorage.removeItem("fo:authed");
  };

  return (
    <AuthCtx.Provider value={{ role, setRole, theme, toggleTheme, authed, login, logout, user }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("useAuth must be within AuthProvider");
  return c;
}
