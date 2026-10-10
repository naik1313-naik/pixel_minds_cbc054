import { describe, it, expect, beforeEach } from "vitest";
import { getDb, resetDemo } from "@/lib/db";
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

function partnerByRatingRank(rank: number) {
  return (
    getDb()
      .prepare(
        "SELECT id, rating FROM users WHERE role='delivery_partner' AND partner_status='verified' AND partner_online=1 ORDER BY rating DESC"
      )
      .all() as { id: number; rating: number }[]
  )[rank];
}

function setupDelivery(medicineId = 1, qty = 2) {
  const { requestId } = createRequest({
    medicineId,
    qty,
    customerId: null,
    customerName: "Deliver Test",
    fulfilmentType: "delivery",
    deliveryAddress: "12, 100ft Road, Indiranagar",
    deliveryLat: 12.9721,
    deliveryLng: 77.6401,
  });
  const detail = getRequestDetail(requestId)!;
  const pharmacyId = detail.request.preferred_pharmacy_id!;
  const owner = getDb()
    .prepare("SELECT id, role FROM users WHERE role='pharmacy_owner' AND pharmacy_id = ?")
    .get(pharmacyId) as { id: number; role: string };
  if (getMedicine(medicineId)!.rx_required) {
    verifyRx(requestId, { userId: owner.id, role: owner.role });
  }
  confirmRequest(requestId, { userId: owner.id, role: owner.role });
  const ready = markReady(requestId, { userId: owner.id, role: owner.role });
  return { requestId, deliveryId: ready.deliveryId!, pharmacyId };
}

// Accepts the offer for a rider then has the owning pharmacy approve it,
// moving the delivery to Assigned (the pre-approval flow requires both steps).
function assignRider(deliveryId: number, pharmacyId: number, partnerId: number) {
  expect(acceptOffer(deliveryId, partnerId).ok).toBe(true);
  const owner = getDb()
    .prepare("SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = ?")
    .get(pharmacyId) as { id: number };
  expect(
    approveAssignment(deliveryId, { userId: owner.id, role: "pharmacy_owner", pharmacyId }).ok
  ).toBe(true);
}

describe("delivery assignment", () => {
  beforeEach(() => resetDemo());

  it("offers the job to the highest-rated available partner", () => {
    const { deliveryId } = setupDelivery();
    const top = partnerByRatingRank(0);
    const offers = pendingOffersForPartner(top.id);
    expect(offers.some((o) => o.id === deliveryId)).toBe(true);
    expect(getDelivery(deliveryId)!.status).toBe(DELIVERY_STATUS.SEARCHING);
  });

  it("lets exactly one partner win a job", () => {
    const { deliveryId, pharmacyId } = setupDelivery();
    const winner = partnerByRatingRank(0);
    const loser = partnerByRatingRank(1);
    // loser was never offered, so cannot accept
    expect(acceptOffer(deliveryId, loser.id).ok).toBe(false);
    expect(acceptOffer(deliveryId, winner.id).ok).toBe(true);
    // second accept fails
    expect(acceptOffer(deliveryId, winner.id).ok).toBe(false);
    // accepted offer now waits for pharmacy approval (not yet Assigned)
    expect(getDelivery(deliveryId)!.status).toBe(DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL);
    expect(getDelivery(deliveryId)!.partner_id).toBe(winner.id);
    const owner = getDb()
      .prepare("SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = ?")
      .get(pharmacyId) as { id: number };
    expect(
      approveAssignment(deliveryId, { userId: owner.id, role: "pharmacy_owner", pharmacyId }).ok
    ).toBe(true);
    expect(getDelivery(deliveryId)!.status).toBe(DELIVERY_STATUS.ASSIGNED);
  });

  it("only the owning pharmacy can approve the rider", () => {
    const { deliveryId } = setupDelivery();
    const winner = partnerByRatingRank(0);
    expect(acceptOffer(deliveryId, winner.id).ok).toBe(true);
    expect(
      approveAssignment(deliveryId, { userId: 999, role: "pharmacy_owner", pharmacyId: 999 }).ok
    ).toBe(false);
    expect(getDelivery(deliveryId)!.status).toBe(DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL);
  });

  it("rejecting clears the partner and re-offers the job", () => {
    const { deliveryId, pharmacyId } = setupDelivery();
    const winner = partnerByRatingRank(0);
    expect(acceptOffer(deliveryId, winner.id).ok).toBe(true);
    const owner = getDb()
      .prepare("SELECT id FROM users WHERE role='pharmacy_owner' AND pharmacy_id = ?")
      .get(pharmacyId) as { id: number };
    expect(
      rejectAssignment(deliveryId, { userId: owner.id, role: "pharmacy_owner", pharmacyId }).ok
    ).toBe(true);
    const d = getDelivery(deliveryId)!;
    expect(d.status).toBe(DELIVERY_STATUS.SEARCHING);
    expect(d.partner_id).toBeNull();
    // the rejected rider must not be offered the same job again
    expect(pendingOffersForPartner(winner.id).some((o) => o.id === deliveryId)).toBe(false);
  });

  it("reassigns to the next partner after a decline", () => {
    const { deliveryId } = setupDelivery();
    const first = partnerByRatingRank(0);
    const second = partnerByRatingRank(1);
    declineOffer(deliveryId, first.id);
    expect(pendingOffersForPartner(second.id).some((o) => o.id === deliveryId)).toBe(true);
  });
});

