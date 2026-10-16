import { NextResponse, type NextRequest } from "next/server";
import { queryAll, queryOne } from "@/lib/db";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { recordAudit } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * Razorpay webhook receiver.
 *
 * The browser callback is a convenience, not a source of truth: the customer
 * can close the tab before it fires. This endpoint is what makes a capture
 * durable, so it verifies the HMAC signature over the *raw* body before
 * trusting a single field.
 *
 * Every handler is idempotent, because Razorpay retries until it sees a 2xx.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature");
  if (!verifyWebhookSignature(raw, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { event?: string; payload?: Record<string, unknown> };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Malformed payload" }, { status: 400 });
  }

  const payload = event.payload ?? {};
  const paymentEntity = payload.payment as
    | { entity?: Record<string, unknown> }
    | undefined;
  const notes = (paymentEntity?.entity?.notes ?? {}) as Record<string, string>;
  const requestId = Number(notes.requestId ?? NaN);

  try {
    switch (event.event) {
      case "payment.captured": {
        // The gateway captured the money and routed the pharmacy owner's share
        // at capture time, so the only work left here is bookkeeping.
        const gatewayPaymentId = String(paymentEntity?.entity?.id ?? "");
        if (Number.isFinite(requestId)) {
          const payment = await queryOne<{ id: number; razorpay_payment_id: string | null }>(
            "SELECT id, razorpay_payment_id FROM payments WHERE request_id = $1",
            [requestId]
          );
          if (payment) {
            await queryAll(
              `UPDATE payments
                  SET status = CASE WHEN status = 'Awaiting' THEN 'Captured' ELSE status END,
                      razorpay_payment_id = COALESCE(razorpay_payment_id, $1),
                      captured_at = COALESCE(captured_at, $2),
                      updated_at = $2
                WHERE id = $3`,
              [gatewayPaymentId, new Date().toISOString(), payment.id]
            );
            await queryAll(
              "UPDATE requests SET payment_status = 'Captured' WHERE id = $1 AND payment_status = 'Awaiting'",
              [requestId]
            );
          }
        }
        break;
      }
      case "refund.processed":
      case "payment.refunded": {
        if (Number.isFinite(requestId)) {
          await queryAll(
            `UPDATE payments
                SET status = 'Refunded', refunded_at = $1, settled_at = COALESCE(settled_at, $1), updated_at = $1
              WHERE request_id = $2 AND status IN ('Captured', 'PaidOut')`,
            [new Date().toISOString(), requestId]
          );
          await queryAll("UPDATE requests SET payment_status = 'Refunded' WHERE id = $1", [requestId]);
        }
        break;
      }
      case "payment.failed": {
        if (Number.isFinite(requestId)) {
          await queryAll(
            "UPDATE payments SET status = 'Failed', failure_reason = $1, updated_at = $2 WHERE request_id = $3",
            [String(paymentEntity?.entity?.error_description ?? "Payment failed"), new Date().toISOString(), requestId]
          );
          await queryAll("UPDATE requests SET payment_status = 'Failed' WHERE id = $1", [requestId]);
        }
        break;
      }
      default:
        // Unhandled events are acknowledged, not retried forever.
        break;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("razorpay webhook handler failed", e);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  await recordAudit({
    action: `razorpay.${event.event ?? "unknown"}`,
    entityType: "payment",
    entityId: Number.isFinite(requestId) ? requestId : undefined,
    meta: { requestId: Number.isFinite(requestId) ? requestId : null },
  });
  return NextResponse.json({ ok: true });
}