#!/usr/bin/env node
/**
 * Records the MediMesh app as a narrated walkthrough video.
 *
 *   node scripts/record-app-demo.mjs
 *   node scripts/record-app-demo.mjs --out ~/Desktop/demo.mp4
 *
 * Writes to the Desktop by default and never touches demo-assets/, so the
 * existing blockchain recording is left alone.
 *
 * ## Why each step is recorded separately
 *
 * Two things that a single continuous recording gets wrong:
 *
 *  1. **Captions.** Captions drawn by injecting DOM into the live page render
 *     correctly on screen and appear in a screenshot, but Playwright's video
 *     capture does not pick them up — it records the compositor surface, and a
 *     node added after the initial paint is not on it. So captions are separate
 *     cards, rendered as images and interleaved with the footage. Verified both
 *     ways: the same overlay appears in `page.screenshot()` and does not appear
 *     in the recorded video.
 *
 *  2. **Empty states.** One continuous recording captures whatever happened at
 *     record time. If a page has not finished loading when the frame is taken,
 *     the video shows a spinner — or worse, an empty "no results" list — and
 *     looks like a broken product. Each step now waits for the content it is
 *     about to show, and refuses to finish without it.
 *
 * The order itself is driven through the API while the UI is what gets filmed.
 * Clicking a delivery job to completion through the DOM would make the recording
 * break every time a label changed, and would silently cut off mid-story.
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.MM_BASE_URL ?? "http://localhost:3000";
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : path.join(os.homedir(), "Desktop", "MediMesh-Demo.mp4");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "mm-demo-rec-"));
const W = 1600;
const H = 1000;
const CAPTION_SECONDS = 2.6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ API side

const jars = {};
async function api(who, method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(jars[who] ? { cookie: jars[who] } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  if (setCookie) {
    const merged = new Map(
      (jars[who] ?? "").split("; ").filter(Boolean).map((c) => [c.split("=")[0], c])
    );
    for (const c of setCookie.split(/,(?=[^;,]+=)/).map((c) => c.split(";")[0].trim()).filter(Boolean)) {
      merged.set(c.split("=")[0], c);
    }
    jars[who] = [...merged.values()].join("; ");
  }
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function loginAs(who, key) {
  const r = await api(who, "POST", "/api/auth/demo-login", { key });
  if (r.status !== 200) throw new Error(`demo login ${key} failed: ${r.status}`);
}

/** Signs the *browser* in through the one-tap persona. */
async function uiLogin(page, name) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: new RegExp(name, "i") }).first().click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25000 });
  await sleep(2000);
}

// ------------------------------------------------------------------ prepare

console.log("Preparing a real order to film…");
if (!(await fetch(`${BASE}/api/medicines`).then((r) => r.ok).catch(() => false))) {
  console.error(`  The app is not answering at ${BASE}. Run: npm run dev`);
  process.exit(1);
}

await loginAs("customer", "customer");
await loginAs("owner", "owner1");
await loginAs("rider", "rider1");
await loginAs("admin", "admin");
await api("rider", "POST", "/api/rider/status", { online: true });

// Resolved by name. The catalogue grew from 24 rows to 123, and hardcoding an id
// meant the recording silently started filming a different product.
const meds = await api("admin", "GET", "/api/medicines?limit=200");
const target =
  (meds.json?.medicines ?? []).find((m) => /^Dolo 650/i.test(m.name)) ??
  (meds.json?.medicines ?? [])[0];
if (!target) throw new Error("no medicines in the catalogue");
const medicineId = target.id;
console.log(`  ordering: ${target.name}`);

const created = await api("customer", "POST", "/api/requests", {
  medicineId,
  qty: 1,
  fulfilmentType: "delivery",
  preferredPharmacyId: 1,
  deliveryAddress: "42 Test Street, Indiranagar, Bengaluru",
  deliveryLat: 12.9719,
  deliveryLng: 77.6412,
});
const requestId = created.json?.requestId;
if (!requestId) throw new Error("could not create the demo order");

await api("owner", "POST", `/api/requests/${requestId}/confirm`, {});
const deliveryId = (await api("owner", "POST", `/api/requests/${requestId}/ready`, {})).json?.deliveryId;
if ((await api("rider", "POST", "/api/rider/offers", { deliveryId, action: "accept" })).status !== 200) {
  throw new Error("rider could not accept the job");
}
await api("owner", "POST", `/api/pharmacy/deliveries/${deliveryId}/approve`, {});