describe("delivery lifecycle + handover", () => {
  beforeEach(() => resetDemo());

  it("runs the full path to delivery with OTP handover", () => {
    const { requestId, deliveryId, pharmacyId } = setupDelivery();
    const rider = partnerByRatingRank(0);
    assignRider(deliveryId, pharmacyId, rider.id);
    const actor = { userId: rider.id, role: "delivery_partner" };
    expect(transitionDelivery(deliveryId, DELIVERY_STATUS.ARRIVED_PHARMACY, actor).ok).toBe(true);
    expect(transitionDelivery(deliveryId, DELIVERY_STATUS.PICKED_UP, actor).ok).toBe(true);
    expect(transitionDelivery(deliveryId, DELIVERY_STATUS.OUT_FOR_DELIVERY, actor).ok).toBe(true);

    // location accepted for the assigned rider
    expect(
      recordLocation({ deliveryId, userId: rider.id, lat: 12.971, lng: 77.641, heading: 10 }).ok
    ).toBe(true);
    expect(lastKnownLocation(deliveryId)).toBeTruthy();

    expect(transitionDelivery(deliveryId, DELIVERY_STATUS.ARRIVED_DESTINATION, actor).ok).toBe(true);
    const otp = getDemoOtp(deliveryId, null);
    expect(otp).toMatch(/^\d{4}$/);

    // wrong OTP fails
    expect(verifyHandover({ deliveryId, userId: rider.id, otp: "0000", idChecked: false }).ok).toBe(false);
    const okRes = verifyHandover({ deliveryId, userId: rider.id, otp: otp!, idChecked: false });
    expect(okRes.ok).toBe(true);
    expect(getDelivery(deliveryId)!.status).toBe(DELIVERY_STATUS.DELIVERED);
    expect(getRequestDetail(requestId)!.request.status).toBe(REQUEST_STATUS.COMPLETED);
  });

  it("rejects location from a rider who does not own the delivery", () => {
    const { deliveryId, pharmacyId } = setupDelivery();
    const rider = partnerByRatingRank(0);
    const other = partnerByRatingRank(1);
    assignRider(deliveryId, pharmacyId, rider.id);
    expect(recordLocation({ deliveryId, userId: other.id, lat: 12.97, lng: 77.64 }).ok).toBe(false);
  });

  it("rejects an illegal state transition", () => {
    const { deliveryId, pharmacyId } = setupDelivery();
    const rider = partnerByRatingRank(0);
    assignRider(deliveryId, pharmacyId, rider.id);
    // cannot jump straight to PickedUp
    const res = transitionDelivery(deliveryId, DELIVERY_STATUS.PICKED_UP, {
      userId: rider.id,
      role: "delivery_partner",
    });
    expect(res.ok).toBe(false);
  });

  it("requires recipient ID check for prescription deliveries", () => {
    const { deliveryId, pharmacyId } = setupDelivery(9, 1); // Amoxicillin, rx
    const rider = partnerByRatingRank(0);
    expect(getDelivery(deliveryId)!.rx_required).toBe(1);
    assignRider(deliveryId, pharmacyId, rider.id);
    const actor = { userId: rider.id, role: "delivery_partner" };
    transitionDelivery(deliveryId, DELIVERY_STATUS.ARRIVED_PHARMACY, actor);
    transitionDelivery(deliveryId, DELIVERY_STATUS.PICKED_UP, actor);
    transitionDelivery(deliveryId, DELIVERY_STATUS.OUT_FOR_DELIVERY, actor);
    transitionDelivery(deliveryId, DELIVERY_STATUS.ARRIVED_DESTINATION, actor);
    const otp = getDemoOtp(deliveryId, null)!;
    // Without ID check the handover must be refused.
    expect(verifyHandover({ deliveryId, userId: rider.id, otp, idChecked: false }).ok).toBe(false);
    expect(verifyHandover({ deliveryId, userId: rider.id, otp, idChecked: true }).ok).toBe(true);
  });
});
