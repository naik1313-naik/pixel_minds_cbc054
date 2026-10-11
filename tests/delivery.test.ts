import { describe, it, expect, beforeEach } from "vitest";
import { resetDemo, queryOne, queryAll } from "@/lib/db";
import { createRequest, getRequestDetail, confirmRequest, markReady, verifyRx, getMedicine } from "@/lib/engine";
import {
  getDelivery,
  acceptOffer,
  declineOffer,
  approveAssignment,
  rejectAssignment,
  transitionDelivery,
  recordLocation,
  verifyHandover,
  getDemoOtp,
  pendingOffersForPartner,
  lastKnownLocation,
} from "@/lib/delivery";
import { DELIVERY_STATUS, REQUEST_STATUS } from "@/lib/constants";

async function partnerByRatingRank(rank: number) {
  return (
    await queryAll<{ id: number; rating: number }>(
      "SELECT id, rating FROM users WHERE role='delivery_partner' AND partner_status='verified' AND partner_online=1 ORDER BY rating DESC"
    )
  )[rank];
}

async function setupDelivery(medicineId = 1, qty = 2) {
  const { requestId } = await createRequest({
    medicineId,
    qty,
    customerId: null,
    customerName: "Deliver Test",
    fulfilmentType: "delivery",
    deliveryAddress: "12, 100ft Road, Indiranagar",
    deliveryLat: 12.9721,
    deliveryLng: 77.6401,
  });
  const detail = (await getRequestDetail(requestId))!;
  const pharmacyId = detail.request.preferred_pharmacy_id!;
  const owner = (await queryOne<{ id: number; role: string }>(
    "SELECT id, role FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
    [pharmacyId]
  ))!;
  if ((await getMedicine(medicineId))!.rx_required) {
    await verifyRx(requestId, { userId: owner.id, role: owner.role });
  }
  await confirmRequest(requestId, { userId: owner.id, role: owner.role });
  const ready = await markReady(requestId, { userId: owner.id, role: owner.role });
  return { requestId, deliveryId: ready.deliveryId!, pharmacyId };
}

// Accepts the offer for a rider then has the owning pharmacy approve it,
// moving the delivery to Assigned (the pre-approval flow requires both steps).
async function assignRider(deliveryId: number, pharmacyId: number, partnerId: number) {
  expect((await acceptOffer(deliveryId, partnerId)).ok).toBe(true);
  const owner = (await queryOne<{ id: number }>(
    "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
    [pharmacyId]
  ))!;
  expect(
    (await approveAssignment(deliveryId, { userId: owner.id, role: "pharmacy_owner", pharmacyId })).ok
  ).toBe(true);
}

describe("delivery assignment", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("offers the job to the highest-rated available partner", async () => {
    const { deliveryId } = await setupDelivery();
    const top = await partnerByRatingRank(0);
    const offers = await pendingOffersForPartner(top.id);
    expect(offers.some((o) => o.id === deliveryId)).toBe(true);
    expect((await getDelivery(deliveryId))!.status).toBe(DELIVERY_STATUS.SEARCHING);
  });

  it("lets exactly one partner win a job", async () => {
    const { deliveryId, pharmacyId } = await setupDelivery();
    const winner = await partnerByRatingRank(0);
    const loser = await partnerByRatingRank(1);
    // loser was never offered, so cannot accept
    expect((await acceptOffer(deliveryId, loser.id)).ok).toBe(false);
    expect((await acceptOffer(deliveryId, winner.id)).ok).toBe(true);
    // second accept fails
    expect((await acceptOffer(deliveryId, winner.id)).ok).toBe(false);
    // accepted offer now waits for pharmacy approval (not yet Assigned)
    expect((await getDelivery(deliveryId))!.status).toBe(DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL);
    expect((await getDelivery(deliveryId))!.partner_id).toBe(winner.id);
    const owner = (await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
      [pharmacyId]
    ))!;
    expect(
      (await approveAssignment(deliveryId, { userId: owner.id, role: "pharmacy_owner", pharmacyId })).ok
    ).toBe(true);
    expect((await getDelivery(deliveryId))!.status).toBe(DELIVERY_STATUS.ASSIGNED);
  });

  it("only the owning pharmacy can approve the rider", async () => {
    const { deliveryId } = await setupDelivery();
    const winner = await partnerByRatingRank(0);
    expect((await acceptOffer(deliveryId, winner.id)).ok).toBe(true);
    expect(
      (await approveAssignment(deliveryId, { userId: 999, role: "pharmacy_owner", pharmacyId: 999 })).ok
    ).toBe(false);
    expect((await getDelivery(deliveryId))!.status).toBe(DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL);
  });

  it("rejecting clears the partner and re-offers the job", async () => {
    const { deliveryId, pharmacyId } = await setupDelivery();
    const winner = await partnerByRatingRank(0);
    expect((await acceptOffer(deliveryId, winner.id)).ok).toBe(true);
    const owner = (await queryOne<{ id: number }>(
      "SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = $1",
      [pharmacyId]
    ))!;
    expect(
      (await rejectAssignment(deliveryId, { userId: owner.id, role: "pharmacy_owner", pharmacyId })).ok
    ).toBe(true);
    const d = (await getDelivery(deliveryId))!;
    expect(d.status).toBe(DELIVERY_STATUS.SEARCHING);
    expect(d.partner_id).toBeNull();
    // the rejected rider must not be offered the same job again
    expect((await pendingOffersForPartner(winner.id)).some((o) => o.id === deliveryId)).toBe(false);
  });

  it("reassigns to the next partner after a decline", async () => {
    const { deliveryId } = await setupDelivery();
    const first = await partnerByRatingRank(0);
    const second = await partnerByRatingRank(1);
    await declineOffer(deliveryId, first.id);
    expect((await pendingOffersForPartner(second.id)).some((o) => o.id === deliveryId)).toBe(true);
  });
});

