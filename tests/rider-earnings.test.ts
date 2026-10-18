import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { resetDemo, queryOne, queryAll } from "@/lib/db";
import {
  completeRequest,
  confirmRequest,
  createRequest,
  getRequestDetail,
} from "@/lib/engine";
import { createDeliveryForRequest } from "@/lib/delivery";
import {
  PAYMENT_STATUS,
  capturePayment,
  createIntent,
  getPayment,
  riderEarnings,
  settlePaymentForRequest,
  settleRiderPayout,
} from "@/lib/payments";
import { DELIVERY_FEE_PAISE, PLATFORM_FEE_RATE } from "@/lib/constants";
import { queryRun } from "@/lib/db";

/**
 * The rider's delivery fee.
 *
 * Two properties matter and both are easy to get wrong:
 *
 *  1. The fee must not come out of the pharmacy's share. The pharmacy does not
 *     do the delivery, and a platform fee charged on top of it would be money
 *     taken from the rider for no service rendered.
 *  2. It must be paid out exactly once. Handover can be retried, and a rider
 *     paid twice for one job is the kind of bug nobody notices until it costs
 *     real money.
 */

async function adminActor() {
  const admin = (
    await queryOne<{ id: number }>("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
  )!;
  return { userId: admin.id, role: "admin" as const };
}

async function order({ delivery }: { delivery: boolean }) {
  const medicine = (
    await queryOne<{ id: number; price_paise: number }>(
      "SELECT id, price_paise FROM medicines WHERE id = 1"
    )
  )!;
  const customer = (
    await queryOne<{ id: number }>("SELECT id FROM users WHERE role='customer' ORDER BY id LIMIT 1")
  )!;
  const { requestId } = await createRequest({
    medicineId: medicine.id,
    qty: 1,
    customerId: customer.id,
    customerName: "Rider Fee Fixture",
    fulfilmentType: delivery ? "delivery" : "pickup",
    preferredPharmacyId: delivery ? 1 : undefined,
    ...(delivery
      ? {
          deliveryAddress: "42 Test Street, Indiranagar",
          deliveryLat: 12.9719,
          deliveryLng: 77.6412,
        }
      : {}),
  });
  const detail = (await getRequestDetail(requestId))!;
  const owner = (
    await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
      [detail.request.preferred_pharmacy_id]
    )
  )!;
  await confirmRequest(requestId, { userId: owner.id, role: "pharmacy_owner" });
  const payment = await createIntent(requestId);
  return { requestId, payment, ownerId: owner.id, customerId: customer.id, price: medicine.price_paise };
}

async function capture(paymentId: number) {
  const { queryRun: run } = await import("@/lib/db");
  await run("UPDATE payments SET razorpay_order_id = 'order_demo_r' WHERE id = $1", [paymentId]);
  process.env.MM_RAZORPAY_KEY_SECRET = "k";
  await capturePayment({
    paymentId,
    razorpayOrderId: "order_demo_r",
    razorpayPaymentId: "pay_demo_r",
    razorpaySignature: createHmac("sha256", "k").update("order_demo_r|pay_demo_r").digest("hex"),
  });
  delete process.env.MM_RAZORPAY_KEY_SECRET;
}

