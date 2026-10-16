import { describe, it, expect, beforeEach } from "vitest";
import { resetDemo, queryOne, queryAll } from "@/lib/db";
import { createRequest, getRequestDetail, confirmRequest } from "@/lib/engine";
import {
  PAYMENT_STATUS,
  capturePayment,
  createIntent,
  getPayment,
  settlePaymentForRequest,
} from "@/lib/payments";
import {
  DISPUTE_STATUS,
  DisputeError,
  listDisputesForRequest,
  listOpenDisputes,
  raiseDispute,
  resolveDispute,
  respondToDispute,
} from "@/lib/disputes";
import { createHmac } from "crypto";

/**
 * Disputes exist because a refund stops being possible once the payout is out.
 * These tests pin down both halves of that rule — and, just as importantly,
 * that a resolution never claims money moved when it did not.
 */

async function paidOrder({ settle }: { settle: boolean }) {
  const medicine = (await queryOne<{ id: number }>(
    "SELECT id FROM medicines ORDER BY id LIMIT 1"
  ))!;
  const customer = (await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE role='customer' ORDER BY id LIMIT 1"
  ))!;
  const { requestId } = await createRequest({
    medicineId: medicine.id,
    qty: 1,
    customerId: customer.id,
    customerName: "Dispute Fixture",
    fulfilmentType: "pickup",
  });
  const detail = (await getRequestDetail(requestId))!;
  const owner = (await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
    [detail.request.preferred_pharmacy_id]
  ))!;
  await confirmRequest(requestId, { userId: owner.id, role: "pharmacy_owner" });

  const payment = await createIntent(requestId);
  const { queryRun } = await import("@/lib/db");
  await queryRun("UPDATE payments SET razorpay_order_id = 'order_demo_d' WHERE id = $1", [payment.id]);
  process.env.MM_RAZORPAY_KEY_SECRET = "k";
  await capturePayment({
    paymentId: payment.id,
    razorpayOrderId: "order_demo_d",
    razorpayPaymentId: "pay_demo_d",
    razorpaySignature: createHmac("sha256", "k").update("order_demo_d|pay_demo_d").digest("hex"),
  });
  delete process.env.MM_RAZORPAY_KEY_SECRET;

  if (settle) {
    await settlePaymentForRequest(requestId, { userId: owner.id, role: "pharmacy_owner" });
  }
  return { requestId, paymentId: payment.id, customerId: customer.id, ownerId: owner.id };
}

async function adminActor() {
  // The seed does not guarantee user id 1 is the admin, so resolve it the same
  // way every other test does.
  const admin = (await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
  ))!;
  return { userId: admin.id, role: "admin" as const };
}

describe("raising a dispute", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("lets the ordering customer raise one, and nobody else", async () => {
    const { requestId, customerId } = await paidOrder({ settle: true });

    const ok = await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "damaged",
      reason: "Box arrived crushed",
    });
    expect(ok.status).toBe(DISPUTE_STATUS.OPEN);

    const stranger = (await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='customer' AND id <> $1 LIMIT 1",
      [customerId]
    ))!;
    await expect(
      raiseDispute({
        requestId,
        actor: { userId: stranger.id, role: "customer" },
        category: "other",
        reason: "not mine",
      })
    ).rejects.toBeInstanceOf(DisputeError);

    await expect(
      raiseDispute({
        requestId,
        actor: { userId: customerId, role: "admin" },
        category: "other",
        reason: "admin cannot file on a customer's behalf",
      })
    ).rejects.toThrow(/Only the customer/);
  });

  it("refuses a second open dispute on the same order", async () => {
    const { requestId, customerId } = await paidOrder({ settle: true });
    await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "wrong_item",
      reason: "wrong box",
    });
    await expect(
      raiseDispute({
        requestId,
        actor: { userId: customerId, role: "customer" },
        category: "other",
        reason: "also this",
      })
    ).rejects.toThrow(/already an open dispute/);
  });

  it("cannot dispute an order that was never paid for", async () => {
    const medicine = (await queryOne<{ id: number }>("SELECT id FROM medicines LIMIT 1"))!;
    const customer = (await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='customer' LIMIT 1"
    ))!;
    const { requestId } = await createRequest({
      medicineId: medicine.id,
      qty: 1,
      customerId: customer.id,
      customerName: "Unpaid",
      fulfilmentType: "pickup",
    });
    await expect(
      raiseDispute({
        requestId,
        actor: { userId: customer.id, role: "customer" },
        category: "other",
        reason: "nothing paid",
      })
    ).rejects.toThrow(/no payment to dispute/);
  });
});

