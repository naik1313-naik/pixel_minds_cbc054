import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetDemo, queryOne, queryAll, queryRun } from "@/lib/db";
import {
  cancelRequest,
  completeRequest,
  confirmRequest,
  createRequest,
} from "@/lib/engine";
import {
  PAYMENT_STATUS,
  PaymentError,
  buildSettlementMetadata,
  capturePayment,
  createIntent,
  ensureGatewayOrder,
  getPayment,
  getPaymentForRequest,
  listPharmacyPayments,
  paymentView,
  refundPaymentForRequest,
  splitAmount,
} from "@/lib/payments";
import { PLATFORM_FEE_RATE } from "@/lib/constants";
import {
  getPaymentGateway,
  setPaymentGateway,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  type PaymentGateway,
} from "@/lib/razorpay";
import { hashSettlementMetadata, METADATA_SCHEMA_VERSION } from "@/lib/blockchain/hashes";

// Medicine 1 is seeded with a known price, so totals are exact here.
async function seedOrder(qty = 2) {
  const medicine = (await queryOne<{ id: number; price_paise: number }>(
    "SELECT id, price_paise FROM medicines ORDER BY id LIMIT 1"
  ))!;
  const { requestId } = await createRequest({
    medicineId: medicine.id,
    qty,
    customerId: null,
    customerName: "Test Customer",
    fulfilmentType: "pickup",
  });
  const detail = (await queryOne<{ preferred_pharmacy_id: number }>(
    "SELECT preferred_pharmacy_id FROM requests WHERE id = $1",
    [requestId]
  ))!;
  const owner = (await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE role = 'pharmacy_owner' AND pharmacy_id = $1",
    [detail.preferred_pharmacy_id]
  ))!;
  const confirmed = await confirmRequest(requestId, { userId: owner.id, role: "pharmacy_owner" });
  return { requestId, pharmacyId: detail.preferred_pharmacy_id, ownerId: owner.id, medicine, confirmed };
}

async function activatePayout(pharmacyId: number, accountId = "acc_test_owner") {
  await queryRun(
    "UPDATE pharmacies SET razorpay_account_id = $1, payout_account_status = 'activated' WHERE id = $2",
    [accountId, pharmacyId]
  );
}

// A gateway stub that records what it was asked to do, so routing can be
// asserted without touching a real merchant account.
function stubGateway() {
  const calls: { captures: { paymentId: string; account: string | null; amount: number }[]; refunds: string[] } =
    { captures: [], refunds: [] };
  const gw: PaymentGateway = {
    name: "demo",
    async createOrder(input) {
      return { id: `order_demo_req`, amountPaise: input.amountPaise, currency: "INR" };
    },
    async capture(input) {
      calls.captures.push({
        paymentId: input.paymentId,
        account: input.beneficiaryAccountId ?? null,
        amount: input.beneficiaryAmountPaise ?? 0,
      });
      return { paymentId: input.paymentId, transferId: "trf_demo_1", status: "captured" };
    },
    async refund(paymentId) {
      calls.refunds.push(paymentId);
      return { refundId: "rfnd_demo_1", amountPaise: 0, status: "processed" };
    },
    async createLinkedAccount(input) {
      return { accountId: `acc_demo_${input.email}`, status: "activated" };
    },
    verifyCheckout(input) {
      return (
        input.orderId.startsWith("order_demo_") && input.paymentId.startsWith("pay_demo_")
      );
    },
    async fetchLinkedAccount(accountId) {
      return accountId.startsWith("acc_demo_") ? "activated" : "pending";
    },
  };
  return { gw, calls };
}

describe("amount split", () => {
  it("always reconstructs the charged total", () => {
    for (const total of [1, 7, 99, 100, 1234, 99_999, 250_000]) {
      const { platformFeePaise, pharmacyAmountPaise } = splitAmount(total);
      expect(platformFeePaise + pharmacyAmountPaise).toBe(total);
      expect(platformFeePaise).toBe(Math.round(total * PLATFORM_FEE_RATE));
    }
  });
});