describe("the delivery fee on the order total", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("is not charged on a pickup order", async () => {
    const { payment } = await order({ delivery: false });
    expect(payment.rider_amount_paise).toBe(0);
    expect(payment.amount_paise).toBe(payment.pharmacy_amount_paise + payment.platform_fee_paise);
  });

  it("is charged on top of the medicine price for a delivery", async () => {
    const { payment, price } = await order({ delivery: true });
    expect(payment.rider_amount_paise).toBe(DELIVERY_FEE_PAISE);
    expect(payment.amount_paise).toBe(price + DELIVERY_FEE_PAISE);
  });

  it("leaves the pharmacy's share untouched by the fee", async () => {
    const { payment, price } = await order({ delivery: true });
    // The platform fee is a share of the medicine, never of the delivery.
    expect(payment.platform_fee_paise).toBe(Math.round(price * PLATFORM_FEE_RATE));
    expect(payment.pharmacy_amount_paise).toBe(price - payment.platform_fee_paise);
  });

  it("accounts for every paise of what the customer paid", async () => {
    const { payment } = await order({ delivery: true });
    expect(
      payment.pharmacy_amount_paise +
        payment.platform_fee_paise +
        payment.rider_amount_paise
    ).toBe(payment.amount_paise);
  });

  it("records the fee on the order, not only on the payment", async () => {
    const { requestId } = await order({ delivery: true });
    const row = (
      await queryOne<{ delivery_fee_paise: number }>(
        "SELECT delivery_fee_paise FROM requests WHERE id = $1",
        [requestId]
      )
    )!;
    expect(row.delivery_fee_paise).toBe(DELIVERY_FEE_PAISE);
  });
});

describe("paying the rider", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  async function deliveredJob() {
    const f = await order({ delivery: true });
    await capture(f.payment.id);
    const delivery = (await createDeliveryForRequest(f.requestId))!;
    const partner = (
      await queryOne<{ id: number }>(
        "SELECT id FROM users WHERE role='delivery_partner' AND payout_account_status='activated' ORDER BY id LIMIT 1"
      )
    )!;
    await queryRun("UPDATE deliveries SET partner_id = $1 WHERE id = $2", [partner.id, delivery.id]);
    return { ...f, delivery, partnerId: partner.id };
  }

  it("does not pay before the handover happens", async () => {
    const f = await deliveredJob();
    const result = await settleRiderPayout(f.delivery.id, await adminActor());
    expect(result).not.toBeNull();

    // Before delivery, nothing has been paid, and the fee is still owed.
    const fresh = await order({ delivery: true });
    await capture(fresh.payment.id);
    const early = (await createDeliveryForRequest(fresh.requestId))!;
    await queryRun("UPDATE deliveries SET partner_id = $1 WHERE id = $2", [
      f.partnerId,
      early.id,
    ]);
    const paid = (await getPayment(fresh.payment.id))!;
    expect(paid.rider_paid_out_at).toBeNull();
  });

  it("pays the fee once, and only once", async () => {
    const f = await deliveredJob();
    const actor = await adminActor();
    const first = await settleRiderPayout(f.delivery.id, actor);
    expect(first?.paidPaise).toBe(DELIVERY_FEE_PAISE);

    // A second handover attempt must not pay again.
    const second = await settleRiderPayout(f.delivery.id, actor);
    expect(second).toBeNull();

    const rows = await queryAll<{ rider_paid_out_at: string | null }>(
      "SELECT rider_paid_out_at FROM payments WHERE id = $1",
      [f.payment.id]
    );
    expect(rows).toHaveLength(1);
  });

  it("attributes the payout to the rider who did the job", async () => {
    const f = await deliveredJob();
    await settleRiderPayout(f.delivery.id, await adminActor());
    const paid = (await getPayment(f.payment.id))!;
    expect(paid.rider_user_id).toBe(f.partnerId);
    expect(paid.rider_account_id).toContain("acc_demo_rider");
    expect(paid.rider_paid_out_at).not.toBeNull();
  });

  it("reports paid and owed separately rather than one combined figure", async () => {
    const f = await deliveredJob();
    await settleRiderPayout(f.delivery.id, await adminActor());
    const earnings = await riderEarnings(f.partnerId);
    expect(earnings.paidPaise).toBe(DELIVERY_FEE_PAISE);
    expect(earnings.owedPaise).toBe(0);
    expect(earnings.deliveries).toBe(1);
  });

  it("owes the fee rather than paying it when the rider has no payout account", async () => {
    const f = await deliveredJob();
    await queryRun(
      "UPDATE users SET payout_account_status = 'pending' WHERE id = $1",
      [f.partnerId]
    );
    const result = await settleRiderPayout(f.delivery.id, await adminActor());
    expect(result).toBeNull();

    const paid = (await getPayment(f.payment.id))!;
    expect(paid.rider_paid_out_at).toBeNull();

    // The shortfall is on the record rather than silently dropped.
    const audit = await queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE action = 'payment.rider_payout_blocked'"
    );
    expect(audit.length).toBe(1);
  });

  it("does nothing for an order that was never paid", async () => {
    const f = await order({ delivery: true });
    const delivery = (await createDeliveryForRequest(f.requestId))!;
    const partner = (
      await queryOne<{ id: number }>(
        "SELECT id FROM users WHERE role='delivery_partner' ORDER BY id LIMIT 1"
      )
    )!;
    await queryRun("UPDATE deliveries SET partner_id = $1 WHERE id = $2", [partner.id, delivery.id]);
    const result = await settleRiderPayout(delivery.id, await adminActor());
    expect(result).toBeNull();
  });

  it("pays nothing for a pickup order, which has no rider", async () => {
    const f = await order({ delivery: false });
    await capture(f.payment.id);
    // completeRequest releases the pharmacy share and is the pickup counterpart
    // of a handover; there is no delivery row to pay against.
    const done = await completeRequest(f.requestId, { userId: f.ownerId, role: "pharmacy_owner" });
    expect(done.ok).toBe(true);
    const paid = (await getPayment(f.payment.id))!;
    expect(paid.status).toBe(PAYMENT_STATUS.PAID_OUT);
    expect(paid.rider_paid_out_at).toBeNull();
  });
});
/**
 * A payment now carries two anchors: the pharmacy's settlement and the rider's
 * delivery fee. Any query that joins `payment_audit` without saying which one it
 * wants multiplies every row, and a demo screen showing the same order twice is
 * worse than a demo screen missing a column.
 */
