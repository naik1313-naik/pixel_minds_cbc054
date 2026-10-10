import { guard, error } from "@/lib/api-utils";
import { getRequestDetail } from "@/lib/engine";
import { canViewRequest } from "@/lib/access";
import { subscribe, channels } from "@/lib/sse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = guard(null, async (ctx, req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const detail = getRequestDetail(id);
  if (!detail) return error(404, "Request not found");
  const r = detail.request as { customer_id: number | null; preferred_pharmacy_id: number | null };
  if (!canViewRequest(ctx.user, { customer_id: r.customer_id, preferred_pharmacy_id: r.preferred_pharmacy_id, id }))
    return error(403, "Forbidden");

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
      send({ type: "request", requestId: id, status: (detail.request as { status: string }).status });
      const unsub = subscribe(channels.request(id), (e) => send(e));
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
          /* already closed */
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