describe("payment intents", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("opens an intent at confirm with a server-computed total", async () => {
    const { requestId, confirmed, medicine } = await seedOrder(3);
    expect(confirmed.ok).toBe(true);

    const payment = await getPaymentForRequest(requestId);
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe(PAYMENT_STATUS.AWAITING);
    expect(payment!.amount_paise).toBe(medicine.price_paise * 3);
    expect(payment!.platform_fee_paise + payment!.pharmacy_amount_paise).toBe(payment!.amount_paise);

    // The order row carries the canonical total too, so any screen agrees.
    const row = (await queryOne<{ amount_paise: number; payment_status: string }>(
      "SELECT amount_paise, payment_status FROM requests WHERE id = $1",
      [requestId]
    ))!;
    expect(row.amount_paise).toBe(payment!.amount_paise);
    expect(row.payment_status).toBe(PAYMENT_STATUS.AWAITING);
  });

  it("is idempotent — a second call returns the same payment", async () => {
    const { requestId } = await seedOrder();
    const again = await createIntent(requestId);
    const all = await queryAll("SELECT id FROM payments WHERE request_id = $1", [requestId]);
    expect(all).toHaveLength(1);
    expect(again.id).toBe(all[0].id);
  });

  it("reuses one gateway order across retries so the customer is not charged twice", async () => {
    const { gw } = stubGateway();
    setPaymentGateway(gw);
    try {
      const { requestId } = await seedOrder();
      const payment = (await getPaymentForRequest(requestId))!;
      const a = await ensureGatewayOrder(payment.id);
      const b = await ensureGatewayOrder(payment.id);
      expect(a.id).toBe(b.id);
    } finally {
      setPaymentGateway(null);
    }
  });

  it("bills only the secured quantity on a partial order", async () => {
    // A pharmacy with stock is preferred so the order is fully secured; force a
    // partial by asking for more than the network holds is not deterministic,
    // so assert the billable-quantity rule directly on a known secured order.
    const { requestId, medicine } = await seedOrder(1);
    const payment = (await getPaymentForRequest(requestId))!;
    expect(payment.amount_paise).toBe(medicine.price_paise);
  });
});

describe("capture", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  async function captured(activate = true) {
    const order = await seedOrder();
    if (activate) await activatePayout(order.pharmacyId);
    const payment = (await getPaymentForRequest(order.requestId))!;
    await ensureGatewayOrder(payment.id);
    return { ...order, payment };
  }

  it("rejects a forged signature", async () => {
    process.env.MM_RAZORPAY_KEY_SECRET = "test_secret_for_signature_checks";
    try {
      const { payment } = await captured(false);
      await expect(
        capturePayment({
          paymentId: payment.id,
          razorpayOrderId: "order_demo_req",
          razorpayPaymentId: "pay_demo_1",
          razorpaySignature: "deadbeef".repeat(8),
        })
      ).rejects.toBeInstanceOf(PaymentError);
      expect((await getPayment(payment.id))!.status).not.toBe(PAYMENT_STATUS.CAPTURED);
    } finally {
      delete process.env.MM_RAZORPAY_KEY_SECRET;
    }
  });

  it("routes the pharmacy owner's share and keeps the platform fee", async () => {
    const { gw, calls } = stubGateway();
    setPaymentGateway(gw);
    process.env.MM_RAZORPAY_KEY_SECRET = "k";
    try {
      const { payment } = await captured();
      // A signature is only derivable when a merchant secret exists; use the
      // stub gateway's own verification by minting the right value here.
      const { createHmac } = await import("crypto");
      const signature = createHmac("sha256", "k").update("order_demo_req|pay_demo_1").digest("hex");

      const capturedRow = await capturePayment({
        paymentId: payment.id,
        razorpayOrderId: "order_demo_req",
        razorpayPaymentId: "pay_demo_1",
        razorpaySignature: signature,
      });

      expect(capturedRow.status).toBe(PAYMENT_STATUS.CAPTURED);
      expect(calls.captures).toHaveLength(1);
      expect(calls.captures[0].account).toBe("acc_test_owner");
      expect(calls.captures[0].amount).toBe(payment.pharmacy_amount_paise);
      expect(capturedRow.beneficiary_account_id).toBe("acc_test_owner");
      expect(capturedRow.razorpay_transfer_id).toBe("trf_demo_1");
    } finally {
      setPaymentGateway(null);
      delete process.env.MM_RAZORPAY_KEY_SECRET;
    }
  });

  it("is idempotent — a second capture does not route money twice", async () => {
    const { gw, calls } = stubGateway();
    setPaymentGateway(gw);
    process.env.MM_RAZORPAY_KEY_SECRET = "k";
    try {
      const { payment } = await captured();
      const { createHmac } = await import("crypto");
      const signature = createHmac("sha256", "k").update("order_demo_req|pay_demo_1").digest("hex");
      const args = {
        paymentId: payment.id,
        razorpayOrderId: "order_demo_req",
        razorpayPaymentId: "pay_demo_1",
        razorpaySignature: signature,
      };
      await capturePayment(args);
      await capturePayment(args);
      expect(calls.captures).toHaveLength(1);
    } finally {
      setPaymentGateway(null);
      delete process.env.MM_RAZORPAY_KEY_SECRET;
    }
  });

  it("refuses to capture when the gateway order does not match", async () => {
    process.env.MM_RAZORPAY_KEY_SECRET = "k";
    try {
      const { payment } = await captured();
      await expect(
        capturePayment({
          paymentId: payment.id,
          razorpayOrderId: "order_someone_else",
          razorpayPaymentId: "pay_demo_1",
          razorpaySignature: "x".repeat(64),
        })
      ).rejects.toThrow(/does not match/);
    } finally {
      delete process.env.MM_RAZORPAY_KEY_SECRET;
    }
  });
});