describe("responding and resolving", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("only the fulfilling pharmacy may answer, and only while it is open", async () => {
    const { requestId, customerId } = await paidOrder({ settle: true });
    const detail = (await getRequestDetail(requestId))!;
    const pharmacyId = detail.request.preferred_pharmacy_id!;

    const dispute = await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "not_delivered",
      reason: "never arrived",
    });

    const otherPharmacy = (await queryOne<{ id: number; pharmacy_id: number | null }>(
      "SELECT id, pharmacy_id FROM users WHERE role='pharmacy_owner' AND pharmacy_id <> $1 LIMIT 1",
      [pharmacyId]
    ))!;
    await expect(
      respondToDispute({
        disputeId: dispute.id,
        actor: { userId: otherPharmacy.id, role: "pharmacy_owner", pharmacyId: otherPharmacy.pharmacy_id },
        response: "not my order",
      })
    ).rejects.toThrow(/Not your pharmacy/);

    const owner = (await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
      [pharmacyId]
    ))!;
    const answered = await respondToDispute({
      disputeId: dispute.id,
      actor: { userId: owner.id, role: "pharmacy_owner", pharmacyId },
      response: "Rider confirmed handover on the 3rd",
    });
    expect(answered.status).toBe(DISPUTE_STATUS.RESPONDED);
    expect(answered.response).toContain("Rider confirmed");

    // A second reply is refused: the dispute has moved on.
    await expect(
      respondToDispute({
        disputeId: dispute.id,
        actor: { userId: owner.id, role: "pharmacy_owner", pharmacyId },
        response: "again",
      })
    ).rejects.toThrow(/Cannot respond/);
  });

  it("performs a real refund when the payout has not gone out yet", async () => {
    const { requestId, paymentId, customerId } = await paidOrder({ settle: false });
    const dispute = await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "overcharged",
      reason: "charged twice",
    });

    const result = await resolveDispute({
      disputeId: dispute.id,
      actor: await adminActor(),
      outcome: "refund",
      note: "duplicate charge confirmed",
    });

    expect(result.offline).toBe(false);
    expect(result.refundedPaise).toBeGreaterThan(0);
    expect((await getPayment(paymentId))!.status).toBe(PAYMENT_STATUS.REFUNDED);
    expect(result.dispute.status).toBe(DISPUTE_STATUS.REFUND_APPROVED);
  });

  it("records an obligation instead of faking a refund after the payout", async () => {
    const { requestId, paymentId, customerId } = await paidOrder({ settle: true });
    const payment = (await getPayment(paymentId))!;
    expect(payment.status).toBe(PAYMENT_STATUS.PAID_OUT);

    const dispute = await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "wrong_item",
      reason: "sent the wrong strength",
    });
    const result = await resolveDispute({
      disputeId: dispute.id,
      actor: await adminActor(),
      outcome: "refund",
      note: "customer is right",
    });

    // The money already reached the pharmacy, so nothing is marked refunded.
    expect(result.offline).toBe(true);
    expect(result.refundedPaise).toBeNull();
    expect((await getPayment(paymentId))!.status).toBe(PAYMENT_STATUS.PAID_OUT);
    expect(result.dispute.recoverable_paise).toBe(payment.pharmacy_amount_paise);
    expect(result.dispute.resolution).toMatch(/recovery is handled offline/i);
  });

  it("rejects a dispute without pretending anything moved", async () => {
    const { requestId, customerId } = await paidOrder({ settle: true });
    const dispute = await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "other",
      reason: "changed my mind",
    });
    const result = await resolveDispute({
      disputeId: dispute.id,
      actor: await adminActor(),
      outcome: "reject",
      note: "handover was verified",
    });
    expect(result.dispute.status).toBe(DISPUTE_STATUS.REJECTED);
    expect(result.dispute.recoverable_paise).toBe(0);
  });

  it("cannot resolve the same dispute twice", async () => {
    const { requestId, customerId } = await paidOrder({ settle: true });
    const dispute = await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "damaged",
      reason: "box crushed",
    });
    await resolveDispute({
      disputeId: dispute.id,
      actor: await adminActor(),
      outcome: "reject",
      note: "no",
    });
    await expect(
      resolveDispute({
        disputeId: dispute.id,
        actor: await adminActor(),
        outcome: "refund",
        note: "changed my mind",
      })
    ).rejects.toThrow(/already resolved/);
  });

  it("stops showing a resolved dispute in the operator's queue", async () => {
    const { requestId, customerId } = await paidOrder({ settle: true });
    const dispute = await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "other",
      reason: "query",
    });
    expect((await listOpenDisputes()).map((d) => d.id)).toContain(dispute.id);
    await resolveDispute({
      disputeId: dispute.id,
      actor: await adminActor(),
      outcome: "reject",
      note: "answered",
    });
    expect((await listOpenDisputes()).map((d) => d.id)).not.toContain(dispute.id);
    expect((await listDisputesForRequest(requestId)).length).toBe(1);
  });

  it("keeps the patient's words and nothing else on the record", async () => {
    const { requestId, customerId } = await paidOrder({ settle: true });
    const customer = (await queryOne<{ name: string; phone: string }>(
      "SELECT name, phone FROM users WHERE id = $1",
      [customerId]
    ))!;
    await raiseDispute({
      requestId,
      actor: { userId: customerId, role: "customer" },
      category: "other",
      reason: "call me",
    });
    const rows = await queryAll<{ reason: string }>("SELECT reason FROM disputes");
    expect(rows).toHaveLength(1);
    // The reason is the customer's own words; nothing is auto-appended to it.
    expect(rows[0].reason).toBe("call me");
    expect(JSON.stringify(rows[0])).not.toContain(customer.phone);
    expect(JSON.stringify(rows[0])).not.toContain(customer.name);
  });
});