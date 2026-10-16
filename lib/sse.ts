import { EventEmitter } from "events";

// In-process pub/sub for Server-Sent Events. A single global emitter so it
// survives Next.js dev module reloads. Each subscriber is cleaned up on abort.
declare global {
  // eslint-disable-next-line no-var
  var __medimeshBus: EventEmitter | undefined;
}

function bus(): EventEmitter {
  if (!globalThis.__medimeshBus) {
    const e = new EventEmitter();
    e.setMaxListeners(0);
    globalThis.__medimeshBus = e;
  }
  return globalThis.__medimeshBus;
}

export type MediEvent =
  | { type: "request"; requestId: number; status: string }
  | { type: "delivery"; deliveryId: number; requestId: number; status: string }
  | { type: "payment"; requestId: number; paymentId: number; status: string }
  | { type: "location"; deliveryId: number; lat: number; lng: number; heading: number | null }
  | { type: "inventory"; pharmacyId: number }
  // Blockchain audit layer. Payloads stay small and carry no customer data:
  // only opaque references, statuses and transaction hashes.
  | { type: "blockchain.status.updated"; ready: boolean }
  | { type: "batch.registered"; batchId: number; batchRef: string; txHash: string | null }
  | { type: "batch.revoked"; batchId: number; batchRef: string; txHash: string | null }
  | { type: "transfer.initiated"; transferId: number; status: string; txHash: string | null }
  | { type: "transfer.confirmed"; transferId: number; status: string; txHash: string | null }
  | { type: "delivery.milestone.recorded"; deliveryId: number; milestone: string; txHash: string | null }
  | { type: "blockchain.operation.failed"; entityType: string; entityId: number; operationId: number };

/** Event types mirrored to the operator's console. */
const ADMIN_MIRRORED: ReadonlySet<string> = new Set([
  "request",
  "delivery",
  "payment",
  "inventory",
]);

/**
 * Fans an order-scoped event out to the admin console.
 *
 * Order events are published to per-request and per-pharmacy channels, which
 * the operator is not subscribed to — so without this the admin's order table
 * silently goes stale and they have to guess whether to refresh. Mirroring the
 * already-public lifecycle events (no PII beyond what the operator is entitled
 * to see) keeps one code path instead of a parallel publish call at every site.
 */
function publishAdmin(event: MediEvent): void {
  if (!ADMIN_MIRRORED.has(event.type)) return;
  bus().emit("admin", { ...event, adminBroadcast: true });
}

export function publish(channel: string, event: MediEvent): void {
  bus().emit(channel, event);
  publishAdmin(event);
}

export function subscribe(
  channel: string,
  handler: (e: MediEvent) => void
): () => void {
  bus().on(channel, handler);
  return () => bus().off(channel, handler);
}

// Channels
export const channels = {
  request: (id: number) => `request:${id}`,
  delivery: (id: number) => `delivery:${id}`,
  pharmacy: (id: number) => `pharmacy:${id}`,
  admin: "admin",
  blockchain: "blockchain",
};
