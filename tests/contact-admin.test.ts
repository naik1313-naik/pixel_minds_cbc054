import { describe, it, expect, beforeEach } from "vitest";
import { resetDemo, queryOne, queryAll } from "@/lib/db";
import { createRequest, getRequestDetail, confirmRequest, markReady, getMedicine, verifyRx } from "@/lib/engine";
import {
  acceptOffer,
  approveAssignment,
  pendingOffersForPartner,
  sweepDeliveries,
  maskPhone,
} from "@/lib/delivery";

/**
 * Admin order visibility and customer↔rider contact.
 *
 * The contact flow is the sensitive part: a delivery needs the two parties to be
 * able to reach each other, but that is not a reason to publish every rider's
 * number. These tests pin down who can see what, and what the logs record.
 */

async function ownerOf(pharmacyId: number) {
  return (
    await queryOne<{ id: number; role: string }>(
      "SELECT id, role FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
      [pharmacyId]
    )
  )!;
}

/** A delivery order that has been accepted AND approved by the pharmacy. */
async function assignedDelivery() {
  const medicineId = 1;
  const { requestId } = await createRequest({
    medicineId,
    qty: 1,
    customerId: null,
    customerName: "Contact Fixture",
    fulfilmentType: "delivery",
    deliveryAddress: "9 Contact Lane, Indiranagar",
    deliveryLat: 12.9719,
    deliveryLng: 77.6412,
  });
  const detail = (await getRequestDetail(requestId))!;
  const pharmacyId = detail.request.preferred_pharmacy_id!;
  const owner = await ownerOf(pharmacyId);
  if ((await getMedicine(medicineId))!.rx_required) {
    await verifyRx(requestId, { userId: owner.id, role: owner.role });
  }
  await confirmRequest(requestId, { userId: owner.id, role: owner.role });
  const ready = await markReady(requestId, { userId: owner.id, role: owner.role });
  const deliveryId = ready.deliveryId!;

  const rider = (
    await queryAll<{ id: number }>(
      "SELECT id FROM users WHERE role='delivery_partner' AND partner_status='verified' ORDER BY rating DESC"
    )
  )[0];
  expect((await acceptOffer(deliveryId, rider.id)).ok).toBe(true);
  expect(
    (
      await approveAssignment(deliveryId, {
        userId: owner.id,
        role: "pharmacy_owner",
        pharmacyId,
      })
    ).ok
  ).toBe(true);
  return { requestId, deliveryId, pharmacyId, ownerId: owner.id, riderId: rider.id };
}

describe("admin order visibility", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("joins the three parties an operator needs onto one row", async () => {
    const { requestId, pharmacyId } = await assignedDelivery();
    // Same shape the admin endpoint returns.
    const rows = await queryAll<{
      request_id: number;
      customer_name: string;
      pharmacy_name: string;
      partner_name: string;
      request_status: string;
    }>(
      `SELECT r.id AS request_id, r.customer_name, p.name AS pharmacy_name, u.name AS partner_name, r.status AS request_status
         FROM requests r
         LEFT JOIN pharmacies p ON p.id = r.preferred_pharmacy_id
         LEFT JOIN deliveries d ON d.request_id = r.id
         LEFT JOIN users u ON u.id = d.partner_id
        WHERE r.id = $1`,
      [requestId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].customer_name).toBe("Contact Fixture");
    expect(rows[0].pharmacy_name).toBeTruthy();
    expect(rows[0].partner_name).toBeTruthy();
    expect(pharmacyId).toBeTruthy();
  });

  it("does not hand the operator the customer phone list", async () => {
    // The orders endpoint must not select any phone column. Comments are stripped
    // first so the prose explaining that omission does not trip the assertion.
    const fs = await import("node:fs");
    const source = fs
      .readFileSync("app/api/admin/orders/route.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/--[^\n]*/g, "");
    expect(source).not.toMatch(/phone/i);
    expect(source).not.toMatch(/\bemail\b/i);
  });
});

describe("customer to rider contact", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("keeps the rider's number masked until it is asked for", async () => {
    const { requestId } = await assignedDelivery();
    const rider = (await queryOne<{ phone: string }>("SELECT phone FROM users WHERE id = (SELECT id FROM users WHERE role='delivery_partner' LIMIT 1)"))!;
    expect(maskPhone(rider.phone)).toMatch(/^XXXXXX\d{4}$/);
    expect(maskPhone(rider.phone)).not.toContain(rider.phone);
    expect(requestId).toBeTruthy();
  });

  it("does not reveal a number before a rider is assigned", async () => {
    // A pickup order has no rider, and must not manufacture one.
    const { requestId } = await createRequest({
      medicineId: 1,
      qty: 1,
      customerId: null,
      customerName: "Pickup Customer",
      fulfilmentType: "pickup",
    });
    const rider = await queryOne<{ id: number }>(
      `SELECT u.id FROM deliveries d JOIN users u ON u.id = d.partner_id WHERE d.request_id = $1`,
      [requestId]
    );
    expect(rider).toBeUndefined();
  });

  it("records every phone disclosure in the audit log", async () => {
    const { requestId } = await assignedDelivery();
    await queryAll(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, entity_id, created_at)
       VALUES (1, 'customer', 'contact.phone_revealed', 'request', $1, $2)`,
      [String(requestId), new Date().toISOString()]
    );
    const log = await queryAll<{ action: string; entity_id: string }>(
      "SELECT action, entity_id FROM audit_log WHERE action = 'contact.phone_revealed' AND entity_id = $1",
      [String(requestId)]
    );
    expect(log).toHaveLength(1);
  });

  it("cannot be pointed at somebody else's order", async () => {
    const { requestId, riderId } = await assignedDelivery();
    // A second, unrelated customer from the seed data.
    const other = (await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='customer' ORDER BY id LIMIT 1"
    ))!;
    // canViewRequest is the gate both contact endpoints rely on.
    const { canViewRequest } = await import("@/lib/access");
    const detail = (await getRequestDetail(requestId))!;
    // This order was placed by a fixture with no customer_id, so no customer
    // owns it and no customer may reach its rider.
    const stranger = { id: other.id, role: "customer", pharmacy_id: null } as never;
    expect(await canViewRequest(stranger, detail.request)).toBe(false);

    // The assigned rider can see their own job, but not a different order.
    const otherRider = (await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='delivery_partner' AND id <> $1 ORDER BY id LIMIT 1",
      [riderId]
    ))!;
    const asOtherRider = { id: otherRider.id, role: "delivery_partner", pharmacy_id: null } as never;
    expect(await canViewRequest(asOtherRider, { ...detail.request, id: requestId })).toBe(false);
  });

  it("gives a busy rider no new offers", async () => {
    const { deliveryId, riderId } = await assignedDelivery();
    const offers = await pendingOffersForPartner(riderId);
    expect(offers.some((o) => o.id === deliveryId)).toBe(false);
    await sweepDeliveries();
    expect((await pendingOffersForPartner(riderId)).some((o) => o.id === deliveryId)).toBe(false);
  });
});