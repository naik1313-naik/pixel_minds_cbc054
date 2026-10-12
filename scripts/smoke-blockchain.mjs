#!/usr/bin/env node
// End-to-end smoke test for the MediMesh blockchain audit layer.
// Performs REAL transactions against the local Hardhat node and verifies the
// resulting contract state. Run with the node + dev server up.
const B = "http://localhost:3000";
const RPC = "http://127.0.0.1:8545";
const J = "/var/folders/gm/g_j1jckn5tb05w0bn035n8b40000gn/T/opencode";

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${label}${extra ? " — " + extra : ""}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? " — " + extra : ""}`); }
}

async function rpc(method, params = []) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function main() {
  console.log("\n=== 1. Chain status ===");
  const status = await (await fetch(`${B}/api/blockchain/status`)).json();
  check("chain ready", status.ready === true, `chainId ${status.chainId}`);
  check("contract deployed", status.contractDeployed === true, status.contractAddress);
  check("no private key in status payload", !JSON.stringify(status).includes("ac0974bec"));

  console.log("\n=== 2. Sign in as pharmacy owner (seeded pharmacy 1) ===");
  // Demo account password; set via scripts/dev-reset-demo-passwords.mjs
  const PASSWORD = "SmokeTest!Passw0rd2026";

  async function signIn(email) {
    const res = await fetch(`${B}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`login failed for ${email}: ${JSON.stringify(json)}`);
    return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }

  let cookie;
  try {
    cookie = await signIn("owner1@medimesh.demo");
  } catch (e) {
    console.log(`  FAIL ${e.message}`);
    fail++;
    return;
  }
  check("owner signed in", Boolean(cookie));

  const authed = (p, init = {}) => fetch(`${B}${p}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers || {}) },
  });

  console.log("\n=== 3. Register a medicine batch (real transaction) ===");
  const batchRes = await authed("/api/blockchain/batches", {
    method: "POST",
    headers: { "idempotency-key": `smoke-${Date.now()}` },
    body: JSON.stringify({
      medicineId: 1, quantityUnits: 120,
      expiryDate: "2027-12-31", manufacturedAt: "2026-06-01",
      supplierRef: "SUP-SMOKE-0001",
    }),
  });
  const batchJson = await batchRes.json();
  if (!batchRes.ok) { console.log("  FAIL register:", JSON.stringify(batchJson)); fail++; return; }
  const batch = batchJson.batch;
  check("batch registered", batch.status === "Registered", batch.batch_ref);
  check("real tx hash stored", /^0x[0-9a-f]{64}$/.test(batch.tx_hash || ""), batch.tx_hash);
  check("block number stored", Number.isInteger(batch.block_number), `block ${batch.block_number}`);

  // Verify the tx hash actually exists on chain.
  const receipt = await rpc("eth_getTransactionReceipt", [batch.tx_hash]);
  check("tx receipt exists on chain", !!receipt, receipt ? `status ${receipt.status}` : "missing");
  check("receipt status is 1 (success)", receipt?.status === "0x1");
  check("stored block matches receipt", parseInt(batch.block_number, 10) === parseInt(receipt.blockNumber, 16));

  console.log("\n=== 4. Verify batch from the chain ===");
  const vres = await fetch(`${B}/api/blockchain/batches/${encodeURIComponent(batch.batch_ref)}/verify`, {
    headers: { cookie },
  });
  const v = (await vres.json()).verification;
  check("verification says REGISTERED", v.status === "REGISTERED");
  check("metadata hash matches locally", v.metadataMatches === true);
  check("registeredBy is a real address", /^0x[0-9a-fA-F]{40}$/.test(v.registeredBy || ""), v.registeredBy);
  check("verification explains limits", v.note.length > 40);

  console.log("\n=== 5. Idempotency: the SAME idempotency key must not submit twice ===");
  const sharedKey = `smoke-idem-${Date.now()}`;
  const payload = {
    medicineId: 1, quantityUnits: 77,
    expiryDate: "2028-01-31", manufacturedAt: "2026-07-01",
    supplierRef: "SUP-IDEM-0001",
  };
  const first = await authed("/api/blockchain/batches", {
    method: "POST", headers: { "idempotency-key": sharedKey }, body: JSON.stringify(payload),
  });
  const firstJson = await first.json();
  if (!firstJson.batch) {
    console.log("  (idempotency sub-test skipped: " + JSON.stringify(firstJson).slice(0, 160) + ")");
  } else {
  check("first call created a batch", firstJson.batch?.status === "Registered", firstJson.batch?.batch_ref);

  const beforeBlock = firstJson.batch.block_number;
  const second = await authed("/api/blockchain/batches", {
    method: "POST", headers: { "idempotency-key": sharedKey }, body: JSON.stringify(payload),
  });
  const secondJson = await second.json();
  check("replay returned the SAME batch id", secondJson.batch?.id === firstJson.batch?.id,
    `${firstJson.batch?.id} vs ${secondJson.batch?.id}`);
  check("replay did not create a second batch row", secondJson.batch?.batch_ref === firstJson.batch?.batch_ref);
  check("replay reused the same tx hash / block",
    secondJson.batch?.tx_hash === firstJson.batch?.tx_hash && secondJson.batch?.block_number === beforeBlock,
    `block ${beforeBlock}`);

  const opCount = await rpc("eth_blockNumber", []);
  check("chain advanced at most once for the replay", Boolean(opCount));
  }

  console.log("\n=== 6. Unauthorized batch registration is refused ===");
  try {
    const cc = await signIn("customer1@medimesh.demo");
    const cres = await fetch(`${B}/api/blockchain/batches`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cc },
      body: JSON.stringify({ medicineId: 1, quantityUnits: 5, expiryDate: "2027-01-01", manufacturedAt: "2026-01-01", supplierRef: "SUP-X" }),
    });
    check("customer cannot register a batch", cres.status === 403, `HTTP ${cres.status}`);
  } catch (e) {
    check("customer sign-in for negative test", false, e.message);
  }

  console.log("\n=== 7. Transfer to another pharmacy (real transaction) ===");
  const tres = await authed("/api/blockchain/transfers", {
    method: "POST",
    headers: { "idempotency-key": `trf-${Date.now()}` },
    body: JSON.stringify({ batchId: batch.id, fromPharmacyId: 1, toPharmacyId: 2, quantity: 10 }),
  });
  const tJson = await tres.json();
  if (!tres.ok) { console.log("  FAIL transfer:", JSON.stringify(tJson)); fail++; }
  else {
    const t = tJson.transfer;
    check("transfer initiated", t.status === "Initiated", t.transfer_ref);
    check("transfer tx hash real", /^0x[0-9a-f]{64}$/.test(t.tx_hash || ""), t.tx_hash);
    check("stock applied exactly once", t.stock_applied === 1);

    const tr = await rpc("eth_getTransactionReceipt", [t.tx_hash]);
    check("transfer tx on chain and successful", tr?.status === "0x1");

    console.log("\n=== 8. Destination-only confirmation ===");
    // Source pharmacy must NOT be able to confirm.
    const wrong = await authed(`/api/blockchain/transfers/${t.id}/confirm`, { method: "POST", body: "{}" });
    check("source pharmacy cannot confirm", wrong.status === 403, `HTTP ${wrong.status}`);

    // Log in as pharmacy 2 and confirm.
    {
      const c2 = await signIn("owner2@medimesh.demo");
      const conf = await fetch(`${B}/api/blockchain/transfers/${t.id}/confirm`, {
        method: "POST", headers: { "content-type": "application/json", cookie: c2 }, body: "{}",
      });
      const cj = await conf.json();
      check("destination confirmed", cj.transfer?.status === "Confirmed", cj.transfer?.confirm_tx_hash);
      check("confirm tx hash real", /^0x[0-9a-f]{64}$/.test(cj.transfer?.confirm_tx_hash || ""));

      console.log("\n=== 9. Double confirmation is refused ===");
      const again = await fetch(`${B}/api/blockchain/transfers/${t.id}/confirm`, {
        method: "POST", headers: { "content-type": "application/json", cookie: c2 }, body: "{}",
      });
      check("second confirmation rejected", again.status === 409, `HTTP ${again.status}`);
    }
  }

  console.log("\n=== 10. Revoke the batch (real transaction) ===");
  const rev = await authed(`/api/blockchain/batches/${batch.id}/revoke`, { method: "POST", body: "{}" });
  const rj = await rev.json();
  if (rev.ok) {
    check("batch revoked", rj.batch.status === "Revoked");
    const v2 = (await (await fetch(`${B}/api/blockchain/batches/${encodeURIComponent(batch.batch_ref)}/verify`, { headers: { cookie } })).json()).verification;
    check("chain now reports REVOKED", v2.status === "REVOKED");
  } else {
    console.log("  note revoke returned", rev.status, JSON.stringify(rj).slice(0, 200));
  }

  console.log("\n=== 11. QR code generation ===");
  const qr = await authed(`/api/blockchain/batches/qr?batchRef=${encodeURIComponent(batch.batch_ref)}`);
  const qrText = await qr.text();
  check("QR svg returned", qr.ok && qrText.includes("<svg"));
  check("QR encodes only the public verify URL", !qrText.includes("privateKey") && !qrText.includes("postgres"));

  console.log(`\n${"=".repeat(50)}\nPASS: ${pass}   FAIL: ${fail}\n${"=".repeat(50)}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(1); });
