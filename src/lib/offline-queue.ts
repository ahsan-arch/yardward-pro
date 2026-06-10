import { api } from "@/lib/api";

const STORAGE_KEY = "fo:offline-queue:v1";

// After this many failed attempts a queue item is considered poison and
// promoted to dead_letter_submissions instead of being re-queued. Five is
// generous enough to ride out an outage + a couple of transient 5xxs without
// burying real bugs in an unbounded retry loop.
const MAX_RETRIES = 5;

// Per-item retry/error metadata. Stored alongside the kind/payload union so
// every variant carries the same observability fields. Items written by
// older versions of the app (pre-retry-counter) come back as
// `retryCount=undefined` and we coerce to 0 on read so the flush loop keeps
// working without a migration step.
type RetryMeta = {
  retryCount: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  /**
   * Token to consume server-side AFTER the submission in this item lands.
   * Set by routes that gate a "shift-terminal" submission on a tokenized
   * link (EOD, work-order on scope='job') so the consume cannot happen
   * before the work itself is durable. Without this, a dead-lettered work
   * order could still burn its access token and lock the driver out of
   * resubmitting via the original link.
   */
  consumeTokenAfter?: string | null;
  /**
   * Stable, queue-side identifier used by the server inserts to dedupe
   * retries. Minted once at enqueue time (crypto.randomUUID, with a
   * getRandomValues fallback for older runtimes) and PERSISTED on the
   * queue row so a retry-after-lost-response replays with the same key.
   *
   * The server tables (work_orders, vehicle_inspections, ...) carry a
   * partial UNIQUE index on idempotency_key — a colliding insert returns
   * Postgres 23505 and the api layer treats that as "already inserted,
   * fetch the existing row" instead of throwing. Without this field, a
   * driver who tapped Submit, lost their connection right after the row
   * landed, and then came back online would double-insert their work
   * order with two different client-side ids.
   *
   * Optional in the type because pre-idempotency-key queue rows might
   * already be persisted in localStorage; the enqueue path always sets
   * a value going forward and the flush path mirrors it through to the
   * api submit calls via the payload.
   */
  idempotencyKey?: string;
};

export type QueueItem = (
  | {
      kind: "workOrder";
      payload: Parameters<typeof api.submitWorkOrder>[0];
    }
  | {
      kind: "startOfDay";
      payload: Parameters<typeof api.submitStartOfDay>[0];
    }
  | {
      kind: "endOfDay";
      payload: Parameters<typeof api.submitEndOfDay>[0];
    }
  | {
      kind: "toolChecklist";
      payload: Parameters<typeof api.submitToolChecklist>[0];
    }
  | {
      kind: "purchaseRequest";
      payload: Parameters<typeof api.submitPurchaseRequest>[0];
    }
  | {
      kind: "jobLog";
      payload: Parameters<typeof api.submitJobLog>[0];
    }
  | {
      // Native hauling record (dump / load form). Same replay semantics as
      // jobLog: the payload carries an idempotency key so a flush that races
      // an online retry can't double-insert the record.
      kind: "dumpLog";
      payload: Parameters<typeof api.submitDumpLog>[0];
    }
  | {
      kind: "ticketPhoto";
      payload: Parameters<typeof api.uploadTicketPhoto>[0];
    }
  | {
      // Vehicle pre-trip inspection. Without this kind, an offline inspection
      // would throw at api.submitVehicleInspection (no network) and the driver
      // would either be blocked from starting their day or — worse — silently
      // see a success toast while the payload evaporates. Mirrors the
      // work-order replay pattern: retry/dead-letter via the same flushOne
      // path, and the payload matches the api method's input shape exactly so
      // the online and offline call sites share one schema.
      kind: "inspection";
      payload: Parameters<typeof api.submitVehicleInspection>[0];
    }
  | {
      // Burns a driver token server-side after its tethered submission
      // replays. Enqueued by the driver form routes alongside the submission
      // they belong to (end-of-day, work-order for scope='job', start-of-day
      // for scope='forms') so the token isn't consumed before the work it
      // authorised has actually landed. Payload is the raw token string.
      kind: "consumeDriverToken";
      payload: string;
    }
  | {
      // Prepaid-ticket debit recorded from /driver/tickets. Mirrors the
      // work-order replay pattern: enqueued offline so a driver standing at a
      // client site without coverage can still record the ticket pull and the
      // queue flushes the RPC call when the device next sees the internet.
      kind: "ticket-use";
      payload: Parameters<typeof api.recordTicketUse>[0];
    }
  | {
      // Outbound communications message. The api.sendMessage helper sets a
      // client-side idempotency_key so a queued flush that races with the
      // online retry never inserts a duplicate row (unique partial index on
      // (sender_id, idempotency_key) enforces this server-side).
      kind: "sendMessage";
      payload: Parameters<typeof api.sendMessage>[0];
    }
) & {
  id: string;
  queuedAt: string;
} & RetryMeta;

