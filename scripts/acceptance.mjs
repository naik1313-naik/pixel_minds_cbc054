#!/usr/bin/env node
// End-to-end acceptance smoke test for MediMesh.
// Drives the full lifecycle across customer → pharmacy → rider → customer.
//
//   BASE=http://localhost:3000 node scripts/acceptance.mjs
//
// Reads data/.demo-credentials.txt (generated on first run) for passwords.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://localhost:3000";
const DATA_DIR = process.env.MM_DATA_DIR || path.join(process.cwd(), "data");

function parseCredentials() {
  const file = path.join(DATA_DIR, ".demo-credentials.txt");
  if (!fs.existsSync(file)) throw new Error(`Credentials file not found: ${file}`);
  const map = new Map();
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let current = null;
  for (const line of lines) {
    const head = line.match(/^(\S+)\s+(\S+@\S+)/);
    if (head) {
      current = { role: head[1], email: head[2] };
      map.set(head[2], current);
      continue;
    }
    const pw = line.match(/^\s+password:\s+(.+)$/);
    if (pw && current) current.password = pw[1].trim();
    const secret = line.match(/^\s+TOTP secret:\s+(\S+)/);
    if (secret && current) current.totpSecret = secret[1].trim();
  }
  return map;
}

function base32Decode(input) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, time = Date.now()) {
  const counter = Math.floor(time / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

const creds = parseCredentials();

function client() {
  let cookie = "";
  return {
    async call(method, url, body, extraHeaders = {}) {
      const headers = { "content-type": "application/json", ...extraHeaders };
      if (cookie) headers.cookie = cookie;
      const res = await fetch(BASE + url, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { status: res.status, data };
    },
  };
}

let passed = 0;
let failed = 0;
function check(label, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  \u2713 ${label}`);
  } else {
    failed++;
    console.log(`  \u2717 ${label}${extra ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

async function login(email) {
  const cred = creds.get(email);
  if (!cred) throw new Error(`No credentials for ${email}`);
  const c = client();
  const res = await c.call("POST", "/api/auth/login", { email, password: cred.password });
  if (res.data?.requires2fa && res.data.challenge) {
    if (!cred.totpSecret) throw new Error(`2FA required for ${email} but no TOTP secret available`);
    const code = totp(cred.totpSecret);
    const second = await c.call("POST", "/api/auth/2fa", { challenge: res.data.challenge, code });
    if (second.status !== 200 || !second.data?.ok) {
      throw new Error(`2FA failed for ${email}: ${second.status} ${JSON.stringify(second.data)}`);
    }
    return { c, role: second.data.role, name: second.data.name };
  }
  if (res.status !== 200 || !res.data?.ok) {
    throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return { c, role: res.data.role, name: res.data.name };
}

async function main() {
  console.log(`\nMediMesh acceptance — ${BASE}\n`);

  // 1. Customer signs in and searches.
  const customer = await login("customer1@medimesh.demo");
  check("customer1 login", customer.role === "customer");

  const meds = (await customer.c.call("GET", "/api/medicines")).data.medicines;
  const med = meds.find((m) => m.rx_required === 0 && m.total_free >= 2) || meds.find((m) => m.total_free >= 1);
  check("medicine catalogue loaded", meds.length >= 20, { count: meds.length });
  check("target medicine in stock", Boolean(med), { med });

  const detail0 = (await customer.c.call("GET", `/api/medicines/${med.id}`)).data;
  check("availability exposes ranked pharmacies", detail0.pharmacies.length > 0);

  // 2. Customer creates a delivery request.
  const created = await customer.c.call("POST", "/api/requests", {
    medicineId: med.id,
    qty: 2,
    fulfilmentType: "delivery",
    deliveryAddress: "12, 100ft Road, Indiranagar, Bengaluru",
    deliveryLat: 12.9719,
    deliveryLng: 77.6412,
  }, { "idempotency-key": `acc-${Date.now()}` });
  check("request created", created.status === 201 || created.status === 200, created.data);
  const requestId = created.data.requestId;
  check("request has an id", typeof requestId === "number", created.data);

  // Idempotency: same key returns same request.
  const dup = await customer.c.call("POST", "/api/requests", {
    medicineId: med.id,
    qty: 2,
    fulfilmentType: "delivery",
    deliveryAddress: "12, 100ft Road, Indiranagar, Bengaluru",
    deliveryLat: 12.9719,
    deliveryLng: 77.6412,
  }, { "idempotency-key": `acc-dup-${requestId}` });
  const dup2 = await customer.c.call("POST", "/api/requests", {
    medicineId: med.id,
    qty: 2,
    fulfilmentType: "delivery",
    deliveryAddress: "12, 100ft Road, Indiranagar, Bengaluru",
    deliveryLat: 12.9719,
    deliveryLng: 77.6412,
  }, { "idempotency-key": `acc-dup-${requestId}` });
  check("idempotency key dedupes", dup2.data.requestId === dup.data.requestId, { first: dup.data.requestId, second: dup2.data.requestId });

  let detail = (await customer.c.call("GET", `/api/requests/${requestId}`)).data;
  check("request is sourced to a pharmacy", detail.request.preferred_pharmacy_id != null, detail.request);
  const pharmacyId = detail.request.preferred_pharmacy_id;

  // 3. Owning pharmacy confirms and marks ready.
  const owner = await login(`owner${pharmacyId}@medimesh.demo`);
  check(`owner${pharmacyId} login`, owner.role === "pharmacy_owner");

  if (detail.request.status !== "Confirmed") {
    const conf = await owner.c.call("POST", `/api/requests/${requestId}/confirm`);
    check("pharmacy confirms", conf.data?.ok === true, conf.data);
  } else {
    check("pharmacy confirm (already confirmed)", true);
  }
  const ready = await owner.c.call("POST", `/api/requests/${requestId}/ready`);
  check("pharmacy marks ready", ready.data?.ok === true, ready.data);
  const deliveryId = ready.data.deliveryId;
  check("delivery created", typeof deliveryId === "number", ready.data);

  // 4. Riders come online; one accepts the offer.
  const riders = [];
  for (const n of [1, 2, 3]) {
    const r = await login(`rider${n}@medimesh.demo`);
    await r.c.call("POST", "/api/rider/status", { online: true });
    riders.push(r);
  }
  check("riders online", riders.length === 3);

  let accepting = null;
  for (let attempt = 0; attempt < 10 && !accepting; attempt++) {
    for (const r of riders) {
      const offers = (await r.c.call("GET", "/api/rider/deliveries")).data.offers || [];
      if (offers.some((o) => o.id === deliveryId)) {
        accepting = r;
        break;
      }
    }
    if (!accepting) await new Promise((res) => setTimeout(res, 300));
  }
  check("delivery offered to a rider", Boolean(accepting));
  const accepted = await accepting.c.call("POST", "/api/rider/offers", { deliveryId, action: "accept" });
  check("rider accepts offer", accepted.data?.ok === true, accepted.data);

  // 5. The owning pharmacy approves the accepted rider before work may begin.
  const awaiting = (await customer.c.call("GET", `/api/requests/${requestId}`)).data;
  check("delivery awaits pharmacy approval", awaiting.delivery?.status === "AwaitingPharmacyApproval", awaiting.delivery?.status);
  const approved = await owner.c.call("POST", `/api/pharmacy/deliveries/${deliveryId}/approve`);
  check("pharmacy approves rider assignment", approved.data?.ok === true, approved.data);
  const afterApproval = (await owner.c.call("GET", `/api/pharmacy/deliveries`)).data.deliveries.find((d) => d.id === deliveryId);
  check("delivery becomes Assigned", afterApproval?.status === "Assigned", afterApproval?.status);

  // 6. Rider advances the state machine + streams location.
  const rideClient = accepting.c;
  const loc = await rideClient.call("POST", `/api/rider/deliveries/${deliveryId}/location`, { lat: 12.9719, lng: 77.6412, speed: 8 });
  check("rider location accepted", loc.data?.ok === true, loc.data);

  let advanced = 0;
  for (const next of ["ArrivedAtPharmacy", "PickedUp", "OutForDelivery", "ArrivedAtDestination"]) {
    const s = await rideClient.call("POST", `/api/rider/deliveries/${deliveryId}/status`, { status: next });
    if (s.data?.ok) advanced++;
  }
  check("rider walks the lifecycle", advanced === 4, { advanced });

  // Illegal transition is rejected.
  const illegal = await rideClient.call("POST", `/api/rider/deliveries/${deliveryId}/status`, { status: "Assigned" });
  check("illegal transition rejected", illegal.status === 409, illegal.data);

  // 7. Customer reveals demo OTP; rider completes handover.
  const otpRes = (await customer.c.call("GET", `/api/requests/${requestId}/otp`)).data;
  check("customer can reveal demo OTP", typeof otpRes.otp === "string" && otpRes.otp.length === 4, otpRes);

  const badOtp = await rideClient.call("POST", `/api/rider/deliveries/${deliveryId}/handover`, { otp: "0000", idChecked: false });
  check("wrong OTP rejected", badOtp.status === 400, badOtp.data);

  const good = await rideClient.call("POST", `/api/rider/deliveries/${deliveryId}/handover`, { otp: otpRes.otp, idChecked: false });
  check("correct OTP completes handover", good.data?.ok === true, good.data);

  const finalDetail = (await customer.c.call("GET", `/api/requests/${requestId}`)).data;
  check("request reaches terminal status", ["Completed", "Delivered"].includes(finalDetail.request.status), { status: finalDetail.request.status });
  check("delivery is Delivered", finalDetail.delivery?.status === "Delivered", finalDetail.delivery?.status);

  // 8. RBAC: customer cannot read admin overview.
  const forbidden = await customer.c.call("GET", "/api/admin/overview");
  check("RBAC blocks customer from admin", forbidden.status === 403, forbidden.status);

  // 9. Unauthenticated access blocked.
  const anon = await client().call("GET", "/api/requests");
  check("anonymous access blocked", anon.status === 401, anon.status);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nAcceptance crashed:", err);
  process.exit(1);
});
