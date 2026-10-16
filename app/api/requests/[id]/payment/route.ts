import { guard, json, error } from "@/lib/api-utils";
import { canViewRequest } from "@/lib/access";
import { getRequestDetail } from "@/lib/engine";
import { PaymentError, ensureGatewayOrder, getPaymentForRequest, paymentView } from "@/lib/payments";

export const runtime = "nodejs";

/**
 * GET  — payment state plus the on-chain settlement receipt for this request.
 * POST — opens (or reuses) the gateway order the customer pays against.
 *
 * Only the customer who placed the order, the fulfilling pharmacy and admins
 * may read this. The merchant key secret never leaves the server: the Checkout
 * signature is computed here and the key id is the only browser-visible value.
 */
export const GET = guard(null, async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const detail = await getRequestDetail(id);
  if (!detail?.request) return error(404, "Request not found");
  if (!(await canViewRequest(ctx.user, detail.request))) return error(403, "Forbidden");
  return json({ payment: await paymentView(id) });
});

export const POST = guard(["customer"], async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const detail = await getRequestDetail(id);
  if (!detail?.request) return error(404, "Request not found");
  if (detail.request.customer_id !== ctx.user.id) return error(403, "Not your request");

  const payment = await getPaymentForRequest(id);
  // The amount is only owed once a pharmacy has confirmed the order, so the
  // intent does not exist before that.
  if (!payment) return error(409, "Payment opens once the pharmacy confirms this order");

  try {
    const order = await ensureGatewayOrder(payment.id);
    return json({
      paymentId: payment.id,
      gateway: payment.gateway,
      amountPaise: payment.amount_paise,
      currency: payment.currency,
      razorpayOrderId: order.id,
      razorpayKeyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? null,
    });
  } catch (e) {
    if (e instanceof PaymentError) return error(e.status, e.message);
    // eslint-disable-next-line no-console
    console.error(e);
    return error(502, "Payment gateway is unavailable. Try again shortly.");
  }
});