type Kind = QueueItem["kind"];
type EnqueueInput = {
  kind: Kind;
  payload: QueueItem["payload"];
  consumeTokenAfter?: string | null;
};

type Listener = (count: number) => void;

// Normalise pre-retry-counter rows so the rest of the module can assume the
// metadata is always present. New fields default to "never attempted".
function hydrate(raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((it: Record<string, unknown>) => ({
    ...(it as object),
    retryCount: typeof it.retryCount === "number" ? it.retryCount : 0,
    lastError: typeof it.lastError === "string" ? it.lastError : null,
    lastAttemptAt: typeof it.lastAttemptAt === "string" ? it.lastAttemptAt : null,
  })) as QueueItem[];
}

function read(): QueueItem[] {
  if (typeof window === "undefined") return [];
  try {
    return hydrate(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

// Max safe size for one queue serialisation. Browsers typically allow ~5MB
// per origin in localStorage; we leave headroom for other keys (auth, vault,
// tokens). Anything above this gets the offending item dropped rather than
// nuking the whole queue with QuotaExceededError.
const MAX_QUEUE_BYTES = 3_500_000;

class OfflineQueueQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineQueueQuotaError";
  }
}

function write(items: QueueItem[]) {
  if (typeof window === "undefined") return;
  const payload = JSON.stringify(items);
  if (payload.length > MAX_QUEUE_BYTES) {
    throw new OfflineQueueQuotaError(
      `Offline queue payload (${payload.length} bytes) exceeds budget (${MAX_QUEUE_BYTES}). ` +
        `Refusing to write to avoid QuotaExceededError on localStorage.`,
    );
  }
  try {
    localStorage.setItem(STORAGE_KEY, payload);
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED")
    ) {
      throw new OfflineQueueQuotaError(
        `localStorage quota exceeded while writing offline queue (${payload.length} bytes).`,
      );
    }
    throw err;
  }
}

export { OfflineQueueQuotaError, MAX_RETRIES };

const listeners = new Set<Listener>();
// Single-flight handle for flush(). When non-null, an in-progress flush owns
// the queue and any concurrent caller piggybacks on the same promise.
let inflightFlush: Promise<{ flushed: number; remaining: number; deadLettered: number }> | null =
  null;

function notify() {
  const c = read().length;
  listeners.forEach((l) => l(c));
}

// Attempt to flush a single item. Returns one of three outcomes so the
// flush() driver knows whether to drop, re-queue, or keep-and-retry-dead-letter:
//   - "ok"          → submitted upstream, drop from queue
//   - "retry"       → transient failure, increment retryCount and re-queue
//   - "dead"        → moved to dead_letter_submissions, drop from queue
//   - "stuck-dead"  → exhausted retries but the dead-letter insert itself
//                     failed (e.g. still offline); keep the item locally so a
//                     future flush can try the move again. We still bump the
//                     retry counter so the metadata reflects reality.
type FlushOutcome = "ok" | "retry" | "dead" | "stuck-dead";

