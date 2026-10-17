import { describe, it, expect, beforeEach } from "vitest";
import { resetDemo, queryOne, queryAll, queryRun } from "@/lib/db";
import {
  availability,
  totalFreeStock,
  createRequest,
  getRequestDetail,
  confirmRequest,
  verifyRx,
  sourceRequest,
  sweepExpired,
  setLockSeconds,
  findSubstitutes,
  listRequests,
  RequestValidationError,
} from "@/lib/engine";
import { REQUEST_STATUS } from "@/lib/constants";

/**
 * Resolves a catalogue entry by what it is, not by its id.
 *
 * The catalogue grew from 24 hand-numbered rows to 123 entries, and every test
 * that hardcoded "medicine 3 is out of stock" started asserting something about
 * a different product. Ids are an implementation detail; this keeps the tests
 * describing the behaviour they were written for.
 */
async function medicineIdFor(generic: string, brand?: string, strength?: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `SELECT id FROM medicines
      WHERE LOWER(generic_name) = LOWER($1)
        AND ($2::text IS NULL OR LOWER(brand_name) = LOWER($2))
        AND ($3::text IS NULL OR strength_value::text = $3)
      ORDER BY id LIMIT 1`,
    [generic, brand ?? null, strength ?? null]
  );
  if (!row) throw new Error(`No catalogue entry for ${generic} ${brand ?? ""} ${strength ?? ""}`);
  return row.id;
}

/** A catalogue entry that the demo deliberately stocks almost nowhere. */
async function scarceMedicineId(): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `SELECT m.id FROM medicines m
       LEFT JOIN inventory i ON i.medicine_id = m.id
      GROUP BY m.id
     HAVING COALESCE(SUM(GREATEST(0, i.qty_total - i.qty_locked)), 0) <= 3
      ORDER BY m.id LIMIT 1`
  );
  if (!row) throw new Error("No scarce medicine in the seed");
  return row.id;
}

/** The medicine most tests order: stocked widely, so the happy path is testable. */
const WELL_STOCKED = await medicineIdFor("Paracetamol", undefined, "500");

async function ownerOf(pharmacyId: number) {
  return (await queryOne<{ id: number; role: string }>(
    "SELECT id, role FROM users WHERE role = 'pharmacy_owner' AND pharmacy_id = $1",
    [pharmacyId]
  ))!;
}

describe("availability", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("reports zero network stock for a medicine with no inventory", async () => {
    // Tramadol is in the catalogue but deliberately absent from the stock plan.
    const unstocked = await medicineIdFor("Tramadol");
    const row = await queryOne<{ stocked: number }>(
      "SELECT COUNT(*)::int AS stocked FROM inventory WHERE medicine_id = $1",
      [unstocked]
    );
    expect(row?.stocked).toBe(0);
    expect(await totalFreeStock(unstocked)).toBe(0);
    expect((await availability(unstocked))?.total_free).toBe(0);
  });

  it("respects the seeded stock numbers", async () => {
    // Well-stocked: a strip of paracetamol should be available everywhere.
    expect(await totalFreeStock(await medicineIdFor("Paracetamol", undefined, "500"))).toBeGreaterThan(100);
    // Scarce: the demo stocks a handful, deliberately, so the substitution and
    // "nearly out" paths have something real to exercise.
    const scarce = await scarceMedicineId();
    expect(await totalFreeStock(scarce)).toBeLessThanOrEqual(3);
  });
});

