import { getDb, nowIso, getSetting } from "./db";
import {
  DELIVERY_STATUS,
  DELIVERY_TRANSITIONS,
  TRACKABLE_DELIVERY_STATUSES,
  GEOFENCE_METERS,
} from "./constants";
import { haversineKm, roadDistanceKm, etaMinutes, headingDeg, interpolate } from "./geo";
import { randomDigits, sha256Hex, timingSafeEqual, encryptSecret, decryptSecret } from "./crypto";
import { recordAudit } from "./audit";
import { publish, channels } from "./sse";
import { getSmsProvider } from "./providers";

const OFFER_WINDOW_SECONDS = 30;
const OTP_TTL_MINUTES = 30;
const OTP_MAX_ATTEMPTS = 5;
const MIN_LOCATION_INTERVAL_MS = 1200;
const MAX_SPEED_MPS = 45; // ~160 km/h teleport guard

export function isDemoMode(): boolean {
  const v = process.env.DEMO_MODE;
  return v === "1" || v === "true" || process.env.NODE_ENV !== "production";
}

interface Delivery {
  id: number;
  request_id: number;
  pharmacy_id: number;
  partner_id: number | null;
  status: string;
  destination_address: string;
  destination_lat: number;
  destination_lng: number;
  rx_required: number;
  distance_km: number | null;
  eta_minutes: number | null;
  otp_hash: string | null;
  otp_expires_at: string | null;
  otp_attempts: number;
  id_checked: number;
  proof_json: string | null;
  delivered_at: string | null;
  created_at: string;
}

export function getDelivery(id: number): Delivery | undefined {
  return getDb().prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as
    | Delivery
    | undefined;
}

export function getDeliveryForRequest(requestId: number): Delivery | undefined {
  return getDb()
    .prepare("SELECT * FROM deliveries WHERE request_id = ?")
    .get(requestId) as Delivery | undefined;
}

// ---------------------------------------------------------------- create