async function flushOne(item: QueueItem): Promise<{ outcome: FlushOutcome; item: QueueItem }> {
  // Poison-pill guard: when an item has already used up its retry budget we
  // promote it to dead_letter_submissions instead of attempting another
  // submission. This is the only path that calls api.moveToDeadLetter — it
  // sits in front of flushOne's switch so a misbehaving payload can't
  // hammer the backend forever.
  if (item.retryCount >= MAX_RETRIES) {
    try {
      await api.moveToDeadLetter({
        id: item.id,
        kind: item.kind,
        payload: item.payload,
        queuedAt: item.queuedAt,
        retryCount: item.retryCount,
        lastError: item.lastError,
        lastAttemptAt: item.lastAttemptAt,
      });
      return { outcome: "dead", item };
    } catch (err) {
      // Couldn't reach the dead-letter table (likely offline). Keep the
      // item so we don't lose the payload, but bump the counter + record
      // the error so the UI can show "stuck, retrying move" and we have a
      // breadcrumb for triage.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `offline-queue: dead-letter move failed for ${item.id} (${item.kind}); keeping locally:`,
        msg,
      );
      return {
        outcome: "stuck-dead",
        item: {
          ...item,
          retryCount: item.retryCount + 1,
          lastError: `dead-letter move failed: ${msg}`,
          lastAttemptAt: new Date().toISOString(),
        },
      };
    }
  }

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
      case "jobLog":
        await api.submitJobLog(item.payload);
        break;
      case "dumpLog":
        await api.submitDumpLog(item.payload);
        break;
      case "ticketPhoto":
        await api.uploadTicketPhoto(item.payload);
        break;
      case "inspection":
        await api.submitVehicleInspection(item.payload);
        break;
      case "consumeDriverToken": {
        // The RPC returns false (not throws) for "already used" / "expired"
        // / "not found" — all terminal outcomes from the queue's perspective.
        // Only network/transport errors should re-queue, and those surface
        // as throws from supabase.rpc. So we treat a `false` return as "ok,
        // nothing left to do" and drop the item.
        await api.consumeDriverToken(item.payload);
        break;
      }
      case "ticket-use":
        await api.recordTicketUse(item.payload);
        break;
      case "sendMessage":
        await api.sendMessage(item.payload);
        break;
    }
    // Coupled consume: when the submission above carried a token to burn,
    // do it now (AFTER the submission landed). If we exhausted the
    // submission's retries and reached dead-letter, this path isn't taken,
    // so a never-landed work order can't accidentally burn its access token.
    if (item.consumeTokenAfter) {
      try {
        await api.consumeDriverToken(item.consumeTokenAfter);
      } catch (err) {
        // A transport failure on consume after a successful submission is
        // a soft fault — the submission is durable, the link may still be
        // burnable by a future flush of the standalone consumeDriverToken
        // path or by the next submission via the same token. Don't fail
        // the whole item.
        console.warn(
          "offline-queue: post-submission consumeDriverToken failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { outcome: "ok", item };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      outcome: "retry",
      item: {
        ...item,
        retryCount: item.retryCount + 1,
        lastError: msg,
        lastAttemptAt: new Date().toISOString(),
      },
    };
  }
}

// Mint a v4 UUID for an idempotency key. Prefer crypto.randomUUID (Chrome 92+,
// Safari 15.4+, Firefox 95+) so we get a real RFC 4122 v4 in one call. Older
// runtimes (or pre-secure-context surfaces) only ship getRandomValues, so we
// fall back to building the UUID manually from 16 random bytes. Last resort
// (no crypto.getRandomValues at all — e.g. very old SSR contexts) is a
// Math.random()-based string so the queue still works; the key won't be
// cryptographically random but the partial-unique-index dedupe semantics
// don't depend on unguessability, only on collision-avoidance.
function mintIdempotencyKey(): string {
  const g: { crypto?: Crypto } =
    typeof globalThis === "undefined" ? {} : (globalThis as { crypto?: Crypto });
  const c = g.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    // Per RFC 4122 §4.4: set version (4) and variant (10) bits.
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  // Final fallback — Math.random() based. Not RFC 4122 compliant but still
  // unique enough that two enqueues on the same client won't collide.
  const r = () => Math.random().toString(16).slice(2, 10).padStart(8, "0");
  return `${r()}-${r().slice(0, 4)}-4${r().slice(0, 3)}-${r().slice(0, 4)}-${r()}${r().slice(0, 4)}`;
}

