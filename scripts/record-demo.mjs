/**
 * Records a MediMesh blockchain demo as a video using a real browser session.
 *
 * Every on-chain step shown here is a real transaction against the local
 * Hardhat node. Nothing is mocked and no hash is fabricated.
 *
 *   node scripts/record-demo.mjs
 */
import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:3000";
const PASSWORD = "SmokeTest!Passw0rd2026";
const OUT = path.join(process.cwd(), "demo-assets");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  📸 ${name}`);
}

async function login(page, email) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  // Let React hydrate, otherwise the controlled inputs discard what we fill in.
  await sleep(1200);

  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await sleep(300);

  // Confirm the values survived hydration before submitting.
  const typed = await page.locator('input[type="email"]').inputValue();
  if (typed !== email) throw new Error(`login field did not retain the email (got "${typed}")`);

  await page.locator('button[type="submit"]').click();
  try {
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 });
  } catch {
    const err = await page.locator("form").innerText().catch(() => "");
    throw new Error(`login did not navigate away from /login. Form says: ${err.slice(0, 120)}`);
  }
  await sleep(2200);
  console.log(`  🔑 signed in as ${email}`);
}

async function openTab(page, name) {
  await page.getByRole("button", { name: new RegExp(name, "i") }).first().click();
  await sleep(2500);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

let batchRef = null;

try {
  console.log("\n=== 1. Landing ===");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await sleep(2500);
  await shot(page, "01-landing");

  const status = await (await fetch(`${BASE}/api/blockchain/status`)).json();
  console.log(
    `  chain ${status.chainId} · contract ${status.contractAddress} · ready ${status.ready}`
  );

  console.log("\n=== 2. Pharmacy owner signs in ===");
  await login(page, "owner1@medimesh.demo");
  await shot(page, "02-pharmacy-console");

  console.log("\n=== 3. Batches tab — live chain panel ===");
  await openTab(page, "Batches");
  await shot(page, "03-batches-chain-status");

  console.log("\n=== 4. Register a medicine batch (REAL transaction) ===");
  await page.getByRole("button", { name: /Register a medicine batch/i }).click();
  await sleep(1000);

  // The medicine select and the units number input.
  await page.locator('select').first().selectOption({ index: 1 });
  await page.locator('input[type="number"]').first().fill("120");
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("2028-06-30");
  await dates.nth(1).fill("2026-09-01");
  await page
    .locator('input[placeholder="No invoices or document numbers"]')
    .fill("SUP-DEMO-2026");
  await sleep(800);
  await shot(page, "04-batch-form");

  const blocksBefore = Number((await (await fetch(`${BASE}/api/blockchain/status`)).json()) && 0);

  await page.getByRole("button", { name: /^Register batch$/i }).click();

  // Wait for the success toast — it only appears after a confirmed receipt.
  await page.waitForSelector("text=/Batch registered on-chain/i", { timeout: 60000 });
  await sleep(3500);
  await shot(page, "05-batch-registered");

  // Read the new batch straight from the rendered row (the API needs a cookie).
  batchRef = (await page.locator("text=/^MM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{8}$/").first().textContent())?.trim();
  if (!batchRef) throw new Error("no batch row appeared after registration");

  // Pull its tx hash + block from the row text for the narration log.
  const rowText = await page
    .locator("div", { hasText: /MM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{8}/ })
    .last()
    .innerText()
    .catch(() => "");
  const txMatch = rowText.match(/0x[0-9a-f]{10,}/);
  const blkMatch = rowText.match(/block (\d+)/);
  console.log(`  ✅ ${batchRef}`);
  console.log(`     tx  ${txMatch?.[0] ?? "?"}`);
  console.log(`     blk ${blkMatch?.[1] ?? "?"}`);
  void blocksBefore;

  console.log("\n=== 5. Public QR verification page ===");
  await page.goto(`${BASE}/verify/${batchRef}`, { waitUntil: "networkidle" });
  await sleep(2800);
  await shot(page, "06-verify-page");

  const verifyText = await page.locator("body").innerText();
  const statusLabel = /Registered/.test(verifyText) ? "Registered" : /Revoked/.test(verifyText) ? "Revoked" : "?";
  const metaMatch = /Yes — stored metadata is unaltered/.test(verifyText) ? "unaltered" : "mismatch";
  console.log(`  on-chain status: ${statusLabel} · metadata ${metaMatch}`);

  console.log("\n=== 6. Initiate a pharmacy transfer (REAL transaction) ===");
  await page.goto(`${BASE}/pharmacy`, { waitUntil: "networkidle" });
  await sleep(1500);
  await openTab(page, "Transfers");
  await shot(page, "07-transfer-panel");

  await page.locator("select").first().selectOption({ label: batchRef });
  await page.locator("select").nth(1).selectOption({ index: 1 });
  await sleep(800);
  await page.getByRole("button", { name: /Initiate transfer/i }).click();

  await page.waitForFunction(
    () => /TRF-[A-Z0-9-]{20,}/.test(document.body.innerText),
    { timeout: 60000 }
  );
  await sleep(3500);
  await shot(page, "08-transfer-initiated");

  const tRef = (await page.locator("text=/^TRF-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{8}$/").first().textContent())?.trim();
  console.log(`  ✅ ${tRef ?? "transfer row present"}`);

  console.log("\n=== 7. Destination pharmacy confirms (REAL transaction) ===");
  await login(page, "owner2@medimesh.demo");
  await openTab(page, "Transfers");
  await shot(page, "09-destination-inbound");

  const confirmBtn = page.getByRole("button", { name: /^Confirm$/ }).first();
  if (await confirmBtn.count()) {
    await confirmBtn.click();
    await sleep(4500);
    await shot(page, "10-transfer-confirmed");
    const body = await page.locator("body").innerText();
    console.log(`  confirmed on-chain: ${/Confirmed/.test(body)}`);
  } else {
    console.log("  (no Confirm button visible for this account)");
  }

  console.log("\n=== 8. Delivery audit trail ===");
  await login(page, "owner1@medimesh.demo");
  await openTab(page, "Deliveries");
  await shot(page, "11-delivery-audit");

  console.log("\n=== 9. Customer view ===");
  await login(page, "customer1@medimesh.demo");
  await sleep(2500);
  await shot(page, "12-customer-app");

  console.log(`\n🎬 batch = ${batchRef}`);
} catch (e) {
  console.error("RECORDING ERROR:", e.message);
  await shot(page, "error-state").catch(() => {});
} finally {
  await context.close();
  await browser.close();
}

const files = fs.readdirSync(OUT).filter((f) => f.endsWith(".webm"));
if (files.length) {
  const dst = path.join(OUT, "medimesh-blockchain-demo.webm");
  fs.renameSync(path.join(OUT, files[0]), dst);
  console.log(`✅ Video: ${dst}`);
}
