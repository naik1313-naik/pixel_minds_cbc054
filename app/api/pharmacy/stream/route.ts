import { guard } from "@/lib/api-utils";
import { channels, subscribe } from "@/lib/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Live updates for a pharmacy console.
 *
 * Without this the console only changes when someone presses Refresh, which
 * during a demo means a payout figure sitting stale while an order completes on
 * the other screen — the one moment the whole point is to show.
 *
 * The stream is scoped to the caller's own pharmacy channel, so it carries only
 * events they are already entitled to see.
 */
export const GET = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      send({ type: "hello", pharmacyId: ctx.user.pharmacy_id });
      // Admin has no single pharmacy; it subscribes to the network channel.
      const channel =
        ctx.user.role === "admin" ? channels.admin : channels.pharmacy(ctx.user.pharmacy_id ?? 0);
      const unsub = subscribe(channel, (e) => send(e));
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15000);
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsub();
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
});