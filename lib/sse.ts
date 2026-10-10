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
  | { type: "location"; deliveryId: number; lat: number; lng: number; heading: number | null }
  | { type: "inventory"; pharmacyId: number };

export function publish(channel: string, event: MediEvent): void {
  bus().emit(channel, event);
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
};
