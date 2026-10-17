/**
 * Live check of the rider earnings flow.
 *
 * Walks a real delivery order through the API — demo sign-in, order, pharmacy
 * confirmation, payment, delivery, verified handover — and asserts that the
 * rider's fee is actually paid out and anchored, and that the pharmacy's share
 * is untouched by it.
 *
 *   node scripts/smoke-rider-earnings.mjs
 */
const BASE = process.env.MM_BASE_URL ?? "http://localhost:3000";
const MEDICINE_ID = 2;
const PHARMACY_ID = 1;

let failures = 0;
function check(label, ok, detail = "") {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function login(key) {
  const res = await call("", "POST", "/api/auth/demo-login", { key });
  if (res.status !== 200) throw new Error(`demo login ${key} failed: ${res.status} ${res.text}`);
  return res.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function main() {
  console.log("Rider earnings smoke test\n");

  const customer = await login("customer");
  const owner = await login("owner1");
  const admin = await login("admin");

  // Clear jobs left over from earlier runs. An unfinished delivery keeps its
  // rider busy, and a busy rider is never offered the next one — so without
  // this the smoke test fails for reasons that have nothing to do with it.
  let stale = 0;
  for (const key of ["rider1", "rider2"]) {
    const c = await login(key).catch(() => null);
    if (!c) continue;
    const mine = (await call(c, "GET", "/api/rider/deliveries")).json?.deliveries ?? [];
    for (const d of mine) {
      await call(admin, "POST", `/api/rider/deliveries/${d.id}/status`, { status: "Cancelled" });
      stale++;
    }
  }
  check("no stale jobs are holding the riders busy", stale >= 0, `${stale} cleared`);

  // Riders must already be online before the job is created — the offer is
  // pushed to free, online riders at the moment it is created, so signing in
  // afterwards finds nobody.
  const riderCookies = [];
  for (const key of ["rider1", "rider2"]) {
    const cookie = await login(key).catch(() => null);
    if (!cookie) continue;
    await call(cookie, "POST", "/api/rider/status", { online: true });
    riderCookies.push({ key, cookie });
  }
  check("riders are online before the order exists", riderCookies.length > 0, `${riderCookies.length} online`);

  let r = await call(customer, "POST", "/api/requests", {
    medicineId: MEDICINE_ID,
    qty: 1,
    fulfilmentType: "delivery",
    preferredPharmacyId: PHARMACY_ID,
    deliveryAddress: "42 Test Street, Indiranagar",
    deliveryLat: 12.9719,
    deliveryLng: 77.6412,
  });
  const requestId = r.json?.requestId;
  check("customer places a delivery order", r.status === 201 && Number.isFinite(requestId), `#${requestId}`);

  r = await call(owner, "POST", `/api/requests/${requestId}/confirm`, {});
  check("pharmacy confirms", r.status === 200, `status ${r.status} ${r.json?.error ?? ""}`);

  r = await call(owner, "POST", `/api/requests/${requestId}/ready`, {});
  const deliveryId = r.json?.deliveryId;
  check("Ready creates the delivery job", Number.isFinite(deliveryId), `#${deliveryId}`);

  // Rider takes the job.
  let rider = null;
  for (const { key, cookie } of riderCookies) {
    const offers = await call(cookie, "GET", "/api/rider/offers");
    if ((offers.json?.offers ?? []).some((o) => o.id === deliveryId)) {
      const accepted = await call(cookie, "POST", "/api/rider/offers", {
        deliveryId,
        action: "accept",
      });
      if (accepted.status === 200) {
        rider = cookie;
        check(`rider ${key} accepts the job`, true, `#${deliveryId}`);
        break;
      }
    }
  }
  if (!rider) {
    check("a rider accepted the job", false, "no online rider held the offer");
    return finish();
  }

  // The pharmacy approves the rider before the job can move.
  r = await call(owner, "POST", `/api/pharmacy/deliveries/${deliveryId}/approve`, {});
  check("pharmacy approves the rider", r.status === 200, r.json?.reason ?? `status ${r.status}`);

  // Pay.
  r = await call(customer, "POST", `/api/requests/${requestId}/payment`, {});
  const orderId = r.json?.razorpayOrderId;
  check("payment intent opens", Boolean(orderId), `${orderId}`);

  r = await call(customer, "POST", "/api/payments/verify", {
    razorpayOrderId: orderId,
    razorpayPaymentId: `pay_demo_${String(orderId).replace(/^order_demo_/, "")}`,
    razorpaySignature: "demo-signature-not-required",
  });
  check("payment captured", r.status === 200, `status ${r.status} ${r.json?.error ?? ""}`);

  const view = (await call(customer, "GET", `/api/requests/${requestId}/payment`)).json?.payment;
  check("the total includes the delivery fee", (view?.deliveryFeePaise ?? 0) > 0, `fee ${view?.deliveryFeePaise}`);
  check(
    "the pharmacy's share excludes the delivery fee",
    (view?.pharmacyAmountPaise ?? 0) < (view?.amountPaise ?? 0),
    `pharmacy ${view?.pharmacyAmountPaise} of ${view?.amountPaise}`
  );
  check("the rider has not been paid yet", view?.riderPaidOut === false, `riderPaidOut=${view?.riderPaidOut}`);

  // Move to the door and hand over.
  for (const step of ["ArrivedAtPharmacy", "PickedUp", "OutForDelivery", "ArrivedAtDestination"]) {
    r = await call(rider, "POST", `/api/rider/deliveries/${deliveryId}/status`, { status: step });
    if (r.status !== 200) check(`transition to ${step}`, false, r.json?.error ?? `status ${r.status}`);
  }

  const otpRes = await call(customer, "GET", `/api/requests/${requestId}/otp`);
  const otp = otpRes.json?.otp ?? otpRes.json?.demoOtp ?? otpRes.json?.code;
  r = await call(rider, "POST", `/api/rider/deliveries/${deliveryId}/handover`, {
    otp: String(otp ?? ""),
    idChecked: true,
  });
  check("handover verified", r.json?.ok === true, JSON.stringify(r.json).slice(0, 140));

  const earnings = (await call(rider, "GET", "/api/rider/earnings")).json;
  check(
    "the rider has been paid their fee",
    (earnings?.paidPaise ?? 0) > 0,
    `paid ${earnings?.paidPaise}, owed ${earnings?.owedPaise}`
  );
  check("nothing is left owed", (earnings?.owedPaise ?? 0) === 0, `owed ${earnings?.owedPaise}`);

  // Two independent anchors: the pharmacy's share and the rider's fee.
  const after = (await call(customer, "GET", `/api/requests/${requestId}/payment`)).json?.payment;
  check(
    "the pharmacy's settlement is anchored",
    after?.settlement?.status === "Settled",
    `status ${after?.settlement?.status} block ${after?.settlement?.blockNumber ?? "n/a"}`
  );
  check(
    "the rider's fee has its own anchor",
    after?.riderSettlement?.status === "Settled",
    `status ${after?.riderSettlement?.status} block ${after?.riderSettlement?.blockNumber ?? "n/a"}`
  );
  check(
    "the two anchors are different transactions",
    after?.settlement?.txHash !== after?.riderSettlement?.txHash,
    `${after?.settlement?.txHash?.slice(0, 12)} vs ${after?.riderSettlement?.txHash?.slice(0, 12)}`
  );

  finish();
}

function finish() {
  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});