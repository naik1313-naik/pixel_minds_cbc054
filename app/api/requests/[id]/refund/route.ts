import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { getRequestDetail } from "@/lib/engine";
import { canViewRequest } from "@/lib/access";
import {
  PAYMENT_STATUS,
  PaymentError,
  getPaymentForRequest,
  paymentView,
  refundPaymentForRequest,
} from "@/lib/payments";

export const runtime = "nodejs";

/**
 * Refunds a customer payment.
 *
 * Restricted to the fulfilling pharmacy and admins, and only while the money is
 * still ours to return — that is, after capture but before the payout is
 * released. Once a pharmacy has been paid, a refund is not a technical operation
 * any more: it is money owed in the opposite direction, which needs a person and
 * a reason. This route refuses that case explicitly rather than half-performing
 * it, because a "refund" that quietly does nothing is worse than an error.
 */
export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");

  const detail = await getRequestDetail(id);
  if (!detail) return error(404, "Request not found");
  const isAdmin = ctx.user.role === "admin";
  const isOwnPharmacy =
    detail.request.preferred_pharmacy_id != null &&
    detail.request.preferred_pharmacy_id === ctx.user.pharmacy_id;
  if (!isAdmin && !isOwnPharmacy) return error(403, "Not your pharmacy");
  void canViewRequest;

  const body = (await req.json().catch(() => null)) as { reason?: string } | null;
  const reason = (body?.reason ?? "Refunded by pharmacy").toString().slice(0, 300);

  const payment = await getPaymentForRequest(id);
  if (!payment) return error(404, "This request has no payment");

  if (payment.status === PAYMENT_STATUS.PAID_OUT) {
    return error(
      409,
      "This payout has already been released to the pharmacy. Reverse it through a dispute, not a refund."
    );
  }
  if (payment.status === PAYMENT_STATUS.REFUNDED) {
    return json({ ok: true, already: true, payment: await paymentView(id) });
  }
  if (payment.status === PAYMENT_STATUS.CREATED || payment.status === PAYMENT_STATUS.AWAITING) {
    return error(409, "Nothing was captured for this order, so there is nothing to refund");
  }

  try {
    await refundPaymentForRequest(id, { userId: ctx.user.id, role: ctx.user.role }, reason);
  } catch (e) {
    if (e instanceof PaymentError) return error(e.status, e.message);
    throw e;
  }
  return json({ ok: true, payment: await paymentView(id) });
});