export function createDeliveryForRequest(requestId: number): Delivery | null {
  const db = getDb();
  const req = db
    .prepare("SELECT * FROM requests WHERE id = ?")
    .get(requestId) as
    | {
        id: number;
        medicine_id: number;
        preferred_pharmacy_id: number;
        fulfilment_type: string;
        delivery_address: string;
        delivery_lat: number;
        delivery_lng: number;
      }
    | undefined;
  if (!req || req.fulfilment_type !== "delivery") return null;
  if (getDeliveryForRequest(requestId)) return getDeliveryForRequest(requestId)!;

  const pharmacy = db
    .prepare("SELECT lat, lng FROM pharmacies WHERE id = ?")
    .get(req.preferred_pharmacy_id) as { lat: number; lng: number };
  const med = db
    .prepare("SELECT rx_required FROM medicines WHERE id = ?")
    .get(req.medicine_id) as { rx_required: number };

  const dist = roadDistanceKm(pharmacy, { lat: req.delivery_lat, lng: req.delivery_lng });
  const eta = etaMinutes(dist);
  const info = db
    .prepare(
      `INSERT INTO deliveries (request_id, pharmacy_id, partner_id, status, destination_address,
         destination_lat, destination_lng, rx_required, distance_km, eta_minutes, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      requestId,
      req.preferred_pharmacy_id,
      DELIVERY_STATUS.SEARCHING,
      req.delivery_address,
      req.delivery_lat,
      req.delivery_lng,
      med.rx_required,
      dist,
      eta,
      nowIso()
    );
  const id = Number(info.lastInsertRowid);
  publishDelivery(id, requestId, DELIVERY_STATUS.SEARCHING);
  offerNextPartner(id);
  return getDelivery(id)!;
}

// -------------------------------------------------------------- assignment

// Verified, online partners with no active delivery that haven't been offered this job.
function candidatePartners(deliveryId: number) {
  const db = getDb();
  return db
    .prepare(
      `SELECT u.id, u.name, u.rating
       FROM users u
       WHERE u.role = 'delivery_partner'
         AND u.partner_status = 'verified'
         AND u.partner_online = 1
         AND NOT EXISTS (
           SELECT 1 FROM deliveries d
           WHERE d.partner_id = u.id
             AND d.status IN ('AwaitingPharmacyApproval','Assigned','ArrivedAtPharmacy','PickedUp','OutForDelivery','ArrivedAtDestination')
         )
         AND NOT EXISTS (
           SELECT 1 FROM delivery_offers o
           WHERE o.delivery_id = ? AND o.partner_id = u.id
         )
       ORDER BY u.rating DESC`
    )
    .all(deliveryId) as { id: number; name: string; rating: number }[];
}

// Offers the job to the next best partner. No-op if a partner is already assigned.
export function offerNextPartner(deliveryId: number): { offered: boolean; partnerId?: number } {
  const db = getDb();
  const d = getDelivery(deliveryId);
  if (!d || d.status !== DELIVERY_STATUS.SEARCHING || d.partner_id) return { offered: false };
  const candidates = candidatePartners(deliveryId);
  if (!candidates.length) return { offered: false };
  const partner = candidates[0];
  const now = Date.now();
  db.prepare(
    `INSERT INTO delivery_offers (delivery_id, partner_id, status, offered_at, expires_at)
     VALUES (?, ?, 'offered', ?, ?)`
  ).run(
    deliveryId,
    partner.id,
    new Date(now).toISOString(),
    new Date(now + OFFER_WINDOW_SECONDS * 1000).toISOString()
  );
  const dl = d;
  const pharmacy = db
    .prepare("SELECT name, lat, lng FROM pharmacies WHERE id = ?")
    .get(dl.pharmacy_id) as { name: string; lat: number; lng: number };
  publish(channels.delivery(deliveryId), {
    type: "delivery",
    deliveryId,
    requestId: dl.request_id,
    status: "OfferSent",
  });
  publish(`partner:${partner.id}`, {
    type: "delivery",
    deliveryId,
    requestId: dl.request_id,
    status: "OfferSent",
  });
  void pharmacy;
  return { offered: true, partnerId: partner.id };
}

// Concurrency-safe accept: only one partner can win.
export function acceptOffer(deliveryId: number, userId: number): { ok: boolean; reason?: string } {
  const db = getDb();
  const tx = db.transaction(() => {
    const offer = db
      .prepare(
        "SELECT * FROM delivery_offers WHERE delivery_id = ? AND partner_id = ? AND status = 'offered'"
      )
      .get(deliveryId, userId) as { id: number; expires_at: string } | undefined;
    if (!offer) return { ok: false, reason: "No active offer" };
    if (new Date(offer.expires_at).getTime() < Date.now())
      return { ok: false, reason: "Offer expired" };

    const upd = db
      .prepare(
        `UPDATE deliveries SET partner_id = ?, status = 'AwaitingPharmacyApproval', accepted_at = ?
         WHERE id = ? AND status = 'SearchingPartner' AND partner_id IS NULL`
      )
      .run(userId, nowIso(), deliveryId);
    if (upd.changes !== 1) return { ok: false, reason: "Already assigned" };

    db.prepare("UPDATE delivery_offers SET status = 'accepted' WHERE id = ?").run(offer.id);
    db.prepare(
      "UPDATE delivery_offers SET status = 'superseded' WHERE delivery_id = ? AND id != ?"
    ).run(deliveryId, offer.id);
    recordAudit({ actorUserId: userId, actorRole: "delivery_partner", action: "delivery.accept", entityType: "delivery", entityId: deliveryId });
    return { ok: true };
  });
  const res = tx();
  if (res.ok) {
    const d = getDelivery(deliveryId)!;
    publishDelivery(deliveryId, d.request_id, DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL);
    publish(`partner:${userId}`, { type: "delivery", deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL });
  }
  return res;
}

// Pharmacy approves the rider who accepted the offer, promoting the delivery
// from AwaitingPharmacyApproval to Assigned.
export function approveAssignment(
  deliveryId: number,
  actor: { userId: number; role: string; pharmacyId: number | null }
): { ok: boolean; reason?: string; status?: number } {
  const db = getDb();
  const tx = db.transaction(() => {
    const d = getDelivery(deliveryId);
    if (!d) return { ok: false, reason: "Delivery not found", status: 404 };
    if (actor.role !== "admin" && actor.pharmacyId != null && d.pharmacy_id !== actor.pharmacyId)
      return { ok: false, reason: "Not your pharmacy", status: 403 };
    if (d.status !== DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL)
      return { ok: false, reason: `Cannot approve when status is ${d.status}`, status: 409 };
    if (!d.partner_id) return { ok: false, reason: "No partner assigned", status: 409 };
    const upd = db
      .prepare(
        `UPDATE deliveries SET status = 'Assigned', assigned_at = ? WHERE id = ? AND status = 'AwaitingPharmacyApproval'`
      )
      .run(nowIso(), deliveryId);
    if (upd.changes !== 1) return { ok: false, reason: "Already processed", status: 409 };
    recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "delivery.approve_assignment", entityType: "delivery", entityId: deliveryId, meta: { partner_id: d.partner_id } });
    return { ok: true };
  });
  const res = tx();
  if (res.ok) {
    const d = getDelivery(deliveryId)!;
    publishDelivery(deliveryId, d.request_id, DELIVERY_STATUS.ASSIGNED);
    publish(`partner:${d.partner_id}`, { type: "delivery", deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.ASSIGNED });
    publish(channels.pharmacy(d.pharmacy_id), { type: "delivery", deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.ASSIGNED });
  }
  return res;
}

// Pharmacy rejects the accepted rider: clears the partner, re-offers the job.
export function rejectAssignment(
  deliveryId: number,
  actor: { userId: number; role: string; pharmacyId: number | null }
): { ok: boolean; reason?: string; status?: number } {
  const db = getDb();
  let rejectedPartner: number | null = null;
  const tx = db.transaction(() => {
    const d = getDelivery(deliveryId);
    if (!d) return { ok: false, reason: "Delivery not found", status: 404 };
    if (actor.role !== "admin" && actor.pharmacyId != null && d.pharmacy_id !== actor.pharmacyId)
      return { ok: false, reason: "Not your pharmacy", status: 403 };
    if (d.status !== DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL)
      return { ok: false, reason: `Cannot reject when status is ${d.status}`, status: 409 };
    rejectedPartner = d.partner_id;
    const upd = db
      .prepare(
        `UPDATE deliveries SET partner_id = NULL, status = 'SearchingPartner' WHERE id = ? AND status = 'AwaitingPharmacyApproval'`
      )
      .run(deliveryId);
    if (upd.changes !== 1) return { ok: false, reason: "Already processed", status: 409 };
    if (rejectedPartner) {
      db.prepare(
        "UPDATE delivery_offers SET status = 'rejected' WHERE delivery_id = ? AND partner_id = ? AND status = 'accepted'"
      ).run(deliveryId, rejectedPartner);
    }
    recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "delivery.reject_assignment", entityType: "delivery", entityId: deliveryId, meta: { partner_id: rejectedPartner } });
    return { ok: true };
  });
  const res = tx();
  if (res.ok) {
    const d = getDelivery(deliveryId)!;
    publishDelivery(deliveryId, d.request_id, DELIVERY_STATUS.SEARCHING);
    if (rejectedPartner) {
      publish(`partner:${rejectedPartner}`, { type: "delivery", deliveryId, requestId: d.request_id, status: "AssignmentRejected" });
    }
    publish(channels.pharmacy(d.pharmacy_id), { type: "delivery", deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.SEARCHING });
    offerNextPartner(deliveryId);
  }
  return res;
}

export function declineOffer(deliveryId: number, userId: number) {
  const db = getDb();
  db.prepare(
    "UPDATE delivery_offers SET status = 'declined' WHERE delivery_id = ? AND partner_id = ? AND status = 'offered'"
  ).run(deliveryId, userId);
  recordAudit({ actorUserId: userId, actorRole: "delivery_partner", action: "delivery.decline", entityType: "delivery", entityId: deliveryId });
  offerNextPartner(deliveryId);
}

// Sweep: expire timed-out offers and keep offering. Also purge retention.
export function sweepDeliveries(): void {
  const db = getDb();
  const now = nowIso();
  const expired = db
    .prepare(
      `SELECT o.delivery_id FROM delivery_offers o
       JOIN deliveries d ON d.id = o.delivery_id
       WHERE o.status = 'offered' AND o.expires_at < ? AND d.status = 'SearchingPartner'`
    )
    .all(now) as { delivery_id: number }[];
  for (const row of expired) {
    db.prepare(
      "UPDATE delivery_offers SET status = 'expired' WHERE delivery_id = ? AND status = 'offered'"
    ).run(row.delivery_id);
    offerNextPartner(row.delivery_id);
  }
  purgeOldLocations();
}

// ------------------------------------------------------------- state machine

export function transitionDelivery(
  deliveryId: number,
  to: string,
  actor: { userId: number; role: string }
): { ok: boolean; reason?: string } {
  const db = getDb();
  const tx = db.transaction(() => {
    const d = getDelivery(deliveryId);
    if (!d) return { ok: false, reason: "Delivery not found" };
    // Assignment is confirmed by the pharmacy, never self-assigned by the rider.
    if (to === DELIVERY_STATUS.ASSIGNED && actor.role === "delivery_partner") {
      return { ok: false, reason: "Assignment must be approved by the pharmacy" };
    }
    const allowed = DELIVERY_TRANSITIONS[d.status] || [];
    if (!allowed.includes(to)) {
      recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "delivery.illegal_transition", entityType: "delivery", entityId: deliveryId, meta: { from: d.status, to } });
      return { ok: false, reason: `Illegal transition ${d.status} → ${to}` };
    }
    const stamp: Record<string, string | null> = {};
    if (to === DELIVERY_STATUS.ASSIGNED) stamp.assigned_at = nowIso();
    if (to === DELIVERY_STATUS.PICKED_UP) stamp.picked_up_at = nowIso();
    if (to === DELIVERY_STATUS.DELIVERED) stamp.delivered_at = nowIso();

    if (to === DELIVERY_STATUS.ARRIVED_DESTINATION) {
      const otp = randomDigits(4);
      // Hashed for verification; an encrypted copy is kept ONLY in demo mode so
      // the customer screen can reveal it (production would deliver via SMS).
      const enc = isDemoMode() ? encryptSecret(otp) : null;
      db.prepare(
        `UPDATE deliveries SET status = ?, otp_hash = ?, otp_enc = ?, otp_expires_at = ?, otp_attempts = 0 WHERE id = ?`
      ).run(
        to,
        hashOtp(deliveryId, otp),
        enc,
        new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
        deliveryId
      );
      deliverOtpViaProvider(deliveryId, otp);
    } else {
      const sets = ["status = ?"];
      const vals: (string | number)[] = [to];
      if (stamp.assigned_at) {
        sets.push("assigned_at = ?");
        vals.push(stamp.assigned_at);
      }
      if (stamp.picked_up_at) {
        sets.push("picked_up_at = ?");
        vals.push(stamp.picked_up_at);
      }
      if (stamp.delivered_at) {
        sets.push("delivered_at = ?");
        vals.push(stamp.delivered_at);
      }
      vals.push(deliveryId);
      db.prepare(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    }
    recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: `delivery.${to}`, entityType: "delivery", entityId: deliveryId, meta: { from: d.status } });
    return { ok: true, requestId: d.request_id };
  });
  const res = tx();
  if (res.ok) {
    const d = getDelivery(deliveryId)!;
    publishDelivery(deliveryId, d.request_id, to);
  }
  return res;
}

// -------------------------------------------------------------- location

export function recordLocation(input: {
  deliveryId: number;
  userId: number;
  lat: number;
  lng: number;
  heading?: number | null;
  speed?: number | null;
}): { ok: boolean; reason?: string } {
  const db = getDb();
  const d = getDelivery(input.deliveryId);
  if (!d) return { ok: false, reason: "Delivery not found" };
  if (d.partner_id !== input.userId) return { ok: false, reason: "Not your delivery" };
  if (!TRACKABLE_DELIVERY_STATUSES.includes(d.status as never))
    return { ok: false, reason: "Location not accepted in this state" };
  if (
    typeof input.lat !== "number" ||
    typeof input.lng !== "number" ||
    input.lat < -90 ||
    input.lat > 90 ||
    input.lng < -180 ||
    input.lng > 180
  )
    return { ok: false, reason: "Invalid coordinates" };

  const last = db
    .prepare(
      "SELECT * FROM delivery_location WHERE delivery_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(input.deliveryId) as
    | { lat: number; lng: number; recorded_at: string }
    | undefined;

  // Rate limit (too frequent writes are dropped).
  if (last && Date.now() - new Date(last.recorded_at).getTime() < MIN_LOCATION_INTERVAL_MS) {
    return { ok: false, reason: "Rate limited" };
  }
  // Teleport / speed guard (skipped in demo simulator mode).
  if (last && !isDemoMode()) {
    const dtSec = Math.max(0.5, (Date.now() - new Date(last.recorded_at).getTime()) / 1000);
    const dist = haversineKm(last, { lat: input.lat, lng: input.lng }) * 1000;
    const mps = dist / dtSec;
    if (mps > MAX_SPEED_MPS) return { ok: false, reason: "Teleport detected" };
  }

  db.prepare(
    `INSERT INTO delivery_location (delivery_id, partner_id, lat, lng, heading, speed_mps, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.deliveryId,
    input.userId,
    input.lat,
    input.lng,
    input.heading ?? null,
    input.speed ?? null,
    nowIso()
  );
  publish(channels.delivery(input.deliveryId), {
    type: "location",
    deliveryId: input.deliveryId,
    lat: input.lat,
    lng: input.lng,
    heading: input.heading ?? null,
  });
  publish(channels.request(d.request_id), {
    type: "location",
    deliveryId: input.deliveryId,
    lat: input.lat,
    lng: input.lng,
    heading: input.heading ?? null,
  });
  return { ok: true };
}

export function lastKnownLocation(deliveryId: number) {
  return getDb()
    .prepare("SELECT * FROM delivery_location WHERE delivery_id = ? ORDER BY id DESC LIMIT 1")
    .get(deliveryId) as
    | { lat: number; lng: number; heading: number | null; recorded_at: string }
    | undefined;
}

export function getTrack(deliveryId: number, limit = 200) {
  return getDb()
    .prepare(
      "SELECT lat, lng, heading, recorded_at FROM delivery_location WHERE delivery_id = ? ORDER BY id ASC LIMIT ?"
    )
    .all(deliveryId, limit);
}

// --------------------------------------------------------------- OTP

function otpPepper(): string {
  return process.env.SESSION_PEPPER || "demo-pepper";
}
function hashOtp(deliveryId: number, otp: string): string {
  return sha256Hex(`${deliveryId}:${otp}:${otpPepper()}`);
}

function deliverOtpViaProvider(deliveryId: number, otp: string) {
  const db = getDb();
  const d = getDelivery(deliveryId);
  if (!d) return;
  const customer = db
    .prepare(
      "SELECT u.phone FROM requests r JOIN users u ON u.id = r.customer_id WHERE r.id = ?"
    )
    .get(d.request_id) as { phone: string | null } | undefined;
  if (customer?.phone) {
    getSmsProvider().send(customer.phone, `Your MediMesh delivery OTP is ${otp}. Share it only with the rider.`);
  }
  recordAudit({ actorRole: "system", action: "delivery.otp_generated", entityType: "delivery", entityId: deliveryId });
}

// DEMO ONLY: reveals the OTP to the customer screen. Returns null outside demo.
export function getDemoOtp(deliveryId: number, customerId: number | null): string | null {
  if (!isDemoMode()) return null;
  const db = getDb();
  const row = db
    .prepare(
      "SELECT d.otp_enc, d.status, r.customer_id FROM deliveries d JOIN requests r ON r.id = d.request_id WHERE d.id = ?"
    )
    .get(deliveryId) as { otp_enc: string | null; status: string; customer_id: number | null } | undefined;
  if (!row || !row.otp_enc) return null;
  if (row.status !== DELIVERY_STATUS.ARRIVED_DESTINATION) return null;
  if (customerId != null && row.customer_id != null && row.customer_id !== customerId) return null;
  try {
    return decryptSecret(row.otp_enc);
  } catch {
    return null;
  }
}

export function verifyHandover(input: {
  deliveryId: number;
  userId: number;
  otp: string;
  idChecked: boolean;
}): { ok: boolean; reason?: string; delivery?: Delivery } {
  const db = getDb();
  const d = getDelivery(input.deliveryId);
  if (!d) return { ok: false, reason: "Delivery not found" };
  if (d.partner_id !== input.userId) return { ok: false, reason: "Not your delivery" };
  if (d.status !== DELIVERY_STATUS.ARRIVED_DESTINATION)
    return { ok: false, reason: "Not at destination" };
  if (d.otp_attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: "Too many attempts" };
  if (d.otp_expires_at && new Date(d.otp_expires_at).getTime() < Date.now())
    return { ok: false, reason: "OTP expired" };
  if (d.rx_required && !input.idChecked)
    return { ok: false, reason: "Recipient ID must be checked for prescription medicines" };

  const expected = d.otp_hash || "";
  const got = hashOtp(input.deliveryId, input.otp);
  const match = timingSafeEqual(expected, got);

  if (!match) {
    const attempts = d.otp_attempts + 1;
    db.prepare("UPDATE deliveries SET otp_attempts = ? WHERE id = ?").run(attempts, input.deliveryId);
    recordAudit({ actorUserId: input.userId, actorRole: "delivery_partner", action: "delivery.otp_failed", entityType: "delivery", entityId: input.deliveryId, meta: { attempts } });
    if (attempts >= OTP_MAX_ATTEMPTS) {
      db.prepare("UPDATE deliveries SET status = 'HandoverFailed' WHERE id = ?").run(input.deliveryId);
      publishDelivery(input.deliveryId, d.request_id, DELIVERY_STATUS.HANDOVER_FAILED);
      publish(channels.pharmacy(d.pharmacy_id), { type: "delivery", deliveryId: input.deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.HANDOVER_FAILED });
      return { ok: false, reason: "Too many wrong attempts — handover failed" };
    }
    return { ok: false, reason: `Incorrect OTP (${OTP_MAX_ATTEMPTS - attempts} left)` };
  }

  // Geofence check against last known location.
  const last = lastKnownLocation(input.deliveryId);
  if (last && !isDemoMode()) {
    const distM = haversineKm(last, { lat: d.destination_lat, lng: d.destination_lng }) * 1000;
    if (distM > GEOFENCE_METERS) {
      recordAudit({ actorUserId: input.userId, actorRole: "delivery_partner", action: "delivery.geofence_reject", entityType: "delivery", entityId: input.deliveryId, meta: { distM } });
      return { ok: false, reason: `Outside handover geofence (${Math.round(distM)}m)` };
    }
  }

  const proof = {
    otp_verified: true,
    id_checked: !!input.idChecked,
    lat: last?.lat ?? d.destination_lat,
    lng: last?.lng ?? d.destination_lng,
    at: nowIso(),
  };
  db.prepare(
    "UPDATE deliveries SET status = 'Delivered', delivered_at = ?, id_checked = ?, proof_json = ?, otp_hash = NULL, otp_enc = NULL WHERE id = ?"
  ).run(nowIso(), input.idChecked ? 1 : 0, JSON.stringify(proof), input.deliveryId);
  recordAudit({ actorUserId: input.userId, actorRole: "delivery_partner", action: "delivery.delivered", entityType: "delivery", entityId: input.deliveryId, meta: proof });
  publishDelivery(input.deliveryId, d.request_id, DELIVERY_STATUS.DELIVERED);
  publish(channels.pharmacy(d.pharmacy_id), { type: "delivery", deliveryId: input.deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.DELIVERED });
  finalizeDeliveredRequest(d.request_id);
  return { ok: true, delivery: getDelivery(input.deliveryId) };
}

// Marks the underlying request Completed and commits the reserved stock.
function finalizeDeliveredRequest(requestId: number) {
  const db = getDb();
  const tx = db.transaction(() => {
    const req = db
      .prepare("SELECT * FROM requests WHERE id = ?")
      .get(requestId) as { status: string; medicine_id: number; preferred_pharmacy_id: number | null } | undefined;
    if (!req || req.status === "Completed" || req.status === "Cancelled") return;
    const confirmed = db
      .prepare("SELECT * FROM reservations WHERE request_id = ? AND status IN ('confirmed','active')")
      .all(requestId) as { id: number; pharmacy_id: number; qty: number }[];
    for (const r of confirmed) {
      db.prepare(
        "UPDATE inventory SET qty_total = MAX(0, qty_total - ?), qty_locked = MAX(0, qty_locked - ?) WHERE pharmacy_id = ? AND medicine_id = ?"
      ).run(r.qty, r.qty, r.pharmacy_id, req.medicine_id);
      db.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").run(r.id);
    }
    db.prepare("UPDATE requests SET status = 'Completed' WHERE id = ?").run(requestId);
    if (req.preferred_pharmacy_id) {
      db.prepare("UPDATE pharmacies SET fulfilment_count = fulfilment_count + 1 WHERE id = ?").run(req.preferred_pharmacy_id);
    }
  });
  tx();
  publish(channels.request(requestId), { type: "request", requestId, status: "Completed" });
}

// The OTP is numeric; only the assigned rider's active delivery exposes its hash state.
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "XXXXXX";
  const last4 = phone.slice(-4);
  return `XXXXXX${last4}`;
}

