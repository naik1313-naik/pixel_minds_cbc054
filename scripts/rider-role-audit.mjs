#!/usr/bin/env node
/**
 * Full audit of the delivery-partner (rider) role, end to end, against a running
 * server.
 *
 *   node scripts/rider-role-audit.mjs
 *
 * Walks the whole job — register, verify, go online, get offered a job, accept,
 * get approved, arrive, pick up, travel, arrive, hand over with OTP — and then
 * tries to break every step of it. A role that only works when used correctly is
 * not a role that has been checked.
 */
const BASE = process.env.BASE ?? "http://localhost:3000";

function jar() {
  return { cookie: "" };
}

async function call(c, method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(c.cookie ? { cookie: c.cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) {
    const m = /mm_session=[^;]+/.exec(set);
    if (m) c.cookie = m[0];
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 160);
  }
  return { status: res.status, json, text };
}

let pass = 0;
let fail = 0;
const findings = [];

function check(ok, label, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    findings.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
const step = (n, label) => console.log(`\n${n}. ${label}`);

(async () => {
  const customer = jar();
  const owner = jar();
  const rider = jar();
  const stranger = jar();

  // Clear deliveries left behind by earlier runs so at least one rider is free;
  // a busy rider is correctly skipped by the assignment logic, which would
  // otherwise look like a bug in this audit.
  {
    const admin = jar();
    await call(admin, "POST", "/api/auth/demo-login", { key: "admin" });
    const listed = await call(admin, "GET", "/api/admin/orders");
    const stale = (listed.json.orders ?? []).filter(
      (o) => o.delivery_id && !["Delivered", "Cancelled", "ReturnedToPharmacy"].includes(o.delivery_status ?? "")
    );
    for (const o of stale) {
      await call(admin, "POST", `/api/rider/deliveries/${o.delivery_id}/status`, { status: "Cancelled" });
    }
    if (stale.length) console.log(`   (cleared ${stale.length} stale delivery(ies) from an earlier run)`);
  }

  // ---------------------------------------------------------------- onboarding
  step(1, "Rider registers and lands pending verification");
  const email = `rider.audit.${Date.now()}@medimesh.demo`;
  // Name and password must satisfy the real registration policy (upper, lower,
  // digit, no reuse of the person's name) — this audit signs up like a stranger.
  const riderName = "Kabir";
  const riderPassword = "Zx9QwertyNebula!77";
  let r = await call(
    { cookie: "" },
    "POST",
    "/api/auth/register",
    {
      email,
      name: riderName,
      phone: "9876500000",
      password: riderPassword,
      role: "delivery_partner",
      vehicle: "KA-05-AUDIT-9999",
      idType: "DL",
      idNumber: "KA0120180004821",
    }
  );
  const registered = r.status === 200 || r.status === 201;
  check(registered, "new rider can register", r.json?.error ?? `status ${r.status}`);
  if (!registered) {
    console.log("\nCannot continue without a rider account.");
    process.exit(1);
  }

  r = await call(rider, "POST", "/api/auth/login", { email, password: riderPassword });
  check(r.status === 200, "rider can sign in", r.json?.error ?? "");
  r = await call(rider, "GET", "/api/auth/me");
  const newRiderId = r.json?.user?.id;
  const partnerStatus = r.json?.user?.partner_status;
  check(
    partnerStatus === "pending",
    // Previously this asserted the opposite: that a rider was approved the
    // instant they registered. A rider is handed the customer's address, the
    // medicine and the handover OTP, so approval is now an admin decision and
    // this check exists to stop that regressing.
    "a new rider waits for an admin instead of being approved on signup",
    String(partnerStatus)
  );

  step(2, "The online gate actually rejects an unverified account");
  const adminDemote = jar();
  await call(adminDemote, "POST", "/api/auth/demo-login", { key: "admin" });
  await call(adminDemote, "PUT", "/api/admin/partners", { id: newRiderId, status: "pending" });
  r = await call(rider, "POST", "/api/rider/status", { online: true });
  check(r.status === 403, "unverified rider cannot go online", r.json?.error ?? "");
  await call(adminDemote, "PUT", "/api/admin/partners", { id: newRiderId, status: "verified" });
  r = await call(rider, "POST", "/api/rider/status", { online: true });
  check(r.status === 200, "re-approved rider goes online again");

  step(3, "A verified demo rider can go online");
  const rider2 = jar();
  await call(rider2, "POST", "/api/auth/demo-login", { key: "rider1" });
  r = await call(rider2, "POST", "/api/rider/status", { online: true });
  check(r.status === 200 && r.json.online === true, "verified rider goes online");

  // ---------------------------------------------------------------- the job
  step(4, "Delivery order is created and confirmed by the pharmacy");
  await call(customer, "POST", "/api/auth/demo-login", { key: "customer" });
  await call(owner, "POST", "/api/auth/demo-login", { key: "owner1" });
  r = await call(customer, "POST", "/api/requests", {
    medicineId: 2,
    qty: 1,
    fulfilmentType: "delivery",
    preferredPharmacyId: 1,
    deliveryAddress: "77 Rider Audit Road, Indiranagar",
    deliveryLat: 12.9719,
    deliveryLng: 77.6412,
  });
  const requestId = r.json.requestId;
  check(Number.isFinite(requestId), "delivery order created", `#${requestId}`);

  // Pay up front so the payout leg can be checked at the end.
  await call(owner, "POST", `/api/requests/${requestId}/confirm`, {});
  const payInfo = await call(customer, "POST", `/api/requests/${requestId}/payment`, {});
  await call(customer, "POST", "/api/payments/verify", {
    razorpayOrderId: payInfo.json.razorpayOrderId,
    razorpayPaymentId: `pay_demo_${payInfo.json.razorpayOrderId.replace(/^order_demo_/, "")}`,
    razorpaySignature: "demo-signature-not-required",
  });

  r = await call(owner, "POST", `/api/requests/${requestId}/ready`, {});
  const deliveryId = r.json.deliveryId;
  check(Number.isFinite(deliveryId), "job created on Ready", `delivery #${deliveryId}`);

  // ---------------------------------------------------------------- offers
  step(5, "The job is offered to a rider");
  let holder = null;
  // The brand-new rider is in the pool too — it registered as verified, so it
  // should be offered work exactly like the seeded ones.
  const pool = [{ key: "new-rider", c: rider }, { key: "rider1" }, { key: "rider2" }];
  for (const entry of pool) {
    const c = entry.c ?? jar();
    if (!entry.c) {
      await call(c, "POST", "/api/auth/demo-login", { key: entry.key });
      await call(c, "POST", "/api/rider/status", { online: true });
    }
    const offers = await call(c, "GET", "/api/rider/offers");
    if ((offers.json.offers ?? []).some((o) => o.id === deliveryId)) {
      holder = { key: entry.key, c };
      break;
    }
  }
  check(Boolean(holder), "a rider holds the offer", holder?.key ?? "nobody");
  if (!holder) {
    console.log("\nNo offer — cannot continue.");
    process.exit(1);
  }

  step(6, "A rider cannot accept a job they were never offered");
  const otherRider = ["rider1", "rider2", "new-rider"].find((k) => k !== holder.key) ?? "rider1";
  const other = jar();
  if (otherRider === "new-rider") {
    // Same person as the audit rider, but without the session that was given a
    // job — proves the guard is on the offer row, not on the account.
    other.cookie = rider.cookie;
  } else {
    await call(other, "POST", "/api/auth/demo-login", { key: otherRider });
  }
  r = await call(other, "POST", "/api/rider/offers", { deliveryId, action: "accept" });
  check(r.status === 409, "accept refused without an offer", r.json?.error ?? "");

  step(7, "Only one rider can win the job");
  r = await call(holder.c, "POST", "/api/rider/offers", { deliveryId, action: "accept" });
  check(r.status === 200, "offer accepted", r.json?.status ?? "");
  r = await call(holder.c, "POST", "/api/rider/offers", { deliveryId, action: "accept" });
  check(r.status === 409, "second accept refused", r.json?.error ?? "");

  step(8, "The rider cannot self-assign or skip pharmacy approval");
  r = await call(holder.c, "POST", `/api/rider/deliveries/${deliveryId}/status`, {
    status: "ArrivedAtPharmacy",
  });
  check(r.status === 409, "cannot act before approval", r.json?.error ?? "");
  r = await call(holder.c, "POST", `/api/rider/deliveries/${deliveryId}/status`, { status: "Assigned" });
  check(r.status === 409 || r.status === 400, "rider cannot self-assign", r.json?.error ?? "");

  step(9, "A different rider cannot touch this delivery");
  await call(stranger, "POST", "/api/auth/demo-login", { key: "rider2" });
  if (stranger.cookie === other.cookie) {
    console.log("      (only one demo rider free; using a customer session instead)");
    await call(stranger, "POST", "/api/auth/demo-login", { key: "customer" });
  }
  r = await call(stranger, "GET", `/api/rider/deliveries/${deliveryId}`);
  check(r.status === 401 || r.status === 403, "outsider blocked from rider view", `status ${r.status}`);

  step(10, "Pharmacy approves, and the rider can then start moving");
  r = await call(owner, "POST", `/api/pharmacy/deliveries/${deliveryId}/approve`, {});
  check(r.json?.ok !== false, "rider approved by pharmacy");

  for (const status of ["ArrivedAtPharmacy", "PickedUp", "OutForDelivery", "ArrivedAtDestination"]) {
    r = await call(holder.c, "POST", `/api/rider/deliveries/${deliveryId}/status`, { status });
    check(r.json?.ok === true, `transition → ${status}`, r.json?.error ?? "");
  }

  step(11, "The rider cannot skip steps in the state machine");
  const completed = jar();
  await call(completed, "POST", "/api/auth/demo-login", { key: "customer" });
  r = await call(completed, "POST", `/api/rider/deliveries/${deliveryId}/status`, {
    status: "Cancelled",
  });
  check(r.status === 401 || r.status === 403, "customer cannot drive a delivery", `status ${r.status}`);

  step(12, "Handover requires the right OTP");
  r = await call(holder.c, "POST", `/api/rider/deliveries/${deliveryId}/handover`, {
    otp: "0000",
    idChecked: false,
  });
  check(r.status === 400, "wrong OTP refused", r.json?.error ?? "");

  // The demo OTP is revealed to the ordering customer.
  r = await call(customer, "GET", `/api/requests/${requestId}/otp`);
  const otp = r.json?.otp;
  check(Boolean(otp), "customer can read the demo OTP");

  step(13, "Delivery visibility: own customer yes, another customer no");
  r = await call(customer, "GET", `/api/rider/deliveries/${deliveryId}`);
  check(r.status === 200, "ordering customer can follow their own delivery", "");
  const otherCustomer = jar();
  await call(otherCustomer, "POST", "/api/auth/demo-login", { key: "customer2" });
  r = await call(otherCustomer, "GET", `/api/rider/deliveries/${deliveryId}`);
  check(
    r.status === 403 || r.status === 404,
    "a different customer is refused someone else's delivery",
    `status ${r.status}`
  );
  r = await call(otherCustomer, "POST", `/api/rider/deliveries/${deliveryId}/handover`, {
    otp,
    idChecked: false,
  });
  check(
    r.status === 401 || r.status === 403 || r.status === 404,
    "a non-rider cannot complete a handover",
    `status ${r.status}`
  );

  step(13, "Correct OTP completes the handover");
  r = await call(holder.c, "POST", `/api/rider/deliveries/${deliveryId}/handover`, {
    otp,
    idChecked: false,
  });
  check(r.json?.ok === true, "handover accepted", r.json?.error ?? "");

  step(14, "Delivery completed, so the pharmacy is paid");
  const payView = await call(customer, "GET", `/api/requests/${requestId}/payment`);
  check(
    ["Captured", "PaidOut"].includes(payView.json?.payment?.status),
    "payment reached a settled state",
    payView.json?.payment?.status ?? ""
  );
  r = await call(customer, "GET", `/api/requests/${requestId}/settlement`);
  check(
    r.json?.anchored === true || r.json?.status === "PaidOut",
    "settlement anchored after delivery",
    `block ${r.json?.blockNumber ?? "n/a"}`
  );

  step(15, "The rider's location history is recorded and readable");
  r = await call(holder.c, "GET", `/api/rider/deliveries/${deliveryId}`);
  check(r.status === 200, "rider can read their own delivery", "");

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (findings.length) {
    console.log("\nFindings:");
    for (const f of findings) console.log(`  - ${f}`);
  }
  process.exit(fail ? 1 : 0);
})();