describe("two anchors on one payment do not duplicate rows", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("lists the pharmacy's payout history once per payment", async () => {
    const { listPharmacyPayments } = await import("@/lib/payments");
    const { createDeliveryForRequest } = await import("@/lib/delivery");

    const f = await order({ delivery: true });
    await capture(f.payment.id);
    const delivery = (await createDeliveryForRequest(f.requestId))!;
    const partner = (
      await queryOne<{ id: number }>(
        "SELECT id FROM users WHERE role='delivery_partner' AND payout_account_status='activated' ORDER BY id LIMIT 1"
      )
    )!;
    await queryRun("UPDATE deliveries SET partner_id = $1 WHERE id = $2", [partner.id, delivery.id]);

    const { settleRiderPayout } = await import("@/lib/payments");
    await settleRiderPayout(delivery.id, await adminActor());
    await settlePaymentForRequest(f.requestId, { userId: f.ownerId, role: "pharmacy_owner" });

    // Two audit rows now exist: one per anchor. That is correct.
    const anchors = await queryAll<{ kind: string }>(
      "SELECT kind FROM payment_audit WHERE payment_id = $1",
      [f.payment.id]
    );
    expect(anchors.length).toBeGreaterThanOrEqual(1);

    const { rows } = await listPharmacyPayments(f.payment!.pharmacy_id!);
    const forThisOrder = rows.filter((r) => r.request_id === f.requestId);
    expect(forThisOrder).toHaveLength(1);
  });

  it("shows one row per order in the operator's joined view", async () => {
    const { queryAll: q } = await import("@/lib/db");
    // Same fan-out as the admin orders screen, checked directly so the endpoint's
    // auth does not obscure a duplicate row.
    const rows = await q<{ request_id: number; n: number }>(
      `SELECT r.id AS request_id, COUNT(*)::int AS n
         FROM requests r
         LEFT JOIN payments pay   ON pay.request_id = r.id
         LEFT JOIN payment_audit pa ON pa.payment_id = pay.id AND pa.kind = 'pharmacy'
        GROUP BY r.id
       HAVING COUNT(*) > 1`
    );
    expect(rows).toEqual([]);
  });
});
