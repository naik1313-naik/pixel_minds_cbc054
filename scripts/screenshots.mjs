#!/usr/bin/env node
// Capture the demo UI so it can be reviewed without a browser.
//
//   node scripts/screenshots.mjs            # login + all four role views
//
// Uses the one-tap demo sign-in, so every shot is a state a judge can actually
// reach. Writes PNGs to demo-assets/screenshots/.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://localhost:3000";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "demo-assets", "screenshots");
fs.mkdirSync(outDir, { recursive: true });

/** Minimal cookie jar so this script can drive the same APIs the UI calls. */
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
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

async function shot(name, note) {
  await page.waitForTimeout(700);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  saved ${path.relative(root, file)}${note ? ` — ${note}` : ""}`);
}

async function demoLogin(key) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: new RegExp(key, "i") }).first().click();
  // The app holds open SSE connections, so waiting for "load" can hang even
  // though the navigation succeeded. Commit is the reliable signal here.
  await page.waitForURL(/\/(app|pharmacy|rider|admin)/, {
    waitUntil: "commit",
    timeout: 25_000,
  });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}

console.log("Capturing demo UI…\n");

// Clear anything left over from a previous run: a stale active delivery keeps a
// rider "busy", which makes the rider screenshots and the contact card silently
// miss their subject.
await (async () => {
  const cleanup = jar();
  await call(cleanup, "POST", "/api/auth/demo-login", { key: "admin" });
  const res = await call(cleanup, "GET", "/api/admin/orders");
  const stale = (res.json.orders ?? []).filter(
    (o) =>
      o.delivery_id &&
      !["Delivered", "Cancelled", "ReturnedToPharmacy"].includes(o.delivery_status ?? "")
  );
  for (const o of stale) {
    await call(
      cleanup,
      "POST",
      `/api/rider/deliveries/${o.delivery_id}/status`,
      { status: "Cancelled" }
    ).catch(() => {});
  }
  if (stale.length) console.log(`  cleared ${stale.length} stale delivery(ies) from an earlier run`);
})();

// 1. Login page — the one-tap demo buttons.
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await shot("01-login-demo-accounts", "one-tap demo sign-in");

// 2. Customer view
await demoLogin("Asha");
await shot("02-customer-search", "medicine search");

// 3. A real order for the tracker + payment panel to show. Placed through the
// same API the UI calls, so the captured screens are a state a judge can reach.
const orderId = await page.evaluate(async () => {
  const res = await fetch("/api/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ medicineId: 1, qty: 2, fulfilmentType: "pickup", preferredPharmacyId: 1 }),
  });
  const body = await res.json();
  return body.requestId;
});

const link = page.locator(`a[href*='/app/request/${orderId}']`).first();
if (await link.count()) {
  await link.click();
} else {
  await page.goto(`${BASE}/app/request/${orderId}`);
}
await page.waitForLoadState("networkidle");
await shot("03-customer-request-awaiting-pharmacy", `order #${orderId} before confirmation`);

// The pharmacy confirms, which is what opens the payment step.
await demoLogin("Apollo Pharmacy");
await page.evaluate(
  async ([id]) => {
    await fetch(`/api/requests/${id}/confirm`, { method: "POST" });
  },
  [orderId]
);

// Back to the customer to pay.
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await demoLogin("Asha");
await page.goto(`${BASE}/app/request/${orderId}`);
await page.waitForLoadState("networkidle");
await shot("03b-customer-request-payable", "order confirmed — payment open");

await page.getByRole("button", { name: /^Pay /i }).first().click();
await page.waitForTimeout(1800);
await shot("03c-customer-request-paid", "paid — awaiting fulfilment");

// A delivery order walked all the way to an assigned rider, so the customer's
// "your rider" contact card is visible in the capture.
const deliveryOrderId = await page.evaluate(async () => {
  const res = await fetch("/api/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      medicineId: 2,
      qty: 1,
      fulfilmentType: "delivery",
      preferredPharmacyId: 1,
      deliveryAddress: "42 Test Street, Indiranagar",
      deliveryLat: 12.9719,
      deliveryLng: 77.6412,
    }),
  });
  return (await res.json()).requestId;
});

// Pharmacy confirms and marks it Ready, which creates the job.
await demoLogin("Apollo Pharmacy");
await page.evaluate(async ([id]) => {
  await fetch(`/api/requests/${id}/confirm`, { method: "POST" });
  await fetch(`/api/requests/${id}/ready`, { method: "POST" });
}, [deliveryOrderId]);
let deliveryId = null;