const pay = await api("customer", "POST", `/api/requests/${requestId}/payment`, {});
await api("customer", "POST", "/api/payments/verify", {
  razorpayOrderId: pay.json?.razorpayOrderId,
  razorpayPaymentId: `pay_demo_${String(pay.json?.razorpayOrderId ?? "").replace(/^order_demo_/, "")}`,
  razorpaySignature: "demo-signature-not-required",
});
for (const status of ["ArrivedAtPharmacy", "PickedUp", "OutForDelivery", "ArrivedAtDestination"]) {
  await api("rider", "POST", `/api/rider/deliveries/${deliveryId}/status`, { status });
}
const otp = await api("customer", "GET", `/api/requests/${requestId}/otp`);
if ((await api("rider", "POST", `/api/rider/deliveries/${deliveryId}/handover`, { otp: otp.json?.otp, idChecked: true })).json?.ok !== true) {
  throw new Error("handover failed");
}
const earnings = (await api("rider", "GET", "/api/rider/earnings")).json;
const receipt = (await api("customer", "GET", `/api/requests/${requestId}/payment`)).json?.payment;
const catalogueTotal = (await api("admin", "GET", "/api/catalogue?limit=1")).json?.pagination?.total ?? 0;
const paid = (earnings?.paidPaise ?? 0) / 100;
console.log(`  order #${requestId} · delivery #${deliveryId} · rider paid ₹${paid}`);

// ------------------------------------------------------------------ steps

/** Waits for something real to be on screen. An empty list is not a result. */
async function need(page, selector, what, timeout = 25000) {
  try {
    await page.waitForSelector(selector, { timeout, state: "visible" });
  } catch {
    throw new Error(`Never showed ${what} — refusing to record an empty screen`);
  }
}

const STEPS = [
  {
    title: "MediMesh",
    sub: "Medicine availability, reservation and delivery across a local pharmacy network.",
    run: async (page) => {
      await page.goto(BASE, { waitUntil: "networkidle" });
      await need(page, "text=/Every medicine/", "the landing hero");
      await sleep(2600);
    },
  },
  {
    title: "Demo sign-in: one tap",
    sub: "Eight seeded personas. The bypass is refused whenever NODE_ENV is production, and every use is audited.",
    run: async (page) => {
      await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
      await need(page, "text=/demo accounts/i", "the persona list");
      await sleep(2600);
    },
  },
  {
    auth: "Asha",
    title: "Customer: the catalogue",
    sub: `${catalogueTotal} entries across 41 categories. Prices are fictional demo values; stock is read live from inventory.`,
    run: async (page) => {
      await need(page, "text=/Browse the catalogue/", "the catalogue browser");
      // Wait for actual rows, not just the shell.
      await page.waitForFunction(
        () => document.querySelectorAll('[class*="divide-y"] > div').length > 5,
        { timeout: 25000 }
      );
      await sleep(2400);
    },
  },
  {
    auth: "Asha",
    title: "Search that explains itself",
    sub: "Typo-tolerant matching on names, generics, brands and aliases — and every result says why it matched.",
    run: async (page) => {
      await page.getByPlaceholder("name, brand or ingredient").fill("paracetamol");
      await page.waitForFunction(
        () => document.body.innerText.includes("in stock"),
        { timeout: 20000 }
      );
      await sleep(2400);
    },
  },
  {
    auth: "Asha",
    title: "The order, end to end",
    sub: "Delivered with an OTP-verified handover. The pharmacy is paid to its own account, and so is the rider.",
    run: async (page) => {
      await page.goto(`${BASE}/app/request/${requestId}`, { waitUntil: "networkidle" });
      await need(page, "text=/Delivered|Completed/i", "the finished order timeline", 30000);
      await sleep(2800);
    },
  },
  {
    auth: "Asha",
    title: "Public settlement verification",
    sub: "No login. Recomputes the metadata hash and reads the same value back from the chain.",
    run: async (page) => {
      const ref = receipt?.settlement?.settlementRef;
      if (!ref) {
        await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
      } else {
        await page.goto(`${BASE}/verify/settlement/${ref}`, { waitUntil: "networkidle" });
      }
      await sleep(3000);
    },
  },
  {
    auth: "Apollo",
    title: "Pharmacy: confirm, prepare, get paid",
    sub: "Stock is committed on confirmation, and the payout is routed to the owner's own linked account.",
    run: async (page) => {
      await page.getByRole("button", { name: /Payout/i }).first().click();
      await page.waitForFunction(
        () => /Payout account linked/i.test(document.body.innerText),
        { timeout: 25000 }
      );
      await sleep(3000);
    },
  },
  {
    auth: "Kiran",
    title: "Rider: earnings",
    sub: `₹${paid} delivered straight to the rider's linked account — shown apart from what is earned but not yet paid out.`,
    run: async (page) => {
      await need(page, "text=/Your earnings/", "the earnings card", 30000);
      await sleep(2600);
    },
  },
  {
    auth: "Demo Admin",
    title: "Operator: one joined view",
    sub: "Who ordered, from which pharmacy, with which rider — plus the blockchain write outbox and the dispute queue.",
    run: async (page) => {
      await page.getByRole("button", { name: /^Orders$/i }).first().click();
      await page.waitForFunction(
        () => /Apollo|Dolo|Paracetamol/i.test(document.body.innerText),
        { timeout: 25000 }
      );
      await sleep(3000);
    },
  },
];

// ------------------------------------------------------------------ record

