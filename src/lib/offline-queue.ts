import { api } from "@/lib/api";

const STORAGE_KEY = "fo:offline-queue:v1";

export type QueueItem =
  | {
      id: string;
      kind: "workOrder";
      payload: Parameters<typeof api.submitWorkOrder>[0];
      queuedAt: string;
    }
  | {
      id: string;
      kind: "startOfDay";
      payload: Parameters<typeof api.submitStartOfDay>[0];
      queuedAt: string;
    }
  | {
      id: string;
      kind: "endOfDay";
      payload: Parameters<typeof api.submitEndOfDay>[0];
      queuedAt: string;
    }
  | {
      id: string;
      kind: "toolChecklist";
      payload: Parameters<typeof api.submitToolChecklist>[0];
      queuedAt: string;
    }
  | {
      id: string;
      kind: "purchaseRequest";
      payload: Parameters<typeof api.submitPurchaseRequest>[0];
      queuedAt: string;
    };

type Kind = QueueItem["kind"];
type EnqueueInput = { kind: Kind; payload: QueueItem["payload"] };

type Listener = (count: number) => void;

function read(): QueueItem[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function write(items: QueueItem[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

const listeners = new Set<Listener>();
function notify() {
  const c = read().length;
  listeners.forEach((l) => l(c));
}

async function flushOne(item: QueueItem): Promise<boolean> {
  try {
    switch (item.kind) {
      case "workOrder":
        await api.submitWorkOrder(item.payload);
        break;
      case "startOfDay":
        await api.submitStartOfDay(item.payload);
        break;
      case "endOfDay":
        await api.submitEndOfDay(item.payload);
        break;
      case "toolChecklist":
        await api.submitToolChecklist(item.payload);
        break;
      case "purchaseRequest":
        await api.submitPurchaseRequest(item.payload);
        break;
    }
    return true;
  } catch {
    return false;
  }
}

export const offlineQueue = {
  async enqueue(input: EnqueueInput) {
    const item: QueueItem = {
      id: `Q-${Math.random().toString(36).slice(2, 10)}`,
      ...input,
      queuedAt: new Date().toISOString(),
    } as QueueItem;
    const items = read();
    items.push(item);
    write(items);
    notify();
    return item.id;
  },
  size() {
    return read().length;
  },
  list() {
    return read();
  },
  async flush() {
    const items = read();
    const remaining: QueueItem[] = [];
    for (const it of items) {
      const ok = await flushOne(it);
      if (!ok) remaining.push(it);
    }
    write(remaining);
    notify();
    return { flushed: items.length - remaining.length, remaining: remaining.length };
  },
  subscribe(l: Listener) {
    listeners.add(l);
    l(read().length);
    return () => {
      listeners.delete(l);
    };
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    offlineQueue.flush();
  });
}
