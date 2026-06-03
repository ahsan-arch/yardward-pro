import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { subscribePwaUpdate, applyUpdate } from "@/lib/pwa-updater";

export function PwaUpdateBanner() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    // subscribePwaUpdate replays current state synchronously so we don't miss
    // an onNeedRefresh that fired before this component mounted.
    return subscribePwaUpdate((state) => {
      setNeedRefresh(state.needRefresh);
    });
  }, []);

  if (!needRefresh) return null;

  async function handleReload() {
    setReloading(true);
    try {
      await applyUpdate();
    } catch {
      // updateSW rejecting is unusual but if it does, drop the spinner so the
      // driver can retry. The page would normally reload before this resolves.
      setReloading(false);
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-sm w-[calc(100%-2rem)] rounded-lg border border-primary/30 bg-card shadow-lg px-4 py-3 flex items-center gap-3"
    >
      <RefreshCw
        className={`w-4 h-4 text-primary shrink-0 ${reloading ? "animate-spin" : ""}`}
      />
      <div className="flex-1 text-sm">
        <div className="font-medium">New version available</div>
        <div className="text-xs text-muted-foreground">
          Reload to get the latest update.
        </div>
      </div>
      <button
        type="button"
        onClick={handleReload}
        disabled={reloading}
        className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
      >
        {reloading ? "Reloading…" : "Reload"}
      </button>
    </div>
  );
}
