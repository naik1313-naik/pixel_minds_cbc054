import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { deliveryMilestoneSchema } from "@/lib/validation";
import { recordDeliveryMilestone, listDeliveryAudit, getOrderRefForRequest } from "@/lib/blockchain/ledger";
import { queryOne } from "@/lib/db";
import { canViewDelivery } from "@/lib/access";
import { publish, channels } from "@/lib/sse";

export const runtime = "nodejs";

/**
 * Reads the delivery audit trail.
 *
 * Visibility reuses the existing canViewDelivery rule: the customer who owns
 * the request, the fulfilling pharmacy, the assigned rider, or an admin.
 */
export const GET = guard(null, async (ctx, req: NextRequest, params) => {
  const deliveryId = Number(params.orderId);
  const delivery = await queryOne<{
    id: number;
    request_id: number;
    pharmacy_id: number;
    partner_id: number | null;
    status: string;
    customer_id: number | null;
  }>(
    `SELECT d.id, d.request_id, d.pharmacy_id, d.partner_id, d.status, r.customer_id
       FROM deliveries d JOIN requests r ON r.id = d.request_id
      WHERE d.id = $1`,
    [deliveryId]
  );
  if (!delivery) return error(404, "Delivery not found");

  if (!(await canViewDelivery(ctx.user, delivery))) {
    return error(403, "Forbidden");
  }

  const audit = await listDeliveryAudit(deliveryId);
  const orderRef = await getOrderRefForRequest(delivery.request_id);  return json({
    deliveryId,
    requestId: delivery.request_id,
    deliveryStatus: delivery.status,
    orderRef,
    // Note: the on-chain order reference is a hash. Customer identity is never
    // written to the chain.
    milestones: audit,
  });
});

/**
 * Records a delivery milestone.
 *
 * Only an assigned delivery partner (or the fulfilling pharmacy for the Packed
 * milestone) may submit. A customer can never mark their own parcel delivered —
 * that would defeat the audit trail entirely.
 */
export const POST = guard(["delivery_partner", "pharmacy_owner", "pharmacy_staff"], async (ctx, req, params) => {
  const deliveryId = Number(params.orderId);
  const body = await req.json().catch(() => null);
  const parsed = deliveryMilestoneSchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");
  const { milestone } = parsed.data;

  const delivery = await queryOne<{
    id: number;
    request_id: number;
    pharmacy_id: number;
    partner_id: number | null;
    status: string;
  }>("SELECT id, request_id, pharmacy_id, partner_id, status FROM deliveries WHERE id = $1", [deliveryId]);
  if (!delivery) return error(404, "Delivery not found");

  // Authorization: the assigned rider, or the pharmacy for Packed only.
  if (ctx.user.role === "delivery_partner") {
    if (delivery.partner_id !== ctx.user.id) {
      return error(403, "You are not the assigned partner for this delivery");
    }
  } else if (ctx.user.role === "pharmacy_owner" || ctx.user.role === "pharmacy_staff") {
    if (milestone !== "Packed") {
      return error(403, "A pharmacy may only record the Packed milestone");
    }
    if (ctx.user.pharmacy_id !== delivery.pharmacy_id) {
      return error(403, "This delivery belongs to another pharmacy");
    }
  }

  try {
    const row = await recordDeliveryMilestone({
      deliveryId,
      milestone,
      actor: { userId: ctx.user.id, role: ctx.user.role },
    });

    // Published only after a confirmed receipt.
    publish(channels.delivery(deliveryId), {
      type: "delivery.milestone.recorded",
      deliveryId,
      milestone: row.milestone,
      txHash: row.tx_hash,
    });
    publish(channels.request(delivery.request_id), {
      type: "delivery.milestone.recorded",
      deliveryId,
      milestone: row.milestone,
      txHash: row.tx_hash,
    });

    return json({ milestone: row }, 201);
  } catch (e) {
    return error(502, e instanceof Error ? e.message : "Milestone submission failed");
  }
});