// -------------------------------------------------------------- retention

export function purgeOldLocations(): number {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const info = getDb()
    .prepare(
      `DELETE FROM delivery_location WHERE delivery_id IN (
         SELECT id FROM deliveries WHERE status IN ('Delivered','ReturnedToPharmacy','Cancelled') AND delivered_at IS NOT NULL AND delivered_at < ?
       )`
    )
    .run(cutoff);
  return info.changes;
}

// -------------------------------------------------------------- queries

function publishDelivery(deliveryId: number, requestId: number, status: string) {
  publish(channels.request(requestId), { type: "request", requestId, status });
  publish(channels.delivery(deliveryId), {
    type: "delivery",
    deliveryId,
    requestId,
    status,
  });
}

export function deliveryView(id: number) {
  const db = getDb();
  const d = getDelivery(id);
  if (!d) return null;
  const pharmacy = db.prepare("SELECT * FROM pharmacies WHERE id = ?").get(d.pharmacy_id);
  const partner = d.partner_id
    ? db.prepare("SELECT id, name, phone, vehicle_number, rating FROM users WHERE id = ?").get(d.partner_id)
    : null;
  const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(d.request_id);
  const last = lastKnownLocation(id);
  return {
    delivery: d,
    pharmacy,
    partner: partner
      ? {
          ...(partner as Record<string, unknown>),
          phone_masked: maskPhone((partner as { phone: string }).phone),
        }
      : null,
    request,
    last_location: last ?? null,
    otp_active: d.status === DELIVERY_STATUS.ARRIVED_DESTINATION,
  };
}

