/**
 * Customer payments and pharmacy settlements.
 *
 * Flow, and who owns what at each step:
 *
 *   confirm order ──> createIntent   ──> payment row (Awaiting) + gateway order
 *   customer pays ──> capturePayment ──> gateway captures, routing the pharmacy
 *                                         owner's share to their linked account
 *   fulfilment done ─> settlePayment ─> PaidOut + on-chain settlement record
 *
 * Design rules:
 *  - The database is the source of truth for money. The chain is an audit
 *    anchor only; it holds no value and cannot prove a bank transfer happened.
 *  - Money never rests in a MediMesh balance beyond the platform fee.
 *  - A gateway outage must never block fulfilment. Settlement is recorded in the
 *    database first and pushed to the chain afterwards, so a dead RPC degrades
 *    the audit trail instead of the medicine supply.
 *  - Every step is idempotent. There are two independent completion paths
 *    (engine.completeRequest for pickup, delivery.finalizeDeliveredRequest for
 *    delivery) and both call settlePaymentForRequest.
 */
import { queryAll, queryOne, queryRun, queryReturning, nowIso } from "./db";
import { PLATFORM_FEE_RATE, rupees } from "./constants";
import { recordAudit } from "./audit";
import { channels, publish } from "./sse";
import { getNotificationProvider } from "./providers";
import {
  GatewayError,
  getPaymentGateway,
  type GatewayOrder,
} from "./razorpay";
import {
  METADATA_SCHEMA_VERSION,
  type SettlementMetadata,
} from "./blockchain/hashes";
import { recordSettlementOnChain } from "./blockchain/settlements";

export const PAYMENT_STATUS = {
  CREATED: "Created",
  AWAITING: "Awaiting",
  CAPTURED: "Captured",
  PAID_OUT: "PaidOut",
  REFUNDED: "Refunded",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export class PaymentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PaymentError";
    this.status = status;
  }
}