describe("request lifecycle", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("sources a well-stocked medicine and confirms at the owner's pharmacy", async () => {
    const { requestId } = await createRequest({
      medicineId: await WELL_STOCKED,
      qty: 3,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    const detail = (await getRequestDetail(requestId))!;
    expect(detail.request.status).toBe(REQUEST_STATUS.SOURCING);
    expect(detail.request.secured_qty).toBe(3);
    const pharmacyId = detail.request.preferred_pharmacy_id!;
    const owner = await ownerOf(pharmacyId);
    const res = await confirmRequest(requestId, { userId: owner.id, role: owner.role });
    expect(res.ok).toBe(true);
    expect((await getRequestDetail(requestId))!.request.status).toBe(REQUEST_STATUS.CONFIRMED);
  });

  it("gates prescription medicines behind verification", async () => {
    const { requestId } = await createRequest({
      medicineId: await medicineIdFor("Amoxicillin"), // rx required
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    expect((await getRequestDetail(requestId))!.request.status).toBe(REQUEST_STATUS.NEEDS_VERIFICATION);
    const pharmacyId = (await getRequestDetail(requestId))!.request.preferred_pharmacy_id!;
    const owner = await ownerOf(pharmacyId);
    const blocked = await confirmRequest(requestId, { userId: owner.id, role: owner.role });
    expect(blocked.ok).toBe(false);
    expect((await verifyRx(requestId, { userId: owner.id, role: owner.role })).ok).toBe(true);
    expect((await confirmRequest(requestId, { userId: owner.id, role: owner.role })).ok).toBe(true);
  });

  it("does not oversell limited stock under repeated demand", async () => {
    // Only 3 units of sildenafil exist network-wide, across one pharmacy.
    const scarce = await medicineIdFor("Sildenafil");
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { requestId } = await createRequest({
        medicineId: scarce,
        qty: 5,
        customerId: null,
        customerName: `C${i}`,
        fulfilmentType: "pickup",
      });
      ids.push(requestId);
    }
    const secured = await queryOne<{ s: number }>(
      "SELECT COALESCE(SUM(secured_qty),0)::int AS s FROM requests WHERE medicine_id = $1",
      [scarce]
    );
    expect(secured!.s).toBeGreaterThan(0);
    const locked = await queryAll<{ qty_locked: number }>(
      "SELECT qty_locked FROM inventory WHERE medicine_id = $1",
      [scarce]
    );
    // The real invariant: never more secured than exists.
    const total = (await queryOne<{ t: number }>(
      "SELECT COALESCE(SUM(qty_total),0)::int AS t FROM inventory WHERE medicine_id = $1",
      [scarce]
    ))!.t;
    expect(locked.reduce((a, b) => a + b.qty_locked, 0)).toBeLessThanOrEqual(total);
  });

  it("is idempotent on the idempotency key", async () => {
    const a = await createRequest({
      medicineId: await WELL_STOCKED,
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
      idempotencyKey: "key-123",
    });
    const b = await createRequest({
      medicineId: await WELL_STOCKED,
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
      idempotencyKey: "key-123",
    });
    expect(a.requestId).toBe(b.requestId);
    expect(b.created).toBe(false);
  });

  it("expires locks after the timer and restores stock", async () => {
    await setLockSeconds(1);
    const before = await totalFreeStock(WELL_STOCKED);
    const { requestId } = await createRequest({
      medicineId: await WELL_STOCKED,
      qty: 5,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    expect(await totalFreeStock(WELL_STOCKED)).toBe(before - 5);
    // simulate elapsed time
    await queryRun("UPDATE reservations SET lock_expires_at = $1 WHERE request_id = $2", [
      new Date(Date.now() - 1000).toISOString(),
      requestId,
    ]);
    const n = await sweepExpired();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await totalFreeStock(WELL_STOCKED)).toBe(before);
    expect((await getRequestDetail(requestId))!.request.status).toBe(REQUEST_STATUS.EXPIRED);
    // idempotent: second sweep does nothing new
    expect(await sweepExpired()).toBe(0);
    await setLockSeconds(1800);
  });

  it("routes the request to the pharmacy the customer picked", async () => {
    const target = (await queryOne<{ id: number }>(
      "SELECT id FROM pharmacies WHERE verification_status = 'verified' ORDER BY id LIMIT 1"
    ))!;
    const { requestId } = await createRequest({
      medicineId: await WELL_STOCKED,
      qty: 2,
      customerId: null,
      customerName: "Directed",
      fulfilmentType: "pickup",
      preferredPharmacyId: target.id,
    });
    const detail = (await getRequestDetail(requestId))!;
    expect(detail.request.preferred_pharmacy_id).toBe(target.id);
    // The chosen pharmacy's owner sees it in their console.
    const visible = await listRequests({ pharmacyId: target.id });
    expect(visible.map((r) => r.id)).toContain(requestId);
  });

  it("serves the customer's pharmacy first even when it ranks lower", async () => {
    const target = (await queryOne<{ id: number }>(
      "SELECT id FROM pharmacies WHERE verification_status = 'verified' ORDER BY id LIMIT 1"
    ))!;
    // Give the chosen pharmacy a small slice of a medicine nobody else stocks,
    // so auto-ranking would not pick it.
    const rare = await medicineIdFor("Tamsulosin");
    await queryRun(
      `INSERT INTO inventory (pharmacy_id, medicine_id, qty_total, qty_locked)
       VALUES ($1, $2, 2, 0)
       ON CONFLICT (pharmacy_id, medicine_id)
       DO UPDATE SET qty_total = 2, qty_locked = 0`,
      [target.id, rare]
    );
    await queryRun(
      "UPDATE inventory SET qty_total = 0, qty_locked = 0 WHERE pharmacy_id <> $1 AND medicine_id = $2",
      [target.id, rare]
    );
    const { requestId } = await createRequest({
      medicineId: rare,
      qty: 2,
      customerId: null,
      customerName: "Directed",
      fulfilmentType: "pickup",
      preferredPharmacyId: target.id,
    });
    const detail = (await getRequestDetail(requestId))!;
    expect(detail.request.preferred_pharmacy_id).toBe(target.id);
    expect(detail.request.secured_qty).toBe(2);
  });

  it("still delivers a directed request when the chosen pharmacy has no stock", async () => {
    const target = (await queryOne<{ id: number }>(
      "SELECT id FROM pharmacies WHERE verification_status = 'verified' ORDER BY id LIMIT 1"
    ))!;
    // Albendazole is in the catalogue but deliberately stocked nowhere, and is
    // over-the-counter so this test exercises routing rather than the Rx gate.
    const rare = await medicineIdFor("Albendazole");
    const { requestId } = await createRequest({
      medicineId: rare,
      qty: 2,
      customerId: null,
      customerName: "Directed",
      fulfilmentType: "pickup",
      preferredPharmacyId: target.id,
    });
    const detail = (await getRequestDetail(requestId))!;
    // Routed to the chosen owner instead of being dropped as a lost sale.
    expect(detail.request.preferred_pharmacy_id).toBe(target.id);
    expect(detail.request.status).toBe(REQUEST_STATUS.SOURCING);
    expect(await listRequests({ pharmacyId: target.id })).toHaveLength(1);
    const lost = await queryOne<{ c: number }>("SELECT COUNT(*)::int AS c FROM lost_sales");
    expect(lost!.c).toBe(0);

    // Once the owner restocks, they can confirm it.
    await queryRun(
      `INSERT INTO inventory (pharmacy_id, medicine_id, qty_total, qty_locked)
       VALUES ($1, $2, 5, 0)
       ON CONFLICT (pharmacy_id, medicine_id) DO UPDATE SET qty_total = 5, qty_locked = 0`,
      [target.id, rare]
    );
    const owner = await ownerOf(target.id);
    expect((await confirmRequest(requestId, { userId: owner.id, role: owner.role })).ok).toBe(true);
  });

  it("marks an undirected out-of-stock request as a lost sale", async () => {
    const { requestId } = await createRequest({
      medicineId: await medicineIdFor("Tramadol"),
      qty: 2,
      customerId: null,
      customerName: "Undirected",
      fulfilmentType: "pickup",
    });
    expect((await getRequestDetail(requestId))!.request.status).toBe(REQUEST_STATUS.UNAVAILABLE);
    const lost = await queryOne<{ c: number }>("SELECT COUNT(*)::int AS c FROM lost_sales");
    expect(lost!.c).toBe(1);
  });

  it("rejects a preferred pharmacy that is not verified", async () => {
    await queryRun("UPDATE pharmacies SET verification_status = 'pending' WHERE id = 1");
    await expect(
      createRequest({
        medicineId: await WELL_STOCKED,
        qty: 1,
        customerId: null,
        customerName: "Test",
        fulfilmentType: "pickup",
        preferredPharmacyId: 1,
      })
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("suggests substitutes sharing the same salt", async () => {
    const paracetamol = await medicineIdFor("Paracetamol", undefined, "500");
    const subs = await findSubstitutes(paracetamol); // Paracetamol -> Acetaminophen
    const ids = subs.map((s) => s.medicine.id);
    // Same active ingredient, different strength and brand. Offered as
    // suggestions for a pharmacist to approve — never as an automatic swap.
    expect(ids).toContain(await medicineIdFor("Paracetamol", "Crocin Advance", "400"));
    expect(ids).toContain(await medicineIdFor("Paracetamol", "Dolo 650", "650"));
  });

  it("fails to source when the medicine is fully unavailable", async () => {
    const { requestId } = await createRequest({
      medicineId: await medicineIdFor("Tramadol"),
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    expect((await getRequestDetail(requestId))!.request.status).toBe(REQUEST_STATUS.UNAVAILABLE);
    const lost = await queryOne<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM lost_sales WHERE medicine_id = $1",
      [await medicineIdFor("Tramadol")]
    );
    expect(lost!.c).toBe(1);
  });

  it("records requests for the customer", async () => {
    const { requestId } = await createRequest({
      medicineId: await medicineIdFor("Vitamin C"),
      qty: 1,
      customerId: 9999,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    const rows = (await listRequests({ customerId: 9999 })) as { id: number }[];
    expect(rows.some((r) => r.id === requestId)).toBe(true);
  });
});

describe("sourceRequest is one-way", () => {
  beforeEach(async () => {
    await resetDemo();
  });
  it("does not re-source an already sourced request", async () => {
    const { requestId } = await createRequest({
      medicineId: await WELL_STOCKED,
      qty: 2,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    const before = await queryOne<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM reservations WHERE request_id = $1",
      [requestId]
    );
    await sourceRequest(requestId);
    const after = await queryOne<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM reservations WHERE request_id = $1",
      [requestId]
    );
    expect(after!.c).toBe(before!.c);
  });
});