export function listDeliveriesForPartner(partnerId: number) {
  return getDb()
    .prepare(
      `SELECT d.*, p.name AS pharmacy_name
       FROM deliveries d JOIN pharmacies p ON p.id = d.pharmacy_id
       WHERE d.partner_id = ? ORDER BY d.id DESC LIMIT 50`
    )
    .all(partnerId);
}

export function listActiveDeliveriesForPharmacy(pharmacyId: number) {
  return getDb()
    .prepare(
      `SELECT d.*, u.name AS partner_name, u.vehicle_number
       FROM deliveries d LEFT JOIN users u ON u.id = d.partner_id
       WHERE d.pharmacy_id = ? AND d.status NOT IN ('Delivered','Cancelled','ReturnedToPharmacy')
       ORDER BY d.id DESC`
    )
    .all(pharmacyId);
}

export function listAllDeliveries() {
  return getDb()
    .prepare(
      `SELECT d.*, p.name AS pharmacy_name, u.name AS partner_name
       FROM deliveries d
       LEFT JOIN pharmacies p ON p.id = d.pharmacy_id
       LEFT JOIN users u ON u.id = d.partner_id
       ORDER BY d.id DESC LIMIT 200`
    )
    .all();
}

export function pendingOffersForPartner(partnerId: number) {
  const db = getDb();
  sweepDeliveries();
  return db
    .prepare(
      `SELECT o.id AS offer_id, o.expires_at, d.*, p.name AS pharmacy_name, p.lat AS pharmacy_lat, p.lng AS pharmacy_lng
       FROM delivery_offers o
       JOIN deliveries d ON d.id = o.delivery_id
       JOIN pharmacies p ON p.id = d.pharmacy_id
       WHERE o.partner_id = ? AND o.status = 'offered' AND d.status = 'SearchingPartner'
       ORDER BY o.id DESC`
    )
    .all(partnerId) as (Delivery & { offer_id: number; expires_at: string })[];
}

