#!/usr/bin/env node
/**
 * Live demo-flow check against a running dev server.
 *
 * Walks the whole path a judge will watch: one-tap sign-in as the customer,
 * order, one-tap sign-in as the pharmacy owner, confirm, pay, fulfil, and read
 * the payout + on-chain settlement back. Uses only the demo rail, so no money
 * and no merchant account are involved.
 */
const BASE = process.env.BASE ?? "http://localhost:3000";

const jar = () => ({ cookie: "", csrf: "" });

async function call(cookies, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookies.cookie ? { cookie: cookies.cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) {
    const m = /mm_session=[^;]+/.exec(set);
    if (m) cookies.cookie = m[0];
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON responses (the QR route returns SVG) are kept verbatim so the
    // caller can assert on the markup.
    json = text;
  }
  return { status: res.status, json, text };
}

function step(n, label) {
  console.log(`\n${n}. ${label}`);
}

const results = [];
function check(ok, label, detail = "") {
  results.push({ ok, label });
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

(async () => {
  const customer = jar();
  const owner = jar();

  step(1, "Customer signs in with one tap");
  let r = await call(customer, "POST", "/api/auth/demo-login", { key: "customer" });
  check(r.status === 200 && r.json.role === "customer", "customer one-tap login", `role=${r.json.role}`);

  step(2, "Customer places an order at pharmacy 1");
  r = await call(customer, "POST", "/api/requests", {
    medicineId: 1,
    qty: 2,
    fulfilmentType: "pickup",
    preferredPharmacyId: 1,
  });
  const requestId = r.json.requestId;
  check(r.status === 201 && Number.isFinite(requestId), "order created", `#${requestId}`);

  step(3, "Owner signs in with one tap");
  r = await call(owner, "POST", "/api/auth/demo-login", { key: "owner1" });
  check(r.status === 200 && r.json.role === "pharmacy_owner", "owner one-tap login", r.json.name);

  step(4, "Owner links the payout account");
  r = await call(owner, "POST", "/api/pharmacy/payout-account", {});
  check(r.status === 200 && r.json.payoutAccountStatus === "activated", "payout account activated", r.json.razorpayAccountId);

  step(5, "Owner confirms the order (total is frozen here)");
  r = await call(owner, "POST", `/api/requests/${requestId}/confirm`, {});
  check(r.status === 200 && r.json.ok === true, "order confirmed");

  step(6, "Owner opens checkout");
  r = await call(customer, "POST", `/api/requests/${requestId}/payment`, {});
  const orderId = r.json.razorpayOrderId;
  check(r.status === 200 && Boolean(orderId), "gateway order created", `${orderId} for ${r.json.amountPaise}p`);

  step(7, "Customer pays");
  r = await call(customer, "POST", "/api/payments/verify", {
    razorpayOrderId: orderId,
    razorpayPaymentId: `pay_demo_${orderId.replace(/^order_demo_/, "")}`,
    razorpaySignature: "demo-signature-not-required",
  });
  check(r.status === 200 && r.json.payment?.status === "Captured", "payment captured", r.json.payment?.status);

  step(8, "Owner marks it collected (fulfilment complete)");
  r = await call(owner, "POST", `/api/requests/${requestId}/complete`, {});
  check(r.status === 200 && r.json.ok === true, "order completed");

  step(9, "Owner reads the payout");
  r = await call(owner, "GET", "/api/pharmacy/payments");
  const paid = r.json.payments?.[0];
  check(
    r.status === 200 && r.json.totals?.paidOutPaise > 0,
    "payout credited to pharmacy",
    `${r.json.totals?.paidOutLabel} of ${paid?.amountLabel} (fee ${paid?.platformFeeLabel})`
  );

  step(10, "On-chain settlement receipt");
  r = await call(customer, "GET", `/api/requests/${requestId}/settlement`);
  check(
    r.status === 200 && r.json.anchored === true && r.json.metadataMatches === true,
    "settlement anchored and metadata matches",
    r.json.anchored
      ? `block ${r.json.blockNumber}, ${r.json.amountPaise}p reported to the pharmacy wallet`
      : r.json.status
  );

  step(11, "Receipt QR encodes the public verification URL");
  r = await call(customer, "GET", `/api/requests/${requestId}/payment/qr`);
  const svg = typeof r.json === "string" ? r.json : String(r.text ?? "");
  check(r.status === 200 && svg.includes("<svg"), "QR renders as SVG", `${svg.length} bytes`);

  step(12, "Pharmacy refunds a captured payment");
  // A second, unpaid-but-captured order so the refund has something to act on.
  r = await call(customer, "POST", "/api/requests", {
    medicineId: 1,
    qty: 1,
    fulfilmentType: "pickup",
    preferredPharmacyId: 1,
  });
  const refundId = r.json.requestId;
  await call(owner, "POST", `/api/requests/${refundId}/confirm`, {});
  r = await call(customer, "POST", `/api/requests/${refundId}/payment`, {});
  const refundOrderId = r.json.razorpayOrderId;
  r = await call(customer, "POST", "/api/payments/verify", {
    razorpayOrderId: refundOrderId,
    razorpayPaymentId: `pay_demo_${refundOrderId.replace(/^order_demo_/, "")}`,
    razorpaySignature: "demo-signature-not-required",
  });
  check(r.status === 200, "second order captured");

  r = await call(owner, "POST", `/api/requests/${refundId}/refund`, { reason: "Damaged box" });
  check(
    r.status === 200 && r.json.payment?.status === "Refunded",
    "refund accepted",
    r.json.payment?.amountLabel ?? r.json.error ?? ""
  );

  step(13, "Refunding an already paid-out order is refused, not faked");
  r = await call(owner, "POST", `/api/requests/${requestId}/refund`, { reason: "too late" });
  check(r.status === 409, "refund refused after payout", r.json.error ?? "");

  step(14, "Admin sees outbox health");
  const admin = jar();
  await call(admin, "POST", "/api/auth/demo-login", { key: "admin" });
  r = await call(admin, "GET", "/api/admin/reconciliation");
  check(
    r.status === 200 && typeof r.json.counts?.needs_reconciliation === "number",
    "outbox report available",
    `${r.json.counts?.confirmed ?? 0} confirmed, ${r.json.counts?.needs_reconciliation ?? 0} unresolved`
  );

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();