// A rider accepts and the pharmacy approves.
// Regex-safe: the label contains parentheses, which would otherwise be read as
// a capture group and fail to match the literal text.
// A rider accepts and the pharmacy approves. Done through the API with its own
// session rather than the browser's: reusing the page context means whichever
// account was signed in last decides the request, which silently produced
// "no rider assigned" captures.
for (const key of ["rider1", "rider2"]) {
  const riderSession = jar();
  await call(riderSession, "POST", "/api/auth/demo-login", { key });
  await call(riderSession, "POST", "/api/rider/status", { online: true });
  const mine = await call(riderSession, "GET", "/api/rider/deliveries");
  if ((mine.json.deliveries ?? []).length > 0) {
    console.log(`      ${key} is busy with an earlier job, trying the next rider`);
    continue;
  }
  // Read the job id back from the operator's order list rather than trusting the
  // shape of the ready response — this is the one id the whole step depends on.
  const asAdmin = jar();
  await call(asAdmin, "POST", "/api/auth/demo-login", { key: "admin" });
  const listed = await call(asAdmin, "GET", "/api/admin/orders");
  const job = (listed.json.orders ?? []).find((o) => o.request_id === deliveryOrderId);
  if (!job?.delivery_id) {
    console.log(`      ${key}: no delivery job found for order #${deliveryOrderId}`);
    continue;
  }
  const accepted = await call(riderSession, "POST", "/api/rider/offers", {
    deliveryId: job.delivery_id,
    action: "accept",
  });
  if (accepted.status === 200) {
    deliveryId = job.delivery_id;
    break;
  }
  console.log(`      ${key}: ${accepted.json.error ?? "could not accept"}, trying the next rider`);
}

const adminSession = jar();
await call(adminSession, "POST", "/api/auth/demo-login", { key: "admin" });
const approved = await call(
  adminSession,
  "POST",
  `/api/pharmacy/deliveries/${deliveryId}/approve`,
  {}
);
if (!approved.json.ok) console.log("      (no rider assigned — the contact card will not appear)");

// Back to the customer: the rider contact card is the point of this shot.
await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await demoLogin("Asha");
await page.goto(`${BASE}/app/request/${deliveryOrderId}`);
await page.waitForLoadState("networkidle");
await shot("03d-customer-rider-contact", "delivery order — reach your rider");

// 4. Pharmacy console
await demoLogin("Apollo Pharmacy");
await shot("04-pharmacy-console", "incoming requests");

// 5. Payouts tab
await page.getByRole("button", { name: /Payouts/i }).first().click();
await page.waitForLoadState("networkidle");
await shot("05-pharmacy-payouts", "payouts + settlement receipts");

// 5b. Same tab after fulfilling, so the settled state is captured too.
await page.evaluate(
  async ([id]) => {
    await fetch(`/api/requests/${id}/complete`, { method: "POST" });
  },
  [orderId]
);
await page.getByRole("button", { name: /^Refresh$|Refresh/i }).first().click();
await page.waitForTimeout(1200);
await shot("05b-pharmacy-payouts-settled", "after fulfilment — payout credited + on-chain receipt");

// The settled receipt with its QR — the artefact a customer can carry away.
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await demoLogin("Asha");
await page.goto(`${BASE}/app/request/${orderId}`);
await page.waitForSelector("img[alt*='QR']", { timeout: 15_000 }).catch(() => {});
await shot("03e-customer-receipt-qr", "settled receipt — QR for public verification");

// Grab the settlement reference from the pharmacy's own session. Done with a
// dedicated jar rather than the page's, because by this point the browser may be
// signed in as someone else — and /api/pharmacy/payments answers 403 to a
// customer, which silently reads as "nothing settled yet". The on-chain anchor
// also takes a moment after fulfilment, so poll rather than read once.
let settlementRef = null;
{
  const pharmacy = jar();
  await call(pharmacy, "POST", "/api/auth/demo-login", { key: "owner1" });
  for (let attempt = 0; attempt < 12 && !settlementRef; attempt++) {
    const res = await call(pharmacy, "GET", "/api/pharmacy/payments");
    settlementRef = res.json?.payments?.find((p) => p.settlementRef)?.settlementRef ?? null;
    if (!settlementRef) await new Promise((r) => setTimeout(r, 1000));
  }
}

// 6. Rider console
await demoLogin("Kiran");
await shot("06-rider-console", "delivery partner view");

// 7. Admin console — orders with all three parties joined.
await demoLogin("Demo Admin");
await page.getByRole("button", { name: /^Orders/i }).first().click();
// Wait for a real row, not just for the network to go quiet.
await page.waitForSelector("table tbody tr", { timeout: 15_000 }).catch(() => {});
await shot("07-admin-orders", "orders — customer, pharmacy and rider on one row");

await page.getByRole("button", { name: /Write outbox/i }).first().click();
await page.waitForTimeout(1200);
await shot("07b-admin-write-outbox", "outbox health and reconciliation");

await page.getByRole("button", { name: /^Overview/i }).first().click();
await page.waitForTimeout(600);
await shot("07c-admin-overview", "network overview");

// 8. Public settlement verification — the unauthenticated page a judge can
// open on their own phone.
if (settlementRef) {
  const publicPage = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const anon = await publicPage.newPage();
  await anon.goto(`${BASE}/verify/settlement/${settlementRef}`, { waitUntil: "networkidle" });
  await anon.waitForTimeout(500);
  await anon.screenshot({ path: path.join(outDir, "08-public-settlement-verify.png"), fullPage: true });
  console.log(`  saved demo-assets/screenshots/08-public-settlement-verify.png — ${settlementRef}`);
  await publicPage.close();
} else {
  console.log("  (no settled payout yet — complete an order to capture the verify page)");
}

await browser.close();
console.log(`\nDone. Screenshots in ${path.relative(root, outDir)}/`);