import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Ctx = { isOnline: boolean; pendingSubmissions: number };

const OfflineCtx = createContext<Ctx | null>(null);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [pendingSubmissions] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(navigator.onLine);
    const up = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  return <OfflineCtx.Provider value={{ isOnline, pendingSubmissions }}>{children}</OfflineCtx.Provider>;
}

export function useOffline() {
  const c = useContext(OfflineCtx);
  if (!c) throw new Error("useOffline must be within OfflineProvider");
  return c;
}