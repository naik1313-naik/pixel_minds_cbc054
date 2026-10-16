import { describe, it, expect, beforeEach } from "vitest";
import { resetDemo, queryOne, queryRun, queryAll } from "@/lib/db";
import { createRequest, completeRequest, getRequestDetail, confirmRequest } from "@/lib/engine";
import { createDeliveryForRequest, verifyHandover } from "@/lib/delivery";

/**
 * Expiry is enforced in two places, and the second one is the one that matters.
 *
 * Availability queries already hide expired batches, so an expired medicine can
 * rarely be reserved. But a batch can pass its date while an order sits Ready,
 * and stock can also be made to expire by anything holding an inventory row. If
 * nothing re-checks at the moment of dispense, all that earlier filtering is
 * theatre.
 */
async function fixture() {
  const medicine = (
    await queryOne<{ id: number }>("SELECT id FROM medicines ORDER BY id LIMIT 1")
  )!;
  const customer = (
    await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role = 'customer' ORDER BY id LIMIT 1"
    )
  )!;
  const { requestId } = await createRequest({
    medicineId: medicine.id,
    qty: 1,
    customerId: customer.id,
    customerName: "Expiry Fixture",
    fulfilmentType: "pickup",
  });
  const d = (await getRequestDetail(requestId))!;
  const owner = (
    await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role = 'pharmacy_owner' AND pharmacy_id = $1",
      [d.request.preferred_pharmacy_id]
    )
  )!;
  await confirmRequest(requestId, { userId: owner.id, role: "pharmacy_owner" });
  return { requestId, ownerId: owner.id, pharmacyId: d.request.preferred_pharmacy_id!, medicineId: medicine.id, customerId: customer.id };
}

/** Backdates every inventory row this order's reservations touch. */
async function expireStockFor(pharmacyId: number, medicineId: number) {
  await queryRun(
    "UPDATE inventory SET expiry_date = (CURRENT_DATE - 1)::text WHERE pharmacy_id = $1 AND medicine_id = $2",
    [pharmacyId, medicineId]
  );
}

describe("expired stock at the moment of dispense", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("refuses to complete a pickup order whose stock has expired", async () => {
    const f = await fixture();
    await expireStockFor(f.pharmacyId, f.medicineId);

    const result = await completeRequest(f.requestId, {
      userId: f.ownerId,
      role: "pharmacy_owner",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it("leaves the order and its stock untouched when it refuses", async () => {
    const f = await fixture();
    await expireStockFor(f.pharmacyId, f.medicineId);
    const before = (
      await queryOne<{ qty_total: number; qty_locked: number }>(
        "SELECT qty_total, qty_locked FROM inventory WHERE pharmacy_id = $1 AND medicine_id = $2",
        [f.pharmacyId, f.medicineId]
      )
    )!;

    await completeRequest(f.requestId, { userId: f.ownerId, role: "pharmacy_owner" });

    const after = (
      await queryOne<{ qty_total: number; qty_locked: number }>(
        "SELECT qty_total, qty_locked FROM inventory WHERE pharmacy_id = $1 AND medicine_id = $2",
        [f.pharmacyId, f.medicineId]
      )
    )!;
    expect(after.qty_total).toBe(before.qty_total);
    expect(after.qty_locked).toBe(before.qty_locked);
    const req = (await queryOne<{ status: string }>("SELECT status FROM requests WHERE id = $1", [
      f.requestId,
    ]))!;
    expect(req.status).not.toBe("Completed");
  });

  it("records the refusal in the audit trail", async () => {
    const f = await fixture();
    await expireStockFor(f.pharmacyId, f.medicineId);
    await completeRequest(f.requestId, { userId: f.ownerId, role: "pharmacy_owner" });

    const rows = await queryAll<{ action: string; meta_json: string }>(
      "SELECT action, meta_json FROM audit_log WHERE action = 'request.blocked_expired_stock'"
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].meta_json).toContain("expiry");
  });

  it("still completes stock that is inside its date", async () => {
    const f = await fixture();
    await queryRun(
      "UPDATE inventory SET expiry_date = (CURRENT_DATE + 30)::text WHERE pharmacy_id = $1 AND medicine_id = $2",
      [f.pharmacyId, f.medicineId]
    );
    const result = await completeRequest(f.requestId, { userId: f.ownerId, role: "pharmacy_owner" });
    expect(result.ok).toBe(true);
  });

  it("treats a batch expiring today as still usable", async () => {
    const f = await fixture();
    await queryRun(
      "UPDATE inventory SET expiry_date = CURRENT_DATE::text WHERE pharmacy_id = $1 AND medicine_id = $2",
      [f.pharmacyId, f.medicineId]
    );
    const result = await completeRequest(f.requestId, { userId: f.ownerId, role: "pharmacy_owner" });
    expect(result.ok).toBe(true);
  });

  it("refuses a delivery handover when the medicine has expired", async () => {
    const medicine = (
      await queryOne<{ id: number }>("SELECT id FROM medicines ORDER BY id LIMIT 1")
    )!;
    const pharmacy = (
      await queryOne<{ id: number }>("SELECT id FROM pharmacies ORDER BY id LIMIT 1")
    )!;
    expect(pharmacy.id).toBeGreaterThan(0);
    const partner = (
      await queryOne<{ id: number }>(
        "SELECT id FROM users WHERE role = 'delivery_partner' ORDER BY id LIMIT 1"
      )
    )!;
    const customer = (
      await queryOne<{ id: number }>(
        "SELECT id FROM users WHERE role = 'customer' ORDER BY id LIMIT 1"
      )
    )!;
    const { requestId } = await createRequest({
      medicineId: medicine.id,
      qty: 1,
      customerId: customer.id,
      customerName: "Delivery Expiry",
      fulfilmentType: "delivery",
      deliveryAddress: "221B Baker Street, Bengaluru",
      deliveryLat: 12.9716,
      deliveryLng: 77.5946,
    });

    const delivery = (await createDeliveryForRequest(requestId))!;
    // Expire the stock at the pharmacy that is actually fulfilling this order,
    // which is chosen by ranking and is not necessarily the first one.
    await queryRun(
      "UPDATE inventory SET expiry_date = (CURRENT_DATE - 1)::text WHERE pharmacy_id = $1 AND medicine_id = $2",
      [delivery.pharmacy_id, medicine.id]
    );

    await queryRun(
      "UPDATE deliveries SET status = 'ArrivedAtDestination', partner_id = $1 WHERE id = $2",
      [partner.id, delivery.id]
    );

    // The expiry check runs before the OTP is compared, so any code is refused
    // for the right reason rather than being told the OTP was wrong.
    const result = await verifyHandover({
      deliveryId: delivery.id,
      userId: partner.id,
      otp: "000000",
      idChecked: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expired/i);
    expect(result.reason).toMatch(/take it back/i);
  });
});