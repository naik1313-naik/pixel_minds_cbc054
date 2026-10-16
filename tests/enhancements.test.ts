import { describe, it, expect, beforeEach } from "vitest";
import { resetDemo, queryOne, queryAll } from "@/lib/db";
import { createRequest, getRequestDetail, confirmRequest } from "@/lib/engine";
import {
  PAYMENT_STATUS,
  capturePayment,
  createIntent,
  getPayment,
  listPharmacyPayments,
  paymentView,
  refundPaymentForRequest,
  settlePaymentForRequest,
} from "@/lib/payments";
import {
  getNotificationProvider,
  setNotificationProvider,
  type NotificationProvider,
} from "@/lib/providers";
import { rateLimit, clearRateLimitStore } from "@/lib/rate-limit";
import { createHmac } from "crypto";

/** Captures what would have been sent, instead of printing to the console. */
function recordingNotifications() {
  const sent: { to: string | null | undefined; message: string }[] = [];
  const provider: NotificationProvider = {
    name: "recording",
    async notify(input) {
      sent.push(input);
    },
  };
  return { sent, provider };
}

async function capturedOrder(qty = 2) {
  const medicine = (await queryOne<{ id: number; price_paise: number }>(
    "SELECT id, price_paise FROM medicines ORDER BY id LIMIT 1"
  ))!;
  const { requestId } = await createRequest({
    medicineId: medicine.id,
    qty,
    customerId: null,
    customerName: "Refund Fixture",
    fulfilmentType: "pickup",
  });
  const detail = (await getRequestDetail(requestId))!;
  const owner = (await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
    [detail.request.preferred_pharmacy_id]
  ))!;
  await confirmRequest(requestId, { userId: owner.id, role: "pharmacy_owner" });

  const payment = await createIntent(requestId);
  await queryRun0(`UPDATE payments SET razorpay_order_id = 'order_demo_x' WHERE id = $1`, [payment.id]);
  const signature = createHmac("sha256", "k").update("order_demo_x|pay_demo_x").digest("hex");
  process.env.MM_RAZORPAY_KEY_SECRET = "k";
  const captured = await capturePayment({
    paymentId: payment.id,
    razorpayOrderId: "order_demo_x",
    razorpayPaymentId: "pay_demo_x",
    razorpaySignature: signature,
  });
  delete process.env.MM_RAZORPAY_KEY_SECRET;
  return { requestId, payment: captured, ownerId: owner.id, pricePaise: medicine.price_paise };
}

// Local import shim so the fixture can write without pulling in more surface.
async function queryRun0(sql: string, params: unknown[]) {
  const { queryRun } = await import("@/lib/db");
  return queryRun(sql, params);
}