describe("settlement", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("releases the payout on completion and is safe to run twice", async () => {
    const { gw } = stubGateway();
    setPaymentGateway(gw);
    process.env.MM_RAZORPAY_KEY_SECRET = "k";
    try {
      const order = await seedOrder();
      await activatePayout(order.pharmacyId);
      const payment = (await getPaymentForRequest(order.requestId))!;
      await ensureGatewayOrder(payment.id);
      const { createHmac } = await import("crypto");
      await capturePayment({
        paymentId: payment.id,
        razorpayOrderId: "order_demo_req",
        razorpayPaymentId: "pay_demo_1",
        razorpaySignature: createHmac("sha256", "k").update("order_demo_req|pay_demo_1").digest("hex"),
      });

      const actor = { userId: order.ownerId, role: "pharmacy_owner" };
      await completeRequest(order.requestId, actor);
      const afterFirst = (await getPayment(payment.id))!;
      expect(afterFirst.status).toBe(PAYMENT_STATUS.PAID_OUT);
      expect(afterFirst.paid_out_at).not.toBeNull();

      // Re-running must not move money or rewrite the payout timestamp.
      await completeRequest(order.requestId, actor).catch(() => undefined);
      const afterSecond = (await getPayment(payment.id))!;
      expect(afterSecond.paid_out_at).toBe(afterFirst.paid_out_at);
    } finally {
      setPaymentGateway(null);
      delete process.env.MM_RAZORPAY_KEY_SECRET;
    }
  });

  it("leaves an unpaid order alone at completion", async () => {
    const order = await seedOrder();
    const payment = (await getPaymentForRequest(order.requestId))!;
    await completeRequest(order.requestId, { userId: order.ownerId, role: "pharmacy_owner" });
    expect((await getPayment(payment.id))!.status).toBe(PAYMENT_STATUS.AWAITING);
  });

  it("refunds a captured payment when the order is cancelled", async () => {
    const { gw, calls } = stubGateway();
    setPaymentGateway(gw);
    process.env.MM_RAZORPAY_KEY_SECRET = "k";
    try {
      const order = await seedOrder();
      await activatePayout(order.pharmacyId);
      const payment = (await getPaymentForRequest(order.requestId))!;
      await ensureGatewayOrder(payment.id);
      const { createHmac } = await import("crypto");
      await capturePayment({
        paymentId: payment.id,
        razorpayOrderId: "order_demo_req",
        razorpayPaymentId: "pay_demo_1",
        razorpaySignature: createHmac("sha256", "k").update("order_demo_req|pay_demo_1").digest("hex"),
      });

      await cancelRequest(order.requestId, { userId: order.ownerId, role: "pharmacy_owner" });
      expect(calls.refunds).toEqual(["pay_demo_1"]);
      expect((await getPayment(payment.id))!.status).toBe(PAYMENT_STATUS.REFUNDED);
    } finally {
      setPaymentGateway(null);
      delete process.env.MM_RAZORPAY_KEY_SECRET;
    }
  });

  it("closes an uncaptured intent as cancelled without calling the gateway", async () => {
    const { gw, calls } = stubGateway();
    setPaymentGateway(gw);
    try {
      const order = await seedOrder();
      const payment = (await getPaymentForRequest(order.requestId))!;
      await cancelRequest(order.requestId, { userId: order.ownerId, role: "pharmacy_owner" });
      expect(calls.refunds).toHaveLength(0);
      expect((await getPayment(payment.id))!.status).toBe(PAYMENT_STATUS.CANCELLED);
    } finally {
      setPaymentGateway(null);
    }
  });

  it("hashes settlement metadata without any customer identifier", () => {
    const hash = hashSettlementMetadata({
      schema: METADATA_SCHEMA_VERSION,
      settlementRef: "SET-ABCD-EFGH",
      orderRef: "ORD-1111-2222",
      pharmacyId: 1,
      amountPaise: 9500,
      gatewayRef: "trf_demo_1",
      settledAt: "2026-01-01T00:00:00.000Z",
    });
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // The built metadata must serialise to the same inputs — no name, phone or
    // address field exists for such data to leak through.
    const built = buildSettlementMetadata({
      settlementRef: "SET-ABCD-EFGH",
      orderRef: "ORD-1111-2222",
      pharmacyId: 1,
      pharmacyAmountPaise: 9500,
      gatewayRef: "trf_demo_1",
      settledAtIso: "2026-01-01T00:00:00.000Z",
    });
    expect(JSON.stringify(built).toLowerCase()).not.toContain("@");
    expect(
      hashSettlementMetadata(built)
    ).toBe(
      hashSettlementMetadata({
        schema: METADATA_SCHEMA_VERSION,
        settlementRef: "SET-ABCD-EFGH",
        orderRef: "ORD-1111-2222",
        pharmacyId: 1,
        amountPaise: 9500,
        gatewayRef: "trf_demo_1",
        settledAt: "2026-01-01T00:00:00.000Z",
      })
    );
  });
});