export const offlineQueue = {
  async enqueue(input: EnqueueInput) {
    // Mint an idempotency key for the SERVER-FACING dedupe path. Stamped
    // onto the payload itself so the matching api submit method picks it up
    // unchanged on both the immediate-online path (when this enqueue isn't
    // even used) and on every retry. Skipped for `consumeDriverToken` —
    // that kind has a string payload (the raw token), not an object, and
    // the consume_driver_token RPC is already idempotent server-side via
    // the used_at IS NULL guard.
    const idempotencyKey = mintIdempotencyKey();
    const payload = input.payload;
    const payloadWithKey =
      input.kind === "consumeDriverToken" || typeof payload !== "object" || payload === null
        ? payload
        : {
            ...(payload as object),
            // Don't clobber an already-set key (e.g. a caller minted one upstream
            // for cross-tab dedupe). The whole point is "same key across retries"
            // so once set, never replaced.
            idempotencyKey:
              (payload as { idempotencyKey?: string }).idempotencyKey ?? idempotencyKey,
          };
    const item: QueueItem = {
      id: `Q-${Math.random().toString(36).slice(2, 10)}`,
      ...input,
      payload: payloadWithKey as EnqueueInput["payload"],
      queuedAt: new Date().toISOString(),
      retryCount: 0,
      lastError: null,
      lastAttemptAt: null,
      consumeTokenAfter: input.consumeTokenAfter ?? null,
      idempotencyKey:
        input.kind === "consumeDriverToken" || typeof payload !== "object" || payload === null
          ? idempotencyKey
          : ((payloadWithKey as { idempotencyKey?: string }).idempotencyKey ?? idempotencyKey),
    } as QueueItem;
    const items = read();
    items.push(item);
    try {
      write(items);
    } catch (err) {
      if (err instanceof OfflineQueueQuotaError) {
        // Drop the offending item so the existing queue stays valid. The caller
        // is expected to catch this and surface a real "couldn't save offline"
        // error to the user rather than a cheerful success toast.
        items.pop();
        try {
          write(items);
        } catch {
          /* if even rollback fails, leave queue stale; better than a partial write */
        }
        throw err;
      }
      throw err;
    }
    notify();
    return item.id;
  },
  size() {
    return read().length;
  },
  list() {
    return read();
  },
  // Items that have failed at least once but are not yet dead-lettered.
  // The UI uses this to surface a "review failures" hint without the user
  // needing to know about MAX_RETRIES internals.
  failedItems(): QueueItem[] {
    return read().filter((it) => it.retryCount > 0);
  },
  // Count of items currently waiting to be flushed to dead_letter_submissions
  // (i.e. stuck-dead — they exhausted retries but the move itself failed).
  // Distinct from failedItems(); used by the banner to escalate when we know
  // we are losing data unless the user comes back online.
  deadLetterSize(): number {
    return read().filter((it) => it.retryCount >= MAX_RETRIES).length;
  },
  // Single-flight: only one flush runs at a time. The `online` listener and
  // a manual "Retry now" button (or React StrictMode double-effect) can all
  // trigger flush concurrently; without this guard each invocation reads the
  // queue, processes every item, and writes back with last-write-wins
  // semantics — yielding duplicate server-side submissions because the same
  // payload gets replayed twice with the same client-side id (which the
  // server doesn't dedupe on today).
  async flush() {
    if (inflightFlush) return inflightFlush;
    inflightFlush = (async () => {
      const items = read();
      const remaining: QueueItem[] = [];
      let flushed = 0;
      let deadLettered = 0;
      for (const it of items) {
        const result = await flushOne(it);
        switch (result.outcome) {
          case "ok":
            flushed += 1;
            break;
          case "dead":
            deadLettered += 1;
            break;
          case "retry":
          case "stuck-dead":
            remaining.push(result.item);
            break;
        }
      }
      write(remaining);
      notify();
      return { flushed, remaining: remaining.length, deadLettered };
    })().finally(() => {
      inflightFlush = null;
    });
    return inflightFlush;
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