describe("delivery lifecycle + handover", () => {
  beforeEach(async () => {
    await resetDemo();
  });

  it("runs the full path to delivery with OTP handover", async () => {
    const { requestId, deliveryId, pharmacyId } = await setupDelivery();
    const rider = await partnerByRatingRank(0);
    await assignRider(deliveryId, pharmacyId, rider.id);
    const actor = { userId: rider.id, role: "delivery_partner" };
    expect((await transitionDelivery(deliveryId, DELIVERY_STATUS.ARRIVED_PHARMACY, actor)).ok).toBe(true);
    expect((await transitionDelivery(deliveryId, DELIVERY_STATUS.PICKED_UP, actor)).ok).toBe(true);
    expect((await transitionDelivery(deliveryId, DELIVERY_STATUS.OUT_FOR_DELIVERY, actor)).ok).toBe(true);

    // location accepted for the assigned rider
    expect(
      (await recordLocation({ deliveryId, userId: rider.id, lat: 12.971, lng: 77.641, heading: 10 })).ok
    ).toBe(true);
    expect(await lastKnownLocation(deliveryId)).toBeTruthy();

    expect((await transitionDelivery(deliveryId, DELIVERY_STATUS.ARRIVED_DESTINATION, actor)).ok).toBe(true);
    const otp = await getDemoOtp(deliveryId, null);
    expect(otp).toMatch(/^\d{4}$/);

    // wrong OTP fails
    expect((await verifyHandover({ deliveryId, userId: rider.id, otp: "0000", idChecked: false })).ok).toBe(false);
    const okRes = await verifyHandover({ deliveryId, userId: rider.id, otp: otp!, idChecked: false });
    expect(okRes.ok).toBe(true);
    expect((await getDelivery(deliveryId))!.status).toBe(DELIVERY_STATUS.DELIVERED);
    expect((await getRequestDetail(requestId))!.request.status).toBe(REQUEST_STATUS.COMPLETED);
  });

  it("rejects location from a rider who does not own the delivery", async () => {
    const { deliveryId, pharmacyId } = await setupDelivery();
    const rider = await partnerByRatingRank(0);
    const other = await partnerByRatingRank(1);
    await assignRider(deliveryId, pharmacyId, rider.id);
    expect((await recordLocation({ deliveryId, userId: other.id, lat: 12.97, lng: 77.64 })).ok).toBe(false);
  });

  it("rejects an illegal state transition", async () => {
    const { deliveryId, pharmacyId } = await setupDelivery();
    const rider = await partnerByRatingRank(0);
    await assignRider(deliveryId, pharmacyId, rider.id);
    // cannot jump straight to PickedUp
    const res = await transitionDelivery(deliveryId, DELIVERY_STATUS.PICKED_UP, {
      userId: rider.id,
      role: "delivery_partner",
    });
    expect(res.ok).toBe(false);
  });

  it("requires recipient ID check for prescription deliveries", async () => {
    const { deliveryId, pharmacyId } = await setupDelivery(9, 1); // Amoxicillin, rx
    const rider = await partnerByRatingRank(0);
    expect((await getDelivery(deliveryId))!.rx_required).toBe(1);
    await assignRider(deliveryId, pharmacyId, rider.id);
    const actor = { userId: rider.id, role: "delivery_partner" };
    await transitionDelivery(deliveryId, DELIVERY_STATUS.ARRIVED_PHARMACY, actor);
    await transitionDelivery(deliveryId, DELIVERY_STATUS.PICKED_UP, actor);
    await transitionDelivery(deliveryId, DELIVERY_STATUS.OUT_FOR_DELIVERY, actor);
    await transitionDelivery(deliveryId, DELIVERY_STATUS.ARRIVED_DESTINATION, actor);
    const otp = (await getDemoOtp(deliveryId, null))!;
    // Without ID check the handover must be refused.
    expect((await verifyHandover({ deliveryId, userId: rider.id, otp, idChecked: false })).ok).toBe(false);
    expect((await verifyHandover({ deliveryId, userId: rider.id, otp, idChecked: true })).ok).toBe(true);
  });
});