export interface PaymentRow {
  id: number;
  request_id: number;
  customer_id: number | null;
  pharmacy_id: number | null;
  amount_paise: number;
  platform_fee_paise: number;
  pharmacy_amount_paise: number;
  currency: string;
  gateway: string;
  status: PaymentStatus;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  razorpay_transfer_id: string | null;
  beneficiary_account_id: string | null;
  failure_reason: string | null;
  captured_at: string | null;
  paid_out_at: string | null;
  refunded_at: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentAuditRow {
  id: number;
  payment_id: number;
  settlement_ref: string;
  settlement_ref_hash: string;
  order_ref: string;
  order_ref_hash: string;
  amount_paise: number;
  metadata_hash: string;
  metadata_json: string | null;
  gateway_ref_hash: string;
  beneficiary_wallet: string | null;
  pharmacy_id: number | null;
  status: string;
  tx_hash: string | null;
  block_number: number | null;
  error: string | null;
  settled_at: string | null;
}

/**
 * Splits a customer total into the routed pharmacy amount and the platform fee.
 * Rounding is done once, on the fee, so `pharmacyAmount + fee` always
 * reconstructs the charged total exactly.
 */
export function splitAmount(amountPaise: number): {
  pharmacyAmountPaise: number;
  platformFeePaise: number;
} {
  const platformFeePaise = Math.round(amountPaise * PLATFORM_FEE_RATE);
  return { platformFeePaise, pharmacyAmountPaise: amountPaise - platformFeePaise };
}

/**
 * Whether a pharmacy can currently receive a payout.
 *
 * A property of the pharmacy, not of any one payment. Reading it from a captured
 * row instead would report "not activated" for every payment that simply has not
 * been captured yet — which is most of them.
 */
export async function payoutAccountReadyFor(pharmacyId: number | null): Promise<boolean> {
  if (!pharmacyId) return false;
  const row = await queryOne<{ razorpay_account_id: string | null; payout_account_status: string | null }>(
    "SELECT razorpay_account_id, payout_account_status FROM pharmacies WHERE id = $1",
    [pharmacyId]
  );
  return Boolean(row?.razorpay_account_id) && row?.payout_account_status === "activated";
}

// ---------------------------------------------------------------- intents

/**
 * Freezes the order total and opens a payment intent.
 *
 * Called once, when the pharmacy confirms the request. The amount is derived
 * from the confirmed quantity and the catalogue price, never from the client,
 * so a tampered checkout cannot change what is owed.
 */
export async function createIntent(requestId: number): Promise<PaymentRow> {
  const req = await queryOne<{
    id: number;
    customer_id: number | null;
    medicine_id: number;
    qty: number;
    secured_qty: number;
    preferred_pharmacy_id: number | null;
    amount_paise: number | null;
    status: string;
  }>("SELECT * FROM requests WHERE id = $1", [requestId]);
  if (!req) throw new PaymentError("Request not found", 404);
  if (!req.preferred_pharmacy_id) throw new PaymentError("No pharmacy assigned yet", 409);

  const existing = await getPaymentForRequest(requestId);
  if (existing) return existing;

  // Only secured units can actually be delivered, so only they are billed.
  const billableQty = req.secured_qty > 0 ? req.secured_qty : req.qty;
  const medicine = await queryOne<{ price_paise: number }>(
    "SELECT price_paise FROM medicines WHERE id = $1",
    [req.medicine_id]
  );
  if (!medicine) throw new PaymentError("Medicine not found", 404);

  const amountPaise = medicine.price_paise * billableQty;
  if (amountPaise <= 0) throw new PaymentError("Order total is zero", 422);
  const { platformFeePaise, pharmacyAmountPaise } = splitAmount(amountPaise);

  const now = nowIso();
  const row = await queryReturning<PaymentRow>(
    `INSERT INTO payments
       (request_id, customer_id, pharmacy_id, amount_paise, platform_fee_paise, pharmacy_amount_paise,
        currency, gateway, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'INR', $7, $8, $9, $9)
     RETURNING *`,
    [
      requestId,
      req.customer_id,
      req.preferred_pharmacy_id,
      amountPaise,
      platformFeePaise,
      pharmacyAmountPaise,
      getPaymentGateway().name,
      PAYMENT_STATUS.AWAITING,
      now,
    ]
  );
  await queryRun(
    "UPDATE requests SET amount_paise = $1, platform_fee_paise = $2, payment_status = $3 WHERE id = $4",
    [amountPaise, platformFeePaise, PAYMENT_STATUS.AWAITING, requestId]
  );
  await recordAudit({
    action: "payment.intent_created",
    entityType: "payment",
    entityId: row!.id,
    meta: { requestId, amountPaise, currency: "INR" },
  });
  publish(channels.request(requestId), {
    type: "payment",
    requestId,
    paymentId: row!.id,
    status: PAYMENT_STATUS.AWAITING,
  });
  return row!;
}

/**
 * Returns (creating if needed) the gateway order the customer pays against.
 *
 * Idempotent on the gateway order id: an intent that already has one reuses it
 * rather than creating a second charge, so a retried "Pay now" cannot double
 * charge the customer.
 */
export async function ensureGatewayOrder(paymentId: number): Promise<GatewayOrder> {
  const payment = await getPayment(paymentId);
  if (!payment) throw new PaymentError("Payment not found", 404);
  if (payment.razorpay_order_id) {
    return {
      id: payment.razorpay_order_id,
      amountPaise: payment.amount_paise,
      currency: payment.currency,
    };
  }
  const order = await getPaymentGateway().createOrder({
    amountPaise: payment.amount_paise,
    // Receipts must be unique per attempt and reveal nothing about the patient.
    receipt: `req_${payment.request_id}`,
    notes: { requestId: String(payment.request_id) },
  });
  await queryRun(
    "UPDATE payments SET razorpay_order_id = $1, status = $2, updated_at = $3 WHERE id = $4",
    [order.id, PAYMENT_STATUS.AWAITING, nowIso(), paymentId]
  );
  return order;
}

// ---------------------------------------------------------------- capture

/**
 * Captures a successful checkout and routes the pharmacy owner's share to
 * their linked account.
 *
 * The client sends the gateway's order/payment ids plus the signature the
 * checkout returned; the signature is verified server-side against our own
 * secret, so a forged "I paid" body cannot create a capture.
 */
export async function capturePayment(input: {
  paymentId: number;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<PaymentRow> {
  const payment = await getPayment(input.paymentId);
  if (!payment) throw new PaymentError("Payment not found", 404);

  // Already captured/settled: return as-is so a webhook retry is harmless.
  if (
    payment.status === PAYMENT_STATUS.CAPTURED ||
    payment.status === PAYMENT_STATUS.PAID_OUT
  ) {
    return payment;
  }
  if (payment.status === PAYMENT_STATUS.REFUNDED || payment.status === PAYMENT_STATUS.CANCELLED) {
    throw new PaymentError(`Payment is already ${payment.status.toLowerCase()}`, 409);
  }
  if (payment.razorpay_order_id && payment.razorpay_order_id !== input.razorpayOrderId) {
    throw new PaymentError("Gateway order does not match this payment", 400);
  }
  if (
    !getPaymentGateway().verifyCheckout({
      orderId: input.razorpayOrderId,
      paymentId: input.razorpayPaymentId,
      signature: input.razorpaySignature,
    })
  ) {
    throw new PaymentError("Payment signature could not be verified", 400);
  }

  // Resolve the beneficiary at capture time: an owner may activate their
  // payout account between ordering and paying.
  const pharmacy = payment.pharmacy_id
    ? await queryOne<{ razorpay_account_id: string | null; payout_account_status: string | null }>(
        "SELECT razorpay_account_id, payout_account_status FROM pharmacies WHERE id = $1",
        [payment.pharmacy_id]
      )
    : null;
  const beneficiary = pharmacy?.razorpay_account_id ?? null;

  let capture;
  try {
    capture = await getPaymentGateway().capture({
      paymentId: input.razorpayPaymentId,
      amountPaise: payment.amount_paise,
      beneficiaryAccountId: beneficiary,
      beneficiaryAmountPaise: payment.pharmacy_amount_paise,
    });
  } catch (e) {
    const message = e instanceof GatewayError ? e.message : "Payment capture failed";
    await queryRun(
      "UPDATE payments SET status = $1, failure_reason = $2, updated_at = $3 WHERE id = $4",
      [PAYMENT_STATUS.FAILED, message.slice(0, 500), nowIso(), payment.id]
    );
    await queryRun("UPDATE requests SET payment_status = $1 WHERE id = $2", [
      PAYMENT_STATUS.FAILED,
      payment.request_id,
    ]);
    throw e instanceof GatewayError ? new PaymentError(message, e.status) : e;
  }

  const now = nowIso();
  return (
    await queryReturning<PaymentRow>(
      `UPDATE payments
          SET status = $1, razorpay_payment_id = $2, razorpay_transfer_id = $3,
              beneficiary_account_id = $4, captured_at = $5, failure_reason = NULL, updated_at = $5
        WHERE id = $6
        RETURNING *`,
      [
        PAYMENT_STATUS.CAPTURED,
        capture.paymentId,
        capture.transferId ?? null,
        beneficiary,
        now,
        payment.id,
      ]
    )
  )!;
}

// ---------------------------------------------------------------- settlement

/**
 * Marks a captured payment as paid out and anchors the settlement on-chain.
 *
 * Idempotent and safe to call from both completion paths. The chain write is
 * best-effort by design: the money already moved, so a dead RPC must not throw
 * an error back into the delivery flow. The audit row stays Pending/Failed and
 * the existing reconcile job can pick it up later.
 */
export async function settlePaymentForRequest(
  requestId: number,
  actor: { userId: number; role: string }
): Promise<PaymentRow | null> {
  const payment = await getPaymentForRequest(requestId);
  if (!payment) return null;
  if (payment.status === PAYMENT_STATUS.PAID_OUT) return payment;
  if (payment.status !== PAYMENT_STATUS.CAPTURED) {
    // Not paid yet (or already refunded). Nothing to route; the order can still
    // be completed — payment state is tracked independently of fulfilment.
    return payment;
  }

  const now = nowIso();
  // Guarded UPDATE ... WHERE status = 'Captured' so two concurrent completion
  // paths cannot both mark the payout; the loser falls through to the row as-is.
  const updated = await queryReturning<PaymentRow>(
    `UPDATE payments SET status = $1, paid_out_at = $2, settled_at = $2, updated_at = $2
      WHERE id = $3 AND status = $4
      RETURNING *`,
    [PAYMENT_STATUS.PAID_OUT, now, payment.id, PAYMENT_STATUS.CAPTURED]
  );
  const settled = updated ?? (await getPayment(payment.id))!;

  await queryRun("UPDATE requests SET payment_status = $1 WHERE id = $2", [
    PAYMENT_STATUS.PAID_OUT,
    requestId,
  ]);
  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "payment.paid_out",
    entityType: "payment",
    entityId: payment.id,
    meta: { requestId, pharmacyAmountPaise: payment.pharmacy_amount_paise },
  });
  publish(channels.request(requestId), {
    type: "payment",
    requestId,
    paymentId: payment.id,
    status: PAYMENT_STATUS.PAID_OUT,
  });
  if (payment.pharmacy_id) {
    publish(channels.pharmacy(payment.pharmacy_id), {
      type: "payment",
      requestId,
      paymentId: payment.id,
      status: PAYMENT_STATUS.PAID_OUT,
    });
  }

  try {
    await recordSettlementOnChain(payment.id, { userId: actor.userId, role: actor.role });
  } catch (e) {
    // The audit anchor is best-effort; never fail the fulfilment that triggered
    // it. The message is recorded on the audit row and is visible in admin.
    // eslint-disable-next-line no-console
    console.error("settlement anchor failed", e);
  }
  return settled;
}

/** Refunds a captured payment. No-op when nothing was captured. */
export async function refundPaymentForRequest(
  requestId: number,
  actor: { userId: number; role: string },
  reason: string
): Promise<PaymentRow | null> {
  const payment = await getPaymentForRequest(requestId);
  if (!payment) return null;
  if (payment.status === PAYMENT_STATUS.REFUNDED) return payment;
  // Once the payout has been released the money is owed in the *opposite*
  // direction, which is a dispute with a person attached — not a refund. Enforced
  // here rather than in the route, because this function has more than one
  // caller and a guard that lives in one of them is a guard that gets bypassed.
  if (payment.status === PAYMENT_STATUS.PAID_OUT) {
    throw new PaymentError(
      "Cannot refund an already paid-out payment. Raise a dispute with the pharmacy instead.",
      409
    );
  }
  if (!payment.razorpay_payment_id || payment.status === PAYMENT_STATUS.AWAITING) {
    await queryRun(
      "UPDATE payments SET status = $1, updated_at = $2 WHERE id = $3",
      [PAYMENT_STATUS.CANCELLED, nowIso(), payment.id]
    );
    await queryRun("UPDATE requests SET payment_status = $1 WHERE id = $2", [
      PAYMENT_STATUS.CANCELLED,
      requestId,
    ]);
    return getPayment(payment.id);
  }

  try {
    await getPaymentGateway().refund(payment.razorpay_payment_id, payment.amount_paise);
  } catch (e) {
    const message = e instanceof GatewayError ? e.message : "Refund failed";
    await recordAudit({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "payment.refund_failed",
      entityType: "payment",
      entityId: payment.id,
      meta: { reason: message },
    });
    throw new PaymentError(message, e instanceof GatewayError ? e.status : 502);
  }

  const now = nowIso();
  const refunded = (
    await queryReturning<PaymentRow>(
      `UPDATE payments SET status = $1, refunded_at = $2, settled_at = $2, failure_reason = $3, updated_at = $2
        WHERE id = $4 RETURNING *`,
      [PAYMENT_STATUS.REFUNDED, now, reason.slice(0, 500), payment.id]
    )
  )!;
  await queryRun("UPDATE requests SET payment_status = $1 WHERE id = $2", [
    PAYMENT_STATUS.REFUNDED,
    requestId,
  ]);
  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "payment.refunded",
    entityType: "payment",
    entityId: payment.id,
    meta: { requestId, amountPaise: payment.amount_paise },
  });
  publish(channels.request(requestId), {
    type: "payment",
    requestId,
    paymentId: payment.id,
    status: PAYMENT_STATUS.REFUNDED,
  });

  // The customer is told their money is on the way back. A refund nobody hears
  // about is the fastest way to turn a good-faith correction into a support
  // ticket, so this is one of the few notifications worth sending.
  const customer = payment.customer_id
    ? await queryOne<{ phone: string | null; name: string }>(
        "SELECT phone, name FROM users WHERE id = $1",
        [payment.customer_id]
      )
    : null;
  if (customer) {
    await getNotificationProvider().notify({
      to: customer.phone,
      message: `MediMesh: ${rupees(payment.amount_paise)} has been refunded for order #${requestId}. Reason: ${reason}`,
    });
  }

  return refunded;
}