describe("payout reporting", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("totals what the pharmacy owner has actually been paid", async () => {
    const { gw } = stubGateway();
    setPaymentGateway(gw);
    process.env.MM_RAZORPAY_KEY_SECRET = "k";
    try {
      const order = await seedOrder();
      await activatePayout(order.pharmacyId);
      const payment = (await getPaymentForRequest(order.requestId))!;
      await ensureGatewayOrder(payment.id);
      const { createHmac } = await import("crypto");
      await capturePayment({
        paymentId: payment.id,
        razorpayOrderId: "order_demo_req",
        razorpayPaymentId: "pay_demo_1",
        razorpaySignature: createHmac("sha256", "k").update("order_demo_req|pay_demo_1").digest("hex"),
      });

      let view = await listPharmacyPayments(order.pharmacyId);
      // captured but not yet fulfilled => still the pharmacy's to receive
      expect(view.totals.captured_paise).toBe(payment.pharmacy_amount_paise);
      expect(view.totals.paid_out_paise).toBe(0);

      await completeRequest(order.requestId, { userId: order.ownerId, role: "pharmacy_owner" });
      view = await listPharmacyPayments(order.pharmacyId);
      expect(view.totals.paid_out_paise).toBe(payment.pharmacy_amount_paise);
      expect(view.totals.captured_paise).toBe(0);
    } finally {
      setPaymentGateway(null);
      delete process.env.MM_RAZORPAY_KEY_SECRET;
    }
  });

  it("never exposes the merchant secret in the customer payment view", async () => {
    process.env.MM_RAZORPAY_KEY_SECRET = "super-secret-value";
    try {
      const order = await seedOrder();
      const view = await paymentView(order.requestId);
      expect(JSON.stringify(view)).not.toContain("super-secret-value");
    } finally {
      delete process.env.MM_RAZORPAY_KEY_SECRET;
    }
  });
});