describe("rate limiting", () => {
  // Counters are shared through Postgres, so the store has to be cleared too —
  // clearing only the process-local fallback would leave the previous test's
  // rows in place and the first assertion here would already be over its limit.
  beforeEach(async () => {
    await clearRateLimitStore();
  });

  it("allows up to the limit, then refuses", async () => {
    for (let i = 0; i < 5; i++) expect((await rateLimit("k", 5, 60_000)).ok).toBe(true);
    expect((await rateLimit("k", 5, 60_000)).ok).toBe(false);
  });

  it("reports how long to wait", async () => {
    await rateLimit("wait", 1, 60_000);
    const blocked = await rateLimit("wait", 1, 60_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("resets once the window passes", async () => {
    expect((await rateLimit("short", 1, 1)).ok).toBe(true);
    expect((await rateLimit("short", 1, 1)).ok).toBe(false);
    // Window is 1ms; a fresh attempt after it elapses is served normally.
    const past = Date.now() + 5;
    while (Date.now() < past) {
      /* spin briefly */
    }
    expect((await rateLimit("short", 1, 1)).ok).toBe(true);
  });

  it("counts keys independently", async () => {
    expect((await rateLimit("a", 1, 60_000)).ok).toBe(true);
    // A different account or IP must not inherit the block.
    expect((await rateLimit("b", 1, 60_000)).ok).toBe(true);
  });

  it("counts down the remaining allowance", async () => {
    expect((await rateLimit("r", 3, 60_000)).remaining).toBe(2);
    expect((await rateLimit("r", 3, 60_000)).remaining).toBe(1);
    expect((await rateLimit("r", 3, 60_000)).remaining).toBe(0);
  });

  it("shares the counter across callers, not across processes' memory", async () => {
    // The point of moving to the database: the count is a row that any other
    // caller can see, not a value trapped in one process's heap.
    expect((await rateLimit("shared", 1, 60_000)).ok).toBe(true);
    const stored = await queryOne<{ count: number }>(
      "SELECT count FROM rate_limit_buckets WHERE bucket_key = 'shared'"
    );
    expect(stored?.count).toBe(1);
    // A second caller reading only the database still finds the window closed.
    expect((await rateLimit("shared", 1, 60_000)).ok).toBe(false);
  });
});

describe("refunds", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("returns a captured payment to the customer", async () => {
    const { requestId, payment } = await capturedOrder();
    expect(payment.status).toBe(PAYMENT_STATUS.CAPTURED);

    const refunded = await refundPaymentForRequest(
      requestId,
      { userId: 1, role: "admin" },
      "Damaged box on arrival"
    );
    expect(refunded!.status).toBe(PAYMENT_STATUS.REFUNDED);
    expect(refunded!.refunded_at).not.toBeNull();

    // The pharmacy's payout total must fall back, not keep counting the money.
    const detail = (await getRequestDetail(requestId))!;
    const { totals } = await listPharmacyPayments(detail.request.preferred_pharmacy_id!);
    expect(totals.paid_out_paise).toBe(0);
  });

  it("tells the customer their money is coming back", async () => {
    const { sent, provider } = recordingNotifications();
    setNotificationProvider(provider);
    try {
      // Give the fixture a customer with a phone on file.
      const medicine = (await queryOne<{ id: number }>("SELECT id FROM medicines ORDER BY id LIMIT 1"))!;
      const customer = (await queryOne<{ id: number; phone: string | null }>(
        "SELECT id, phone FROM users WHERE role='customer' ORDER BY id LIMIT 1"
      ))!;
      const { requestId } = await createRequest({
        medicineId: medicine.id,
        qty: 1,
        customerId: customer.id,
        customerName: "Notify Me",
        fulfilmentType: "pickup",
      });
      const detail = (await getRequestDetail(requestId))!;
      const owner = (await queryOne<{ id: number }>(
        "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
        [detail.request.preferred_pharmacy_id]
      ))!;
      await confirmRequest(requestId, { userId: owner.id, role: "pharmacy_owner" });
      const payment = await createIntent(requestId);
      await queryRun0(`UPDATE payments SET razorpay_order_id = 'order_demo_y' WHERE id = $1`, [payment.id]);
      process.env.MM_RAZORPAY_KEY_SECRET = "k";
      await capturePayment({
        paymentId: payment.id,
        razorpayOrderId: "order_demo_y",
        razorpayPaymentId: "pay_demo_y",
        razorpaySignature: createHmac("sha256", "k").update("order_demo_y|pay_demo_y").digest("hex"),
      });
      delete process.env.MM_RAZORPAY_KEY_SECRET;

      sent.length = 0;
      await refundPaymentForRequest(requestId, { userId: 1, role: "admin" }, "Out of stock at store");
      expect(sent.some((m) => /refunded/i.test(m.message) && m.to === customer.phone)).toBe(true);
    } finally {
      setNotificationProvider(null as unknown as NotificationProvider);
    }
  });

  it("refuses to refund once the payout has been released", async () => {
    const { requestId } = await capturedOrder();
    await settlePaymentForRequest(requestId, { userId: 1, role: "admin" });
    const payment = (await getPayment((await queryOne<{ id: number }>("SELECT id FROM payments ORDER BY id DESC LIMIT 1"))!.id))!;
    expect(payment.status).toBe(PAYMENT_STATUS.PAID_OUT);

    // A refund after the money left is money owed in the other direction, which
    // needs a person — so the domain must refuse rather than half-perform.
    await expect(
      refundPaymentForRequest(requestId, { userId: 1, role: "admin" }, "too late")
    ).rejects.toThrow(/Cannot refund an already paid-out payment/);
  });

  it("closes an uncaptured intent without calling the gateway", async () => {
    const medicine = (await queryOne<{ id: number }>("SELECT id FROM medicines ORDER BY id LIMIT 1"))!;
    const { requestId } = await createRequest({
      medicineId: medicine.id,
      qty: 1,
      customerId: null,
      customerName: "Never Paid",
      fulfilmentType: "pickup",
    });
    const detail = (await getRequestDetail(requestId))!;
    const owner = (await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
      [detail.request.preferred_pharmacy_id]
    ))!;
    await confirmRequest(requestId, { userId: owner.id, role: "pharmacy_owner" });
    const payment = await createIntent(requestId);

    const result = await refundPaymentForRequest(requestId, { userId: 1, role: "admin" }, "nothing owed");
    expect(result!.status).toBe(PAYMENT_STATUS.CANCELLED);
    expect((await getPayment(payment.id))!.razorpay_payment_id).toBeNull();
  });

  it("is idempotent — a repeat refund does not double-return", async () => {
    const { requestId } = await capturedOrder();
    const first = await refundPaymentForRequest(requestId, { userId: 1, role: "admin" }, "once");
    const second = await refundPaymentForRequest(requestId, { userId: 1, role: "admin" }, "twice");
    expect(first!.status).toBe(PAYMENT_STATUS.REFUNDED);
    expect(second!.status).toBe(PAYMENT_STATUS.REFUNDED);
    expect(second!.refunded_at).toBe(first!.refunded_at);
  });

  it("shows the refund in the customer payment view", async () => {
    const { requestId } = await capturedOrder();
    await refundPaymentForRequest(requestId, { userId: 1, role: "admin" }, "shown");
    const view = await paymentView(requestId);
    expect(view!.status).toBe(PAYMENT_STATUS.REFUNDED);
  });
});

describe("notifications", () => {
  beforeEach(async () => {
    await resetDemo();
    setNotificationProvider(null as unknown as NotificationProvider);
  });

  it("defaults to a console provider rather than throwing", async () => {
    const provider = getNotificationProvider();
    expect(provider.name).toBeTruthy();
    // A missing phone number must be a no-op, never an error.
    await expect(provider.notify({ to: null, message: "hi" })).resolves.toBeUndefined();
  });

  it("never blocks the operation it describes", async () => {
    const failing: NotificationProvider = {
      name: "failing",
      async notify() {
        throw new Error("gateway down");
      },
    };
    setNotificationProvider(failing);
    try {
      // capturePayment must still succeed when notification delivery explodes.
      const { payment } = await capturedOrder();
      expect(payment.status).toBe(PAYMENT_STATUS.CAPTURED);
    } catch (e) {
      setNotificationProvider(null as unknown as NotificationProvider);
      throw e;
    }
  });
});

describe("reconciliation report", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("reports a clean outbox with nothing pending", async () => {
    const rows = await queryAll<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM blockchain_operations WHERE status IN ('Pending','Submitted','Failed','NeedsReconciliation')`
    );
    expect(rows[0].n).toBe(0);
  });
});