// ---------------------------------------------------------------- queries

export async function getPayment(id: number): Promise<PaymentRow | null> {
  return (await queryOne<PaymentRow>("SELECT * FROM payments WHERE id = $1", [id])) ?? null;
}

export async function getPaymentForRequest(requestId: number): Promise<PaymentRow | null> {
  return (await queryOne<PaymentRow>("SELECT * FROM payments WHERE request_id = $1", [requestId])) ?? null;
}

export async function getPaymentAudit(paymentId: number): Promise<PaymentAuditRow | null> {
  return (await queryOne<PaymentAuditRow>("SELECT * FROM payment_audit WHERE payment_id = $1", [paymentId])) ?? null;
}

/** Payout history for one pharmacy owner, newest first, with totals. */
export async function listPharmacyPayments(pharmacyId: number, limit = 50) {
  const rows = await queryAll<
    PaymentRow & {
      medicine_name: string | null;
      settlement_ref: string | null;
      block_number: number | null;
    }
  >(
    `SELECT p.*, m.name AS medicine_name, pa.settlement_ref, pa.block_number
       FROM payments p
       LEFT JOIN payment_audit pa ON pa.payment_id = p.id
       LEFT JOIN medicines m ON m.id = (SELECT medicine_id FROM requests WHERE id = p.request_id)
      WHERE p.pharmacy_id = $1
      ORDER BY p.id DESC LIMIT $2`,
    [pharmacyId, Math.min(Math.max(limit, 1), 200)]
  );
  const totals = (
    await queryOne<{ paid_out_paise: number; captured_paise: number; count: number }>(
      `SELECT COALESCE(SUM(pharmacy_amount_paise) FILTER (WHERE status = 'PaidOut'), 0)::int AS paid_out_paise,
              COALESCE(SUM(pharmacy_amount_paise) FILTER (WHERE status = 'Captured'), 0)::int AS captured_paise,
              COUNT(*)::int AS count
         FROM payments WHERE pharmacy_id = $1`,
      [pharmacyId]
    )
  ) ?? { paid_out_paise: 0, captured_paise: 0, count: 0 };
  return { rows, totals };
}