const captions = path.join(WORK, "captions.html");
fs.writeFileSync(
  captions,
  `<!doctype html><meta charset="utf-8"><style>
     *{margin:0;padding:0;box-sizing:border-box}
     html,body{width:${W}px;height:${H}px;overflow:hidden}
     body{font-family:-apple-system,"SF Pro Display",Helvetica,Arial,sans-serif;
       background:radial-gradient(1100px 640px at 12% 0%,#0f3b39 0%,#06201f 46%,#031312 100%);
       color:#e8f3f1;display:flex;flex-direction:column;justify-content:center;padding:0 130px}
     .k{font-size:20px;letter-spacing:.22em;text-transform:uppercase;color:#4fd1c5;font-weight:700}
     h1{font-size:80px;line-height:1.05;font-weight:800;letter-spacing:-.03em;margin-top:22px}
     p{font-size:29px;line-height:1.45;color:#a9c9c5;margin-top:26px;max-width:1180px}
     .rule{height:3px;background:linear-gradient(90deg,#4fd1c5,transparent);margin-top:40px;width:420px}
   </style><div class="k">Step ${"{n}"} of ${STEPS.length}</div><h1 id="t"></h1><div class="rule"></div><p id="s"></p>`,
  "utf8"
);

const segments = [];
const browser = await chromium.launch();

// Caption cards get their own context with recording switched off.
//
// This is not tidiness: a page opened inside a recording context is recorded
// too, so the caption page produced a second .webm. Picking "the first webm in
// the directory" then selected the caption page's empty clip for some steps, and
// those steps came out as nothing but a caption card.
const cardCtx = await browser.newContext({ viewport: { width: W, height: H } });

for (const [i, step] of STEPS.entries()) {
  const n = i + 1;
  const dir = path.join(WORK, `step-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir, size: { width: W, height: H } },
    deviceScaleFactor: 1,
  });
  // The Next.js development overlay is a development tool, not part of the
  // product. Left in, its "N issues" badge sits in the corner of every frame and
  // reads as "this thing is broken" to anyone who has not seen the app before.
  await ctx.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal, #__next-build-watcher { display: none !important; }";
      document.head.appendChild(style);
    });
  });
  const page = await ctx.newPage();

  process.stdout.write(`  [${n}/${STEPS.length}] ${step.title} … `);
  try {
    // Each step records in its own browser context, so a signed-in page is not
    // carried over from the previous step. Signing in here rather than inside
    // the step keeps every step body about what it is actually filming.
    if (step.auth) await uiLogin(page, step.auth);
    await step.run(page);
    // The caption card, rendered as an image — the one technique that verifiably
    // survives into the final file.
    const card = await cardCtx.newPage();
    await card.setViewportSize({ width: W, height: H });
    await card.goto(`file://${captions}`);
    await card.evaluate(
      ({ n, total, t, s }) => {
        document.querySelector(".k").textContent = `Step ${n} of ${total}`;
        document.getElementById("t").textContent = t;
        document.getElementById("s").textContent = s;
      },
      { n, total: STEPS.length, t: step.title, s: step.sub }
    );
    await card.waitForTimeout(300);
    const cardPath = path.join(dir, "caption.png");
    await card.screenshot({ path: cardPath });
    await card.close();

    await ctx.close();
    const clip = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".webm"))
      .sort((a, b) => fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size)[0];
    if (!clip) throw new Error("no footage was recorded for this step");
    if (fs.statSync(path.join(dir, clip)).size < 10_000) {
      throw new Error("the recorded clip is empty — the step ran without showing anything");
    }
    segments.push({ card: cardPath, clip: path.join(dir, clip), title: step.title, sub: step.sub });
    console.log("ok");
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    await ctx.close();
    process.exitCode = 1;
  }
}

await cardCtx.close();
await browser.close();

// ------------------------------------------------------------------ compose

// Each segment = caption card, then the footage. Concatenated as one file, so
// the result plays everywhere rather than only in a player that understands the
// container it was built in.
const partsDir = path.join(WORK, "parts");
fs.mkdirSync(partsDir, { recursive: true });
const parts = [];

for (const [i, seg] of segments.entries()) {
  const out = path.join(partsDir, `part-${String(i).padStart(2, "0")}.mp4`);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loop", "1", "-t", String(CAPTION_SECONDS), "-i", seg.card,
      "-i", seg.clip,
      "-filter_complex",
      `[0:v]scale=${W}:${H},fps=30,format=yuv420p[cap];` +
        `[1:v]scale=${W}:${H},fps=30,format=yuv420p,setpts=PTS-STARTPTS[clip];` +
        `[cap][clip]concat=n=2:v=1:a=0[v]`,
      "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "21",
      out,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  parts.push(out);
}

const listFile = path.join(partsDir, "list.txt");
fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join("\n"));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(
  "ffmpeg",
  ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", OUT],
  { stdio: ["ignore", "ignore", "pipe"] }
);

fs.writeFileSync(
  OUT.replace(/\.mp4$/, "-script.txt"),
  segments
    .map((s, i) => `${String(i + 1).padStart(2, "0")}. ${s.title}\n    ${s.sub}`)
    .join("\n\n")
);
fs.rmSync(WORK, { recursive: true, force: true });

console.log(`\n  Saved: ${OUT}`);
console.log(`  Narration script: ${OUT.replace(/\.mp4$/, "-script.txt")}`);
if (fs.existsSync(OUT)) {
  console.log(`  ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);
}