export function getSettingInt(key: string, fallback: number): number {
  const v = getSetting(key);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// --------------------------------------------------------- demo simulation

const HAPPY_PATH = [
  DELIVERY_STATUS.ARRIVED_PHARMACY,
  DELIVERY_STATUS.PICKED_UP,
  DELIVERY_STATUS.OUT_FOR_DELIVERY,
  DELIVERY_STATUS.ARRIVED_DESTINATION,
];

// Advances a delivery one logical step for the demo console (actor = admin).
export function demoStep(deliveryId: number): { ok: boolean; status?: string; reason?: string } {
  const db = getDb();
  const d = getDelivery(deliveryId);
  if (!d) return { ok: false, reason: "Delivery not found" };
  if (d.status === DELIVERY_STATUS.SEARCHING) {
    let offer = db
      .prepare("SELECT partner_id FROM delivery_offers WHERE delivery_id = ? AND status = 'offered'")
      .get(deliveryId) as { partner_id: number } | undefined;
    if (!offer) {
      offerNextPartner(deliveryId);
      offer = db
        .prepare("SELECT partner_id FROM delivery_offers WHERE delivery_id = ? AND status = 'offered'")
        .get(deliveryId) as { partner_id: number } | undefined;
    }
    if (offer) acceptOffer(deliveryId, offer.partner_id);
    return { ok: true, status: getDelivery(deliveryId)?.status };
  }
  if (d.status === DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL) {
    const res = transitionDelivery(deliveryId, DELIVERY_STATUS.ASSIGNED, { userId: 0, role: "admin" });
    if (!res.ok) return { ok: false, reason: res.reason };
    demoMove(deliveryId);
    return { ok: true, status: DELIVERY_STATUS.ASSIGNED };
  }
  const idx = HAPPY_PATH.indexOf(d.status as never);
  if (idx === -1 || idx === HAPPY_PATH.length - 1) {
    demoMove(deliveryId);
    return { ok: true, status: d.status };
  }
  const next = HAPPY_PATH[idx + 1];
  const res = transitionDelivery(deliveryId, next, { userId: 0, role: "admin" });
  demoMove(deliveryId);
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, status: next };
}

// Places the rider a little further along the pharmacy → destination line.
export function demoMove(deliveryId: number): void {
  const db = getDb();
  const d = getDelivery(deliveryId);
  if (!d || !d.partner_id) return;
  const pharmacy = db
    .prepare("SELECT lat, lng FROM pharmacies WHERE id = ?")
    .get(d.pharmacy_id) as { lat: number; lng: number };
  const dest = { lat: d.destination_lat, lng: d.destination_lng };
  const count = (db
    .prepare("SELECT COUNT(*) AS c FROM delivery_location WHERE delivery_id = ?")
    .get(deliveryId) as { c: number }).c;
  const t = Math.min(1, (count + 1) / 24);
  const pos = interpolate(pharmacy, dest, t);
  const heading = headingDeg(count > 0 ? interpolate(pharmacy, dest, Math.max(0, t - 1 / 24)) : pharmacy, dest);
  db.prepare(
    `INSERT INTO delivery_location (delivery_id, partner_id, lat, lng, heading, speed_mps, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(deliveryId, d.partner_id, pos.lat, pos.lng, heading, 8, nowIso());
  publish(channels.delivery(deliveryId), {
    type: "location",
    deliveryId,
    lat: pos.lat,
    lng: pos.lng,
    heading,
  });
}
