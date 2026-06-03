import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { offlineQueue } from "@/lib/offline-queue";

type Ctx = {
  isOnline: boolean;
  pendingSubmissions: number;
  // Items that have failed at least one flush attempt. Surfaces in the banner
  // as a separate warning so a stuck submission isn't hidden behind the
  // generic "queued" count.
  failedSubmissions: number;
  // Items that have exhausted MAX_RETRIES and are waiting for the
  // dead_letter_submissions move to succeed. When this is non-zero we know
  // we'll lose the payload unless connectivity returns.
  deadLetterStuck: number;
  flush: () => Promise<void>;
};

const OfflineCtx = createContext<Ctx | null>(null);

export function OfflineProvider({ children }: { children: ReactNode }) {
  const [isOnline, setIsOnline] = useState(true);
  const [pendingSubmissions, setPending] = useState(0);
  const [failedSubmissions, setFailed] = useState(0);
  const [deadLetterStuck, setDeadLetterStuck] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(navigator.onLine);
    const up = () => setIsOnline(true);
    const down = () => setIsOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    // subscribe fires on every notify() — enqueue, flush, dead-letter — so
    // we recompute the derived counts off the same heartbeat instead of
    // wiring a second listener channel.
    const unsub = offlineQueue.subscribe((count) => {
      setPending(count);
      setFailed(offlineQueue.failedItems().length);
      setDeadLetterStuck(offlineQueue.deadLetterSize());
    });
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
      unsub();
    };
  }, []);

  async function flush() {
    await offlineQueue.flush();
  }

  return (
    <OfflineCtx.Provider
      value={{
        isOnline,
        pendingSubmissions,
        failedSubmissions,
        deadLetterStuck,
        flush,
      }}
    >
      {children}
    </OfflineCtx.Provider>
  );
}

export function useOffline() {
  const c = useContext(OfflineCtx);
  if (!c) throw new Error("useOffline must be within OfflineProvider");
  return c;
}
