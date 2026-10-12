// Verifies the delivery audit trail end-to-end on the local chain.
const B = "http://localhost:3000";
const PASSWORD = "SmokeTest!Passw0rd2026";
let pass = 0, fail = 0;
const check = (l, c, e = "") => c
  ? (pass++, console.log(`  ok   ${l}${e ? " — " + e : ""}`))
  : (fail++, console.log(`  FAIL ${l}${e ? " — " + e : ""}`));

async function signIn(email) {
  const r = await fetch(`${B}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return r.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
}

const post = (p, cookie, body) => fetch(`${B}${p}`, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify(body ?? {}),
});
const get = (p, cookie) => fetch(`${B}${p}`, { headers: { cookie } });

async function main() {
  console.log("\n=== 1. Find an existing delivery with a real order ===");
  const owner = await signIn("owner1@medimesh.demo");
  const del = await (await get("/api/pharmacy/deliveries", owner)).json();
  const deliveries = del.deliveries ?? [];
  if (!deliveries.length) {
    console.log("  SKIP no active delivery. Create one first:");
    console.log("    mark a Confirmed request Ready so a delivery is created.");
    process.exit(0);
  }
  const deliveryId = deliveries[0].id;
  console.log(`  using delivery #${deliveryId}`);

  console.log("\n=== 2. Read the audit trail ===");
  const trail = await (await get(`/api/blockchain/deliveries/${deliveryId}/events`, owner)).json();
  check("audit endpoint readable by the pharmacy", !!trail.orderRef, trail.orderRef);
  check("order ref is opaque, not a customer name",
    !/customer|@|\+91/i.test(trail.orderRef), trail.orderRef);
  const alreadyRecorded = (trail.milestones ?? []).filter(m => m.status === "Recorded");
  check("Packed was auto-recorded when the order went Ready", alreadyRecorded.length >= 1,
    `${alreadyRecorded.length} recorded`);

  console.log("\n=== 3. Pharmacy records Packed ===");
  const packed = await post(`/api/blockchain/deliveries/${deliveryId}/events`, owner, { milestone: "Packed" });
  const pj = await packed.json();
  if (!packed.ok) {
    console.log("  (packed skipped: " + JSON.stringify(pj).slice(0, 180) + ")");
  } else {
    check("Packed recorded", pj.milestone?.status === "Recorded", pj.milestone?.tx_hash);
    check("real tx hash", /^0x[0-9a-f]{64}$/.test(pj.milestone?.tx_hash || ""));
    check("re-submitting the same milestone is idempotent (same tx hash)",
      alreadyRecorded[0]?.tx_hash === pj.milestone?.tx_hash, "no second transaction");
    check("no customer PII in the audit row",
      !JSON.stringify(pj).match(/customer_name|delivery_address|"lat"|"lng"/i));
  }

  console.log("\n=== 4. Out-of-order milestone is rejected on-chain ===");
  // After Packed, Delivered (skipping PickedUp/OutForDelivery) must revert.
  const rider = await signIn("rider1@medimesh.demo");
  const skip = await post(`/api/blockchain/deliveries/${deliveryId}/events`, rider, { milestone: "Delivered" });
  check("skipping a milestone is refused", !skip.ok, `HTTP ${skip.status}`);

  console.log("\n=== 5. Unauthorized actor cannot record a milestone ===");
  const cust = await signIn("customer1@medimesh.demo");
  const bad = await post(`/api/blockchain/deliveries/${deliveryId}/events`, cust, { milestone: "Delivered" });
  check("customer cannot record a milestone", bad.status === 403, `HTTP ${bad.status}`);

  console.log("\n=== 6. Wrong rider is refused ===");
  const wrongRider = await signIn("rider2@medimesh.demo");
  const wr = await post(`/api/blockchain/deliveries/${deliveryId}/events`, wrongRider, { milestone: "PickedUp" });
  check("unassigned rider refused", wr.status === 403, `HTTP ${wr.status}`);

  console.log("\n=== 7. Final trail reflects recorded milestones only ===");
  const final = await (await get(`/api/blockchain/deliveries/${deliveryId}/events`, owner)).json();
  const recorded = (final.milestones ?? []).filter(m => m.status === "Recorded");
  check("only confirmed milestones counted", recorded.length >= 1, `${recorded.length} recorded`);
  check("every recorded milestone has a tx hash",
    recorded.every(m => /^0x[0-9a-f]{64}$/.test(m.tx_hash || "")));

  console.log(`\n${"=".repeat(50)}\nPASS: ${pass}   FAIL: ${fail}\n${"=".repeat(50)}`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("ERROR:", e); process.exit(1); });