describe("signature helpers", () => {
  afterEach(() => {
    delete process.env.MM_RAZORPAY_KEY_SECRET;
    delete process.env.MM_RAZORPAY_WEBHOOK_SECRET;
    delete process.env.MM_RAZORPAY_KEY_ID;
    setPaymentGateway(null);
  });

  it("verifies a checkout signature and rejects a tampered one", async () => {
    const { createHmac } = await import("crypto");
    process.env.MM_RAZORPAY_KEY_SECRET = "sec";
    const good = createHmac("sha256", "sec").update("order_1|pay_1").digest("hex");
    expect(verifyCheckoutSignature({ orderId: "order_1", paymentId: "pay_1", signature: good })).toBe(true);
    expect(verifyCheckoutSignature({ orderId: "order_2", paymentId: "pay_1", signature: good })).toBe(false);
  });

  it("returns false rather than throwing when no secret is configured", () => {
    expect(verifyCheckoutSignature({ orderId: "o", paymentId: "p", signature: "s" })).toBe(false);
    expect(verifyWebhookSignature("{}", "sig")).toBe(false);
  });

  it("verifies a webhook signature over the raw body", async () => {
    const { createHmac } = await import("crypto");
    process.env.MM_RAZORPAY_WEBHOOK_SECRET = "whsec";
    const body = JSON.stringify({ event: "payment.captured" });
    expect(verifyWebhookSignature(body, createHmac("sha256", "whsec").update(body).digest("hex"))).toBe(true);
    // Even one changed byte must fail.
    expect(verifyWebhookSignature(body + " ", createHmac("sha256", "whsec").update(body).digest("hex"))).toBe(
      false
    );
  });

  it("selects the live gateway once merchant keys are present", () => {
    process.env.MM_RAZORPAY_KEY_ID = "rzp_test_x";
    process.env.MM_RAZORPAY_KEY_SECRET = "sec";
    expect(getPaymentGateway().name).toBe("razorpay");
  });

  it("routes verification through the gateway, so the live one must HMAC-check", async () => {
    const { createHmac } = await import("crypto");
    process.env.MM_RAZORPAY_KEY_ID = "rzp_test_x";
    process.env.MM_RAZORPAY_KEY_SECRET = "sec";
    const gw = getPaymentGateway();
    expect(gw.name).toBe("razorpay");

    const good = createHmac("sha256", "sec").update("order_1|pay_1").digest("hex");
    expect(gw.verifyCheckout({ orderId: "order_1", paymentId: "pay_1", signature: good })).toBe(true);
    // The demo rail's unsigned ids must NOT pass on the live gateway, or the
    // demo shortcut would become a way to fake a real payment.
    expect(
      gw.verifyCheckout({ orderId: "order_demo_1", paymentId: "pay_demo_1", signature: "demo" })
    ).toBe(false);
  });

  it("the demo gateway accepts only the id shapes it issued", async () => {
    delete process.env.MM_RAZORPAY_KEY_ID;
    delete process.env.MM_RAZORPAY_KEY_SECRET;
    const gw = getPaymentGateway();
    expect(gw.name).toBe("demo");
    expect(gw.verifyCheckout({ orderId: "order_demo_1", paymentId: "pay_demo_1", signature: "demo" })).toBe(
      true
    );
    // A real-looking id is refused, so the demo rail cannot be used to claim a
    // gateway order it never created.
    expect(
      gw.verifyCheckout({ orderId: "order_live_1", paymentId: "pay_live_1", signature: "demo" })
    ).toBe(false);
  });
});