/**
 * Customer-facing view of a request's payment. Contains gateway order ids and
 * amounts only — never the customer secret or an instrument detail.
 */
export async function paymentView(requestId: number) {
  const payment = await getPaymentForRequest(requestId);
  if (!payment) return null;
  const audit = await getPaymentAudit(payment.id);
  const payoutAccountReady = await payoutAccountReadyFor(payment.pharmacy_id);

  return {
    paymentId: payment.id,
    requestId: payment.request_id,
    status: payment.status,
    amountPaise: payment.amount_paise,
    platformFeePaise: payment.platform_fee_paise,
    pharmacyAmountPaise: payment.pharmacy_amount_paise,
    amountLabel: rupees(payment.amount_paise),
    currency: payment.currency,
    gateway: payment.gateway,
    razorpayOrderId: payment.razorpay_order_id,
    razorpayPaymentId: payment.razorpay_payment_id,
    razorpayTransferId: payment.razorpay_transfer_id,
    payoutAccountReady,
    // Retained for troubleshooting: the account id actually used at capture.
    beneficiaryAccountId: payment.beneficiary_account_id,
    capturedAt: payment.captured_at,
    paidOutAt: payment.paid_out_at,
    failureReason: payment.failure_reason,
    settlement: audit
      ? {
          settlementRef: audit.settlement_ref,
          settlementRefHash: audit.settlement_ref_hash,
          orderRef: audit.order_ref,
          status: audit.status,
          txHash: audit.tx_hash,
          blockNumber: audit.block_number,
          error: audit.error,
        }
      : null,
  };
}

/**
 * Builds the canonical settlement metadata for a captured payment.
 *
 * Exported for the test suite and for off-chain verification: recomputing this
 * hash and comparing it with the anchored value is what proves the reported
 * settlement metadata has not been altered since it was recorded. The opaque
 * references are passed in (not derived here) so the exact values that were
 * persisted in payment_audit are the ones being hashed.
 */
export function buildSettlementMetadata(input: {
  settlementRef: string;
  orderRef: string;
  pharmacyId: number;
  pharmacyAmountPaise: number;
  gatewayRef: string;
  settledAtIso: string;
}): SettlementMetadata {
  return {
    schema: METADATA_SCHEMA_VERSION,
    settlementRef: input.settlementRef,
    orderRef: input.orderRef,
    pharmacyId: input.pharmacyId,
    amountPaise: input.pharmacyAmountPaise,
    gatewayRef: input.gatewayRef,
    settledAt: input.settledAtIso,
  };
}