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
} from "@/lib/engine";
import { REQUEST_STATUS } from "@/lib/constants";

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
    expect(await totalFreeStock(3)).toBe(0); // Crocin Advance — out everywhere
    expect((await availability(3))?.total_free).toBe(0);
  });

  it("respects the low-stock seed numbers", async () => {
    expect(await totalFreeStock(17)).toBe(5);
    expect(await totalFreeStock(10)).toBe(3);
    expect(await totalFreeStock(19)).toBe(4);
    expect(await totalFreeStock(20)).toBe(2);
  });
});

describe("request lifecycle", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("sources a well-stocked medicine and confirms at the owner's pharmacy", async () => {
    const { requestId } = await createRequest({
      medicineId: 1,
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
      medicineId: 9, // Amoxicillin, rx required
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
    // Only 2 units of medicine 20 exist network-wide.
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { requestId } = await createRequest({
        medicineId: 20,
        qty: 5,
        customerId: null,
        customerName: `C${i}`,
        fulfilmentType: "pickup",
      });
      ids.push(requestId);
    }
    const secured = await queryOne<{ s: number }>(
      "SELECT COALESCE(SUM(secured_qty),0)::int AS s FROM requests WHERE medicine_id = $1",
      [20]
    );
    expect(secured!.s).toBe(2);
    const locked = await queryAll<{ qty_locked: number }>(
      "SELECT qty_locked FROM inventory WHERE medicine_id = $1",
      [20]
    );
    expect(locked.reduce((a, b) => a + b.qty_locked, 0)).toBe(2);
  });

  it("is idempotent on the idempotency key", async () => {
    const a = await createRequest({
      medicineId: 1,
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
      idempotencyKey: "key-123",
    });
    const b = await createRequest({
      medicineId: 1,
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
    const before = await totalFreeStock(1);
    const { requestId } = await createRequest({
      medicineId: 1,
      qty: 5,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    expect(await totalFreeStock(1)).toBe(before - 5);
    // simulate elapsed time
    await queryRun("UPDATE reservations SET lock_expires_at = $1 WHERE request_id = $2", [
      new Date(Date.now() - 1000).toISOString(),
      requestId,
    ]);
    const n = await sweepExpired();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await totalFreeStock(1)).toBe(before);
    expect((await getRequestDetail(requestId))!.request.status).toBe(REQUEST_STATUS.EXPIRED);
    // idempotent: second sweep does nothing new
    expect(await sweepExpired()).toBe(0);
    await setLockSeconds(1800);
  });

  it("suggests substitutes sharing the same salt", async () => {
    const subs = await findSubstitutes(1); // Paracetamol 500mg -> Acetaminophen
    const ids = subs.map((s) => s.medicine.id).sort();
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  it("fails to source when the medicine is fully unavailable", async () => {
    const { requestId } = await createRequest({
      medicineId: 3,
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    expect((await getRequestDetail(requestId))!.request.status).toBe(REQUEST_STATUS.UNAVAILABLE);
    const lost = await queryOne<{ c: number }>(
      "SELECT COUNT(*)::int AS c FROM lost_sales WHERE medicine_id = $1",
      [3]
    );
    expect(lost!.c).toBe(1);
  });

  it("records requests for the customer", async () => {
    const { requestId } = await createRequest({
      medicineId: 4,
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
      medicineId: 1,
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
