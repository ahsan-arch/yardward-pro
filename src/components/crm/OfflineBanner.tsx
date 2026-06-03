import { useOffline } from "@/contexts/OfflineContext";
import { WifiOff, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";

export function OfflineBanner() {
  const { isOnline, pendingSubmissions, failedSubmissions, deadLetterStuck, flush } =
    useOffline();
  const [syncing, setSyncing] = useState(false);

  // Nothing to surface when we're healthy: online, nothing queued, nothing
  // failing. The failure banner is gated on failedSubmissions > 0 separately
  // because a failed item is still "pending" so we can't just check pending.
  if (isOnline && pendingSubmissions === 0 && failedSubmissions === 0) return null;

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

  // Online + at least one item is in a failure state. We use the danger
  // colour palette when there's a stuck dead-letter (data loss imminent) and
  // amber when it's just transient retries so admins can prioritise.
  if (failedSubmissions > 0) {
    const stuck = deadLetterStuck > 0;
    return (
      <div
        className={
          stuck
            ? "bg-danger/15 text-danger border-b border-danger/30 px-3 py-1.5 text-xs font-medium flex items-center justify-center gap-2"
            : "bg-amber-brand/15 text-amber-brand border-b border-amber-brand/30 px-3 py-1.5 text-xs font-medium flex items-center justify-center gap-2"
        }
      >
        <AlertTriangle className="w-3.5 h-3.5" />
        {failedSubmissions} submission{failedSubmissions > 1 ? "s" : ""} failing
        {stuck && <span className="font-mono">({deadLetterStuck} stuck)</span>}
        <Link to="/admin/errors" className="underline hover:no-underline">
          Review failures
        </Link>
        <button
          onClick={handleFlush}
          disabled={syncing}
          className="underline hover:no-underline disabled:opacity-50"
        >
          {syncing ? "Retrying…" : "Retry now"}
        </button>
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
