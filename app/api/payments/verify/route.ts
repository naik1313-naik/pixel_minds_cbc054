import { guard, error, json } from "@/lib/api-utils";
import { paymentVerifySchema } from "@/lib/validation";
import { PaymentError, capturePayment, getPaymentForRequest, paymentView } from "@/lib/payments";
import { recordAudit } from "@/lib/audit";
import { queryOne } from "@/lib/db";
import { clientIp } from "@/lib/api-utils";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Client-side checkout completion.
 *
 * The browser posts the ids Razorpay returned after a successful payment. We
 * do not trust them: the signature is re-derived from the merchant secret and
 * compared in constant time before anything is captured. Only then is the
 * pharmacy owner's share routed to their linked account.
 */
export const POST = guard(["customer"], async (ctx, req) => {
  const body = await req.json().catch(() => null);
  const parsed = paymentVerifySchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const data = parsed.data;

  // Capture is the most expensive call in the app (it moves money), so the
  // endpoint that triggers it is capped well below the auth limits.
  const limited = rateLimit(`payment-verify:${clientIp(req)}`, 15, 60_000);
  if (!limited.ok) {
    return new Response(JSON.stringify({ error: "Too many attempts. Try again shortly." }), {
      status: 429,
      headers: { "retry-after": String(limited.retryAfterSeconds) },
    });
  }

  // Locate the intent by its gateway order id so a tampered body cannot point
  // a capture at someone else's order.
  const payment = await queryOne<{ id: number; request_id: number; customer_id: number | null }>(
    "SELECT id, request_id, customer_id FROM payments WHERE razorpay_order_id = $1",
    [data.razorpayOrderId]
  );
  if (!payment) return error(404, "Unknown payment order");
  if (payment.customer_id !== ctx.user.id) return error(403, "Not your payment");

  try {
    await capturePayment({
      paymentId: payment.id,
      razorpayOrderId: data.razorpayOrderId,
      razorpayPaymentId: data.razorpayPaymentId,
      razorpaySignature: data.razorpaySignature,
    });
  } catch (e) {
    if (e instanceof PaymentError) return error(e.status, e.message);
    // eslint-disable-next-line no-console
    console.error(e);
    return error(502, "Could not complete the payment");
  }

  await recordAudit({
    actorUserId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "payment.captured",
    entityType: "payment",
    entityId: payment.id,
    meta: { requestId: payment.request_id },
  });
  return json({ ok: true, payment: await paymentView(payment.request_id) });
});