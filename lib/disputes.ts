/**
 * Disputes — what happens when a refund is no longer possible.
 *
 * A refund can only return money that is still ours to return. Once the payout
 * has been released to the pharmacy, giving the customer their money back means
 * recovering it from the pharmacy, which is a different thing entirely: it needs
 * a person, a reason and a record.
 *
 * So the model is deliberately split:
 *   - before the payout (Captured) a dispute can be resolved by a real gateway
 *     refund, and this module performs one;
 *   - after the payout (PaidOut) a dispute resolves into an *obligation*
 *     (`recoverable_paise`) recorded against the pharmacy, and the UI says the
 *     recovery is offline. Nothing here pretends money moved.
 */
import { queryAll, queryOne, queryReturning, nowIso } from "./db";
import { recordAudit } from "./audit";
import { PAYMENT_STATUS, refundPaymentForRequest, type PaymentRow } from "./payments";

export const DISPUTE_STATUS = {
  OPEN: "Open",
  RESPONDED: "Responded",
  REFUND_APPROVED: "RefundApproved",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
} as const;
export type DisputeStatus = (typeof DISPUTE_STATUS)[keyof typeof DISPUTE_STATUS];

export const DISPUTE_CATEGORIES = [
  "not_delivered",
  "wrong_item",
  "damaged",
  "overcharged",
  "other",
] as const;
export type DisputeCategory = (typeof DISPUTE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DisputeCategory, string> = {
  not_delivered: "Never arrived",
  wrong_item: "Wrong medicine",
  damaged: "Damaged or unusable",
  overcharged: "Charged the wrong amount",
  other: "Something else",
};

export interface DisputeRow {
  id: number;
  request_id: number;
  payment_id: number | null;
  raised_by: number | null;
  raised_by_role: string;
  category: DisputeCategory;
  reason: string;
  status: DisputeStatus;
  response: string | null;
  responded_by: number | null;
  responded_at: string | null;
  resolution: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
  recoverable_paise: number;
  created_at: string;
  updated_at: string;
}

export class DisputeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DisputeError";
    this.status = status;
  }
}

/**
 * Opens a dispute against a paid order.
 *
 * Only the customer who placed it may raise one, and only once per order while
 * it is unresolved — otherwise a single problem becomes an endless queue for the
 * pharmacy to answer.
 */
export async function raiseDispute(input: {
  requestId: number;
  actor: { userId: number; role: string };
  category: DisputeCategory;
  reason: string;
}): Promise<DisputeRow> {
  const req = await queryOne<{ customer_id: number | null; status: string }>(
    "SELECT customer_id, status FROM requests WHERE id = $1",
    [input.requestId]
  );
  if (!req) throw new DisputeError("Request not found", 404);
  if (input.actor.role !== "customer" || req.customer_id !== input.actor.userId) {
    throw new DisputeError("Only the customer who placed this order can dispute it", 403);
  }

  const payment = await queryOne<PaymentRow>("SELECT * FROM payments WHERE request_id = $1", [
    input.requestId,
  ]);
  // Disputing an order that was never paid for is a support question, not a
  // money question.
  if (!payment) throw new DisputeError("This order has no payment to dispute", 409);

  const open = await queryOne<{ id: number }>(
    `SELECT id FROM disputes
      WHERE request_id = $1 AND status IN ('Open','Responded')
      LIMIT 1`,
    [input.requestId]
  );
  if (open) throw new DisputeError("There is already an open dispute on this order", 409);

  const now = nowIso();
  const row = await queryReturning<DisputeRow>(
    `INSERT INTO disputes (request_id, payment_id, raised_by, raised_by_role, category, reason,
                            status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Open', $7, $7)
     RETURNING *`,
    [
      input.requestId,
      payment.id,
      input.actor.userId,
      input.actor.role,
      input.category,
      input.reason.slice(0, 1000),
      now,
    ]
  );
  await recordAudit({
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    action: "dispute.raised",
    entityType: "dispute",
    entityId: row!.id,
    meta: { requestId: input.requestId, category: input.category },
  });
  return row!;
}

/** The pharmacy's reply. Keeps the customer and the pharmacy on the record. */
export async function respondToDispute(input: {
  disputeId: number;
  actor: { userId: number; role: string; pharmacyId: number | null };
  response: string;
}): Promise<DisputeRow> {
  const dispute = await queryOne<DisputeRow & { pharmacy_id: number | null }>(
    `SELECT d.*, r.preferred_pharmacy_id AS pharmacy_id
       FROM disputes d JOIN requests r ON r.id = d.request_id
      WHERE d.id = $1`,
    [input.disputeId]
  );
  if (!dispute) throw new DisputeError("Dispute not found", 404);
  if (input.actor.role === "admin") {
    /* admins may respond anywhere */
  } else if (dispute.pharmacy_id !== input.actor.pharmacyId) {
    throw new DisputeError("Not your pharmacy", 403);
  }
  if (dispute.status !== DISPUTE_STATUS.OPEN) {
    throw new DisputeError(`Cannot respond to a ${dispute.status.toLowerCase()} dispute`, 409);
  }

  const row = await queryReturning<DisputeRow>(
    `UPDATE disputes SET response = $1, responded_by = $2, responded_at = $3,
            status = 'Responded', updated_at = $3
      WHERE id = $4 RETURNING *`,
    [input.response.slice(0, 1000), input.actor.userId, nowIso(), input.disputeId]
  );
  await recordAudit({
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    action: "dispute.responded",
    entityType: "dispute",
    entityId: input.disputeId,
  });
  return row!;
}

/**
 * Admin decision.
 *
 * `refund` does one of two honest things, depending on where the money is:
 *   - still captured  → a real gateway refund, recorded as done;
 *   - already paid out → an obligation against the pharmacy, with the note that
 *     recovery is offline. No gateway call is attempted and nothing is faked.
 */
export async function resolveDispute(input: {
  disputeId: number;
  actor: { userId: number; role: string };
  outcome: "refund" | "reject";
  note: string;
}): Promise<{ dispute: DisputeRow; refundedPaise: number | null; offline: boolean }> {
  const dispute = await queryOne<DisputeRow>("SELECT * FROM disputes WHERE id = $1", [input.disputeId]);
  if (!dispute) throw new DisputeError("Dispute not found", 404);
  if (dispute.status === DISPUTE_STATUS.REFUND_APPROVED || dispute.status === DISPUTE_STATUS.REJECTED) {
    throw new DisputeError("This dispute is already resolved", 409);
  }

  const now = nowIso();

  if (input.outcome === "reject") {
    const row = (
      await queryReturning<DisputeRow>(
        `UPDATE disputes SET status = 'Rejected', resolution = $1, resolved_by = $2,
                resolved_at = $3, updated_at = $3
          WHERE id = $4 RETURNING *`,
        [input.note.slice(0, 1000), input.actor.userId, now, input.disputeId]
      )
    )!;
    await recordAudit({
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      action: "dispute.rejected",
      entityType: "dispute",
      entityId: input.disputeId,
    });
    return { dispute: row, refundedPaise: null, offline: false };
  }

  const payment = dispute.payment_id
    ? await queryOne<PaymentRow>("SELECT * FROM payments WHERE id = $1", [dispute.payment_id])
    : null;

  if (!payment) throw new DisputeError("No payment attached to this dispute", 409);

  if (payment.status === PAYMENT_STATUS.PAID_OUT) {
    const amount = payment.pharmacy_amount_paise;
    const row = (
      await queryReturning<DisputeRow>(
        `UPDATE disputes SET status = 'RefundApproved', resolution = $1, resolved_by = $2,
                resolved_at = $3, updated_at = $3, recoverable_paise = $4
          WHERE id = $5 RETURNING *`,
        [
          `${input.note.slice(0, 900)} — recorded as an obligation: the payout has already reached the pharmacy, so recovery is handled offline.`,
          input.actor.userId,
          now,
          amount,
          input.disputeId,
        ]
      )
    )!;
    await recordAudit({
      actorUserId: input.actor.userId,
      actorRole: input.actor.role,
      action: "dispute.refund_recorded_offline",
      entityType: "dispute",
      entityId: input.disputeId,
      meta: { recoverablePaise: amount },
    });
    return { dispute: row, refundedPaise: null, offline: true };
  }

  if (payment.status === PAYMENT_STATUS.REFUNDED) {
    const row = (
      await queryReturning<DisputeRow>(
        `UPDATE disputes SET status = 'RefundApproved', resolution = $1, resolved_by = $2,
                resolved_at = $3, updated_at = $3
          WHERE id = $4 RETURNING *`,
        [`${input.note.slice(0, 900)} — already refunded.`, input.actor.userId, now, input.disputeId]
      )
    )!;
    return { dispute: row, refundedPaise: 0, offline: false };
  }

  // Still refundable: do the real thing rather than recording an intention.
  await refundPaymentForRequest(
    dispute.request_id,
    { userId: input.actor.userId, role: input.actor.role },
    `Dispute #${dispute.id}: ${input.note}`
  );
  const row = (
    await queryReturning<DisputeRow>(
      `UPDATE disputes SET status = 'RefundApproved', resolution = $1, resolved_by = $2,
              resolved_at = $3, updated_at = $3
        WHERE id = $4 RETURNING *`,
      [`${input.note.slice(0, 900)} — refunded through the gateway.`, input.actor.userId, now, input.disputeId]
    )
  )!;
  await recordAudit({
    actorUserId: input.actor.userId,
    actorRole: input.actor.role,
    action: "dispute.refunded",
    entityType: "dispute",
    entityId: input.disputeId,
    meta: { amountPaise: payment.amount_paise },
  });
  return { dispute: row, refundedPaise: payment.amount_paise, offline: false };
}

export async function listDisputesForRequest(requestId: number): Promise<DisputeRow[]> {
  return queryAll<DisputeRow>("SELECT * FROM disputes WHERE request_id = $1 ORDER BY id DESC", [
    requestId,
  ]);
}

/** Everything still needing a decision, newest first. */
export async function listOpenDisputes(): Promise<
  (DisputeRow & { customer_name: string; pharmacy_name: string | null; amount_paise: number | null })[]
> {
  return queryAll(
    `SELECT d.*, r.customer_name, p.name AS pharmacy_name, pay.amount_paise
       FROM disputes d
       JOIN requests r ON r.id = d.request_id
       LEFT JOIN pharmacies p ON p.id = r.preferred_pharmacy_id
       LEFT JOIN payments pay ON pay.request_id = d.request_id
      WHERE d.status IN ('Open','Responded')
      ORDER BY d.id DESC`
  );
}

/** Disputes on a pharmacy's own orders, so it can answer them. */
export async function listDisputesForPharmacy(pharmacyId: number): Promise<
  (DisputeRow & { customer_name: string; amount_paise: number | null })[]
> {
  return queryAll(
    `SELECT d.*, r.customer_name, pay.amount_paise
       FROM disputes d
       JOIN requests r ON r.id = d.request_id
       LEFT JOIN payments pay ON pay.request_id = d.request_id
      WHERE r.preferred_pharmacy_id = $1
      ORDER BY d.id DESC LIMIT 100`,
    [pharmacyId]
  );
}