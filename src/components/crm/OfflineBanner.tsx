import { useOffline } from "@/contexts/OfflineContext";
import { WifiOff, RefreshCw, CheckCircle2 } from "lucide-react";
import { useState } from "react";

export function OfflineBanner() {
  const { isOnline, pendingSubmissions, flush } = useOffline();
  const [syncing, setSyncing] = useState(false);

  if (isOnline && pendingSubmissions === 0) return null;

  async function handleFlush() {
    setSyncing(true);
    await flush();
    setSyncing(false);
  }

  if (!isOnline) {
    return (
      <div className="bg-danger/15 text-danger border-b border-danger/30 px-3 py-1.5 text-xs font-medium flex items-center justify-center gap-2">
        <WifiOff className="w-3.5 h-3.5" />
        Offline — submissions will queue and sync when connection returns
        {pendingSubmissions > 0 && (
          <span className="font-mono">({pendingSubmissions} pending)</span>
        )}
      </div>
    );
  }

  return (
    <div className="bg-amber-brand/15 text-amber-brand border-b border-amber-brand/30 px-3 py-1.5 text-xs font-medium flex items-center justify-center gap-2">
      <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
      {pendingSubmissions} submission{pendingSubmissions > 1 ? "s" : ""} queued
      <button
        onClick={handleFlush}
        disabled={syncing}
        className="underline hover:no-underline disabled:opacity-50"
      >
        {syncing ? "Syncing…" : "Sync now"}
      </button>
      {!syncing && pendingSubmissions === 0 && (
        <CheckCircle2 className="w-3.5 h-3.5 text-success" />
      )}
    </div>
  );
}

export function PendingBadge() {
  const { pendingSubmissions } = useOffline();
  if (pendingSubmissions === 0) return null;
  return (
    <span className="inline-flex items-center justify-center text-[10px] font-bold min-w-[18px] h-[18px] px-1 rounded-full bg-amber-brand text-amber-brand-foreground">
      {pendingSubmissions}
    </span>
  );
}
