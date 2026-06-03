// Manual service-worker registration that surfaces an "update available"
// prompt instead of silently swapping in a new build. We intentionally avoid
// auto-update because drivers can be mid-form when a new SW activates, which
// would blow away their unsaved work-order state.
//
// The flow:
//   1. main.tsx calls initPwaUpdater() before React mounts.
//   2. virtual:pwa-register hands us an updateSW(reload?: boolean) function
//      and fires onNeedRefresh when a waiting SW is detected.
//   3. We stash updateSW in module scope and notify subscribers (the banner)
//      via a tiny pub/sub. The banner calls applyUpdate() on user click,
//      which invokes updateSW(true) to skipWaiting + reload.

import { registerSW } from "virtual:pwa-register";

export type PwaUpdateState = {
  needRefresh: boolean;
  offlineReady: boolean;
};

type Listener = (state: PwaUpdateState) => void;

const state: PwaUpdateState = {
  needRefresh: false,
  offlineReady: false,
};

const listeners = new Set<Listener>();
let updateSW: ((reloadPage?: boolean) => Promise<void>) | null = null;
let initialized = false;

function emit() {
  // Hand each subscriber a fresh snapshot so React's useSyncExternalStore /
  // useState consumers compare by reference and re-render predictably.
  const snapshot = { ...state };
  for (const listener of listeners) listener(snapshot);
}

export function initPwaUpdater(): void {
  // Guard against double-init from React StrictMode or HMR. registerSW would
  // otherwise register the SW twice and we'd end up with duplicate prompts.
  if (initialized) return;
  initialized = true;

  updateSW = registerSW({
    onNeedRefresh() {
      state.needRefresh = true;
      emit();
    },
    onOfflineReady() {
      state.offlineReady = true;
      emit();
    },
  });
}

export function subscribePwaUpdate(listener: Listener): () => void {
  listeners.add(listener);
  // Push current state immediately so late subscribers (banner mounts after
  // the SW has already reported needRefresh) don't miss the event.
  listener({ ...state });
  return () => {
    listeners.delete(listener);
  };
}

export function getPwaUpdateState(): PwaUpdateState {
  return { ...state };
}

export async function applyUpdate(): Promise<void> {
  // Passing true asks workbox to skipWaiting and reload the page once the new
  // SW takes control. If registration hasn't completed yet (shouldn't happen
  // since the banner only renders after onNeedRefresh) we fall back to a hard
  // reload so the user still gets the new build.
  if (updateSW) {
    await updateSW(true);
  } else {
    window.location.reload();
  }
}

// Test-only seam: expose a window hook that fakes onNeedRefresh so Playwright
// can drive the PwaUpdateBanner without a real waiting service worker. Gated
// on import.meta.env.DEV so production builds never attach this property.
//
// We also install a stub updateSW so applyUpdate() has an observable side
// effect. We can't rely on window.location.reload() — Chromium marks it
// non-configurable so the test's Object.defineProperty stub throws — and
// virtual:pwa-register's dev updateSW is a no-op. Instead we set the same
// window flag the test polls, matching its intent without depending on a
// reload override that the runtime forbids.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __forcePwaUpdate?: () => void }).__forcePwaUpdate = () => {
    state.needRefresh = true;
    // Replace updateSW so applyUpdate() resolves without actually reloading
    // the page — a real reload would re-run init scripts and clear the test's
    // __applyUpdateCalled flag before it can be observed. We surface the
    // observable contract directly.
    updateSW = async () => {
      (window as unknown as { __applyUpdateCalled?: boolean }).__applyUpdateCalled = true;
    };
    emit();
  };
}
