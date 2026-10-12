// Creates a real customer order and drives it to Ready so a delivery exists.
const B = "http://localhost:3000";
const PASSWORD = "SmokeTest!Passw0rd2026";
const login = async (e) => {
  const r = await fetch(`${B}/api/auth/login`, { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: e, password: PASSWORD }) });
  return { cookie: r.headers.getSetCookie().map(c=>c.split(";")[0]).join("; "), json: await r.json() };
};
const post = (p, cookie, b) => fetch(`${B}${p}`, { method: "POST",
  headers: { "content-type": "application/json", cookie }, body: JSON.stringify(b ?? {}) });

const cust = await login("customer1@medimesh.demo");
const owner1 = await login("owner1@medimesh.demo");

// Pick pharmacy 1 explicitly so the owner sees the request.
const meds = await (await fetch(`${B}/api/medicines`)).json();
const med = meds.medicines.find(m => m.total_free > 0) ?? meds.medicines[0];
console.log("medicine:", med.id, med.name, "free:", med.total_free);

const r = await post("/api/requests", cust.cookie, {
  medicineId: med.id, qty: 1, fulfilmentType: "delivery",
  preferredPharmacyId: 1,
  deliveryAddress: "1 Test Road, Bengaluru", deliveryLat: 12.9719, deliveryLng: 77.6412,
});
const rj = await r.json();
if (!rj.requestId) { console.log("request failed:", rj); process.exit(1); }
console.log("request", rj.requestId, "status", rj.detail?.request?.status);

const st = rj.detail?.request?.status;
if (st === "NeedsVerification") {
  await post(`/api/requests/${rj.requestId}/verify`, owner1.cookie);
  console.log("rx verified");
}
const c = await post(`/api/requests/${rj.requestId}/confirm`, owner1.cookie);
console.log("confirm:", c.status, JSON.stringify((await c.json()).detail?.request?.status ?? ""));

const rd = await post(`/api/requests/${rj.requestId}/ready`, owner1.cookie);
const rdj = await rd.json();
console.log("ready:", rd.status, "deliveryId:", rdj.deliveryId, "audit:", JSON.stringify(rdj.audit));
