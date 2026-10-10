import { describe, it, expect, beforeEach } from "vitest";
import { getDb, resetDemo } from "@/lib/db";
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

function ownerOf(pharmacyId: number) {
  return getDb()
    .prepare("SELECT id, role FROM users WHERE role = 'pharmacy_owner' AND pharmacy_id = ?")
    .get(pharmacyId) as { id: number; role: string };
}

describe("availability", () => {
  beforeEach(() => resetDemo());

  it("reports zero network stock for a medicine with no inventory", () => {
    expect(totalFreeStock(3)).toBe(0); // Crocin Advance — out everywhere
    expect(availability(3)?.total_free).toBe(0);
  });

  it("respects the low-stock seed numbers", () => {
    expect(totalFreeStock(17)).toBe(5);
    expect(totalFreeStock(10)).toBe(3);
    expect(totalFreeStock(19)).toBe(4);
    expect(totalFreeStock(20)).toBe(2);
  });
});

describe("request lifecycle", () => {
  beforeEach(() => resetDemo());

  it("sources a well-stocked medicine and confirms at the owner's pharmacy", () => {
    const { requestId } = createRequest({
      medicineId: 1,
      qty: 3,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    const detail = getRequestDetail(requestId)!;
    expect(detail.request.status).toBe(REQUEST_STATUS.SOURCING);
    expect(detail.request.secured_qty).toBe(3);
    const pharmacyId = detail.request.preferred_pharmacy_id!;
    const owner = ownerOf(pharmacyId);
    const res = confirmRequest(requestId, { userId: owner.id, role: owner.role });
    expect(res.ok).toBe(true);
    expect(getRequestDetail(requestId)!.request.status).toBe(REQUEST_STATUS.CONFIRMED);
  });

  it("gates prescription medicines behind verification", () => {
    const { requestId } = createRequest({
      medicineId: 9, // Amoxicillin, rx required
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    expect(getRequestDetail(requestId)!.request.status).toBe(REQUEST_STATUS.NEEDS_VERIFICATION);
    const pharmacyId = getRequestDetail(requestId)!.request.preferred_pharmacy_id!;
    const owner = ownerOf(pharmacyId);
    const blocked = confirmRequest(requestId, { userId: owner.id, role: owner.role });
    expect(blocked.ok).toBe(false);
    expect(verifyRx(requestId, { userId: owner.id, role: owner.role }).ok).toBe(true);
    expect(confirmRequest(requestId, { userId: owner.id, role: owner.role }).ok).toBe(true);
  });

  it("does not oversell limited stock under repeated demand", () => {
    // Only 2 units of medicine 20 exist network-wide.
    const ids: number[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        createRequest({
          medicineId: 20,
          qty: 5,
          customerId: null,
          customerName: `C${i}`,
          fulfilmentType: "pickup",
        }).requestId
      );
    }
    const db = getDb();
    const secured = db
      .prepare(
        `SELECT COALESCE(SUM(secured_qty),0) AS s FROM requests WHERE medicine_id = 20`
      )
      .get() as { s: number };
    expect(secured.s).toBe(2);
    const locked = db
      .prepare("SELECT qty_locked FROM inventory WHERE medicine_id = 20")
      .all() as { qty_locked: number }[];
    expect(locked.reduce((a, b) => a + b.qty_locked, 0)).toBe(2);
  });

  it("is idempotent on the idempotency key", () => {
    const a = createRequest({
      medicineId: 1,
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
      idempotencyKey: "key-123",
    });
    const b = createRequest({
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

  it("expires locks after the timer and restores stock", () => {
    setLockSeconds(1);
    const before = totalFreeStock(1);
    const { requestId } = createRequest({
      medicineId: 1,
      qty: 5,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    expect(totalFreeStock(1)).toBe(before - 5);
    // simulate elapsed time
    getDb()
      .prepare("UPDATE reservations SET lock_expires_at = ? WHERE request_id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), requestId);
    const n = sweepExpired();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(totalFreeStock(1)).toBe(before);
    expect(getRequestDetail(requestId)!.request.status).toBe(REQUEST_STATUS.EXPIRED);
    // idempotent: second sweep does nothing new
    expect(sweepExpired()).toBe(0);
    setLockSeconds(1800);
  });

  it("suggests substitutes sharing the same salt", () => {
    const subs = findSubstitutes(1); // Paracetamol 500mg -> Acetaminophen
    const ids = subs.map((s) => s.medicine.id).sort();
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });

  it("fails to source when the medicine is fully unavailable", () => {
    const { requestId } = createRequest({
      medicineId: 3,
      qty: 1,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    expect(getRequestDetail(requestId)!.request.status).toBe(REQUEST_STATUS.UNAVAILABLE);
    const lost = getDb().prepare("SELECT COUNT(*) AS c FROM lost_sales WHERE medicine_id = 3").get() as { c: number };
    expect(lost.c).toBe(1);
  });

  it("records requests for the customer", () => {
    const { requestId } = createRequest({
      medicineId: 4,
      qty: 1,
      customerId: 9999,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    const rows = listRequests({ customerId: 9999 }) as { id: number }[];
    expect(rows.some((r) => r.id === requestId)).toBe(true);
  });
});

describe("sourceRequest is one-way", () => {
  beforeEach(() => resetDemo());
  it("does not re-source an already sourced request", () => {
    const { requestId } = createRequest({
      medicineId: 1,
      qty: 2,
      customerId: null,
      customerName: "Test",
      fulfilmentType: "pickup",
    });
    const before = getDb()
      .prepare("SELECT COUNT(*) AS c FROM reservations WHERE request_id = ?")
      .get(requestId) as { c: number };
    sourceRequest(requestId);
    const after = getDb()
      .prepare("SELECT COUNT(*) AS c FROM reservations WHERE request_id = ?")
      .get(requestId) as { c: number };
    expect(after.c).toBe(before.c);
  });
});
