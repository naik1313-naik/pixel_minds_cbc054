import {
  queryOne,
  queryAll,
  queryRun,
  queryReturning,
  withTransaction,
  nowIso,
  getSetting,
} from "./db";
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

export async function getDelivery(id: number): Promise<Delivery | undefined> {
  return (await queryOne("SELECT * FROM deliveries WHERE id = $1", [id])) as Delivery | undefined;
}

export async function getDeliveryForRequest(requestId: number): Promise<Delivery | undefined> {
  return (await queryOne("SELECT * FROM deliveries WHERE request_id = $1", [requestId])) as
    | Delivery
    | undefined;
}

// ---------------------------------------------------------------- create

export async function createDeliveryForRequest(requestId: number): Promise<Delivery | null> {
  const req = (await queryOne(
    "SELECT * FROM requests WHERE id = $1",
    [requestId]
  )) as
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
  const existing = await getDeliveryForRequest(requestId);
  if (existing) return existing;

  const pharmacy = (await queryOne("SELECT lat, lng FROM pharmacies WHERE id = $1", [
    req.preferred_pharmacy_id,
  ])) as { lat: number; lng: number };
  const med = (await queryOne("SELECT rx_required FROM medicines WHERE id = $1", [
    req.medicine_id,
  ])) as { rx_required: number };

  const dist = roadDistanceKm(pharmacy, { lat: req.delivery_lat, lng: req.delivery_lng });
  const eta = etaMinutes(dist);
  const row = await queryReturning<{ id: number }>(
    `INSERT INTO deliveries (request_id, pharmacy_id, partner_id, status, destination_address,
       destination_lat, destination_lng, rx_required, distance_km, eta_minutes, created_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      requestId,
      req.preferred_pharmacy_id,
      DELIVERY_STATUS.SEARCHING,
      req.delivery_address,
      req.delivery_lat,
      req.delivery_lng,
      med.rx_required,
      dist,
      eta,
      nowIso(),
    ]
  );
  const id = row!.id;
  publishDelivery(id, requestId, DELIVERY_STATUS.SEARCHING);
  await offerNextPartner(id);
  return (await getDelivery(id))!;
}

// -------------------------------------------------------------- assignment

// Verified, online partners with no active delivery that haven't been offered this job.
async function candidatePartners(deliveryId: number) {
  return (await queryAll(
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
         WHERE o.delivery_id = $1 AND o.partner_id = u.id
       )
     ORDER BY u.rating DESC`,
    [deliveryId]
  )) as { id: number; name: string; rating: number }[];
}

// Offers the job to the next best partner. No-op if a partner is already assigned.
export async function offerNextPartner(
  deliveryId: number
): Promise<{ offered: boolean; partnerId?: number }> {
  const d = await getDelivery(deliveryId);
  if (!d || d.status !== DELIVERY_STATUS.SEARCHING || d.partner_id) return { offered: false };
  const candidates = await candidatePartners(deliveryId);
  if (!candidates.length) return { offered: false };
  const partner = candidates[0];
  const now = Date.now();
  await queryRun(
    `INSERT INTO delivery_offers (delivery_id, partner_id, status, offered_at, expires_at)
     VALUES ($1, $2, 'offered', $3, $4)`,
    [
      deliveryId,
      partner.id,
      new Date(now).toISOString(),
      new Date(now + OFFER_WINDOW_SECONDS * 1000).toISOString(),
    ]
  );
  const dl = d;
  const pharmacy = await queryOne("SELECT name, lat, lng FROM pharmacies WHERE id = $1", [
    dl.pharmacy_id,
  ]);
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
export async function acceptOffer(
  deliveryId: number,
  userId: number
): Promise<{ ok: boolean; reason?: string }> {
  const res = await withTransaction<{ ok: boolean; reason?: string }>(async (tx) => {
    const offer = (await tx.one(
      "SELECT * FROM delivery_offers WHERE delivery_id = $1 AND partner_id = $2 AND status = 'offered'",
      [deliveryId, userId]
    )) as { id: number; expires_at: string } | undefined;
    if (!offer) return { ok: false, reason: "No active offer" };
    if (new Date(offer.expires_at).getTime() < Date.now())
      return { ok: false, reason: "Offer expired" };

    const upd = await tx.run(
      `UPDATE deliveries SET partner_id = $1, status = 'AwaitingPharmacyApproval', accepted_at = $2
       WHERE id = $3 AND status = 'SearchingPartner' AND partner_id IS NULL`,
      [userId, nowIso(), deliveryId]
    );
    if (upd !== 1) return { ok: false, reason: "Already assigned" };

    await tx.run("UPDATE delivery_offers SET status = 'accepted' WHERE id = $1", [offer.id]);
    await tx.run(
      "UPDATE delivery_offers SET status = 'superseded' WHERE delivery_id = $1 AND id != $2",
      [deliveryId, offer.id]
    );
    await recordAudit({ actorUserId: userId, actorRole: "delivery_partner", action: "delivery.accept", entityType: "delivery", entityId: deliveryId });
    return { ok: true };
  });
  if (res.ok) {
    const d = (await getDelivery(deliveryId))!;
    publishDelivery(deliveryId, d.request_id, DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL);
    publish(`partner:${userId}`, { type: "delivery", deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL });
  }
  return res;
}

// Pharmacy approves the rider who accepted the offer, promoting the delivery
// from AwaitingPharmacyApproval to Assigned.
export async function approveAssignment(
  deliveryId: number,
  actor: { userId: number; role: string; pharmacyId: number | null }
): Promise<{ ok: boolean; reason?: string; status?: number }> {
  const res = await withTransaction<{ ok: boolean; reason?: string; status?: number }>(async (tx) => {
    const d = (await tx.one("SELECT * FROM deliveries WHERE id = $1", [deliveryId])) as
      | Delivery
      | undefined;
    if (!d) return { ok: false, reason: "Delivery not found", status: 404 };
    if (actor.role !== "admin" && actor.pharmacyId != null && d.pharmacy_id !== actor.pharmacyId)
      return { ok: false, reason: "Not your pharmacy", status: 403 };
    if (d.status !== DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL)
      return { ok: false, reason: `Cannot approve when status is ${d.status}`, status: 409 };
    if (!d.partner_id) return { ok: false, reason: "No partner assigned", status: 409 };
    const upd = await tx.run(
      `UPDATE deliveries SET status = 'Assigned', assigned_at = $1 WHERE id = $2 AND status = 'AwaitingPharmacyApproval'`,
      [nowIso(), deliveryId]
    );
    if (upd !== 1) return { ok: false, reason: "Already processed", status: 409 };
    await recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "delivery.approve_assignment", entityType: "delivery", entityId: deliveryId, meta: { partner_id: d.partner_id } });
    return { ok: true };
  });
  if (res.ok) {
    const d = (await getDelivery(deliveryId))!;
    publishDelivery(deliveryId, d.request_id, DELIVERY_STATUS.ASSIGNED);
    publish(`partner:${d.partner_id}`, { type: "delivery", deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.ASSIGNED });
    publish(channels.pharmacy(d.pharmacy_id), { type: "delivery", deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.ASSIGNED });
  }
  return res;
}

// Pharmacy rejects the accepted rider: clears the partner, re-offers the job.
export async function rejectAssignment(
  deliveryId: number,
  actor: { userId: number; role: string; pharmacyId: number | null }
): Promise<{ ok: boolean; reason?: string; status?: number }> {
  let rejectedPartner: number | null = null;
  const res = await withTransaction<{ ok: boolean; reason?: string; status?: number }>(async (tx) => {
    const d = (await tx.one("SELECT * FROM deliveries WHERE id = $1", [deliveryId])) as
      | Delivery
      | undefined;
    if (!d) return { ok: false, reason: "Delivery not found", status: 404 };
    if (actor.role !== "admin" && actor.pharmacyId != null && d.pharmacy_id !== actor.pharmacyId)
      return { ok: false, reason: "Not your pharmacy", status: 403 };
    if (d.status !== DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL)
      return { ok: false, reason: `Cannot reject when status is ${d.status}`, status: 409 };
    rejectedPartner = d.partner_id;
    const upd = await tx.run(
      `UPDATE deliveries SET partner_id = NULL, status = 'SearchingPartner' WHERE id = $1 AND status = 'AwaitingPharmacyApproval'`,
      [deliveryId]
    );
    if (upd !== 1) return { ok: false, reason: "Already processed", status: 409 };
    if (rejectedPartner) {
      await tx.run(
        "UPDATE delivery_offers SET status = 'rejected' WHERE delivery_id = $1 AND partner_id = $2 AND status = 'accepted'",
        [deliveryId, rejectedPartner]
      );
    }
    await recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "delivery.reject_assignment", entityType: "delivery", entityId: deliveryId, meta: { partner_id: rejectedPartner } });
    return { ok: true };
  });
  if (res.ok) {
    const d = (await getDelivery(deliveryId))!;
    publishDelivery(deliveryId, d.request_id, DELIVERY_STATUS.SEARCHING);
    if (rejectedPartner) {
      publish(`partner:${rejectedPartner}`, { type: "delivery", deliveryId, requestId: d.request_id, status: "AssignmentRejected" });
    }
    publish(channels.pharmacy(d.pharmacy_id), { type: "delivery", deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.SEARCHING });
    await offerNextPartner(deliveryId);
  }
  return res;
}

export async function declineOffer(deliveryId: number, userId: number) {
  await queryRun(
    "UPDATE delivery_offers SET status = 'declined' WHERE delivery_id = $1 AND partner_id = $2 AND status = 'offered'",
    [deliveryId, userId]
  );
  await recordAudit({ actorUserId: userId, actorRole: "delivery_partner", action: "delivery.decline", entityType: "delivery", entityId: deliveryId });
  await offerNextPartner(deliveryId);
}

// Sweep: expire timed-out offers and keep offering. Also purge retention.
export async function sweepDeliveries(): Promise<void> {
  const now = nowIso();
  const expired = (await queryAll(
    `SELECT o.delivery_id FROM delivery_offers o
     JOIN deliveries d ON d.id = o.delivery_id
     WHERE o.status = 'offered' AND o.expires_at < $1 AND d.status = 'SearchingPartner'`,
    [now]
  )) as { delivery_id: number }[];
  for (const row of expired) {
    await queryRun(
      "UPDATE delivery_offers SET status = 'expired' WHERE delivery_id = $1 AND status = 'offered'",
      [row.delivery_id]
    );
    await offerNextPartner(row.delivery_id);
  }
  await purgeOldLocations();
}

// ------------------------------------------------------------- state machine

export async function transitionDelivery(
  deliveryId: number,
  to: string,
  actor: { userId: number; role: string }
): Promise<{ ok: boolean; reason?: string }> {
  let generatedOtp: string | null = null;
  const res = await withTransaction<{ ok: boolean; reason?: string; requestId?: number }>(
    async (tx) => {
      const d = (await tx.one("SELECT * FROM deliveries WHERE id = $1", [deliveryId])) as
        | Delivery
        | undefined;
      if (!d) return { ok: false, reason: "Delivery not found" };
      // Assignment is confirmed by the pharmacy, never self-assigned by the rider.
      if (to === DELIVERY_STATUS.ASSIGNED && actor.role === "delivery_partner") {
        return { ok: false, reason: "Assignment must be approved by the pharmacy" };
      }
      const allowed = DELIVERY_TRANSITIONS[d.status] || [];
      if (!allowed.includes(to)) {
        await recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "delivery.illegal_transition", entityType: "delivery", entityId: deliveryId, meta: { from: d.status, to } });
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
        await tx.run(
          `UPDATE deliveries SET status = $1, otp_hash = $2, otp_enc = $3, otp_expires_at = $4, otp_attempts = 0 WHERE id = $5`,
          [
            to,
            hashOtp(deliveryId, otp),
            enc,
            new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
            deliveryId,
          ]
        );
        generatedOtp = otp;
      } else {
        const sets = ["status = $1"];
        const vals: (string | number)[] = [to];
        if (stamp.assigned_at) {
          sets.push(`assigned_at = $${vals.length + 1}`);
          vals.push(stamp.assigned_at);
        }
        if (stamp.picked_up_at) {
          sets.push(`picked_up_at = $${vals.length + 1}`);
          vals.push(stamp.picked_up_at);
        }
        if (stamp.delivered_at) {
          sets.push(`delivered_at = $${vals.length + 1}`);
          vals.push(stamp.delivered_at);
        }
        vals.push(deliveryId);
        await tx.run(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
      }
      await recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: `delivery.${to}`, entityType: "delivery", entityId: deliveryId, meta: { from: d.status } });
      return { ok: true, requestId: d.request_id };
    }
  );
  if (res.ok) {
    if (generatedOtp) await deliverOtpViaProvider(deliveryId, generatedOtp);
    const d = (await getDelivery(deliveryId))!;
    publishDelivery(deliveryId, d.request_id, to);
  }
  return res;
}

// -------------------------------------------------------------- location

export async function recordLocation(input: {
  deliveryId: number;
  userId: number;
  lat: number;
  lng: number;
  heading?: number | null;
  speed?: number | null;
}): Promise<{ ok: boolean; reason?: string }> {
  const d = await getDelivery(input.deliveryId);
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

  const last = (await queryOne(
    "SELECT * FROM delivery_location WHERE delivery_id = $1 ORDER BY id DESC LIMIT 1",
    [input.deliveryId]
  )) as { lat: number; lng: number; recorded_at: string } | undefined;

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

  await queryRun(
    `INSERT INTO delivery_location (delivery_id, partner_id, lat, lng, heading, speed_mps, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.deliveryId,
      input.userId,
      input.lat,
      input.lng,
      input.heading ?? null,
      input.speed ?? null,
      nowIso(),
    ]
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

export async function lastKnownLocation(deliveryId: number) {
  return (await queryOne(
    "SELECT * FROM delivery_location WHERE delivery_id = $1 ORDER BY id DESC LIMIT 1",
    [deliveryId]
  )) as { lat: number; lng: number; heading: number | null; recorded_at: string } | undefined;
}

export async function getTrack(deliveryId: number, limit = 200) {
  return queryAll(
    "SELECT lat, lng, heading, recorded_at FROM delivery_location WHERE delivery_id = $1 ORDER BY id ASC LIMIT $2",
    [deliveryId, limit]
  );
}

// --------------------------------------------------------------- OTP

function otpPepper(): string {
  return process.env.SESSION_PEPPER || "demo-pepper";
}
function hashOtp(deliveryId: number, otp: string): string {
  return sha256Hex(`${deliveryId}:${otp}:${otpPepper()}`);
}

async function deliverOtpViaProvider(deliveryId: number, otp: string): Promise<void> {
  const d = await getDelivery(deliveryId);
  if (!d) return;
  const customer = (await queryOne(
    "SELECT u.phone FROM requests r JOIN users u ON u.id = r.customer_id WHERE r.id = $1",
    [d.request_id]
  )) as { phone: string | null } | undefined;
  if (customer?.phone) {
    getSmsProvider().send(customer.phone, `Your MediMesh delivery OTP is ${otp}. Share it only with the rider.`);
  }
  await recordAudit({ actorRole: "system", action: "delivery.otp_generated", entityType: "delivery", entityId: deliveryId });
}

// DEMO ONLY: reveals the OTP to the customer screen. Returns null outside demo.
export async function getDemoOtp(deliveryId: number, customerId: number | null): Promise<string | null> {
  if (!isDemoMode()) return null;
  const row = (await queryOne(
    "SELECT d.otp_enc, d.status, r.customer_id FROM deliveries d JOIN requests r ON r.id = d.request_id WHERE d.id = $1",
    [deliveryId]
  )) as { otp_enc: string | null; status: string; customer_id: number | null } | undefined;
  if (!row || !row.otp_enc) return null;
  if (row.status !== DELIVERY_STATUS.ARRIVED_DESTINATION) return null;
  if (customerId != null && row.customer_id != null && row.customer_id !== customerId) return null;
  try {
    return decryptSecret(row.otp_enc);
  } catch {
    return null;
  }
}

export async function verifyHandover(input: {
  deliveryId: number;
  userId: number;
  otp: string;
  idChecked: boolean;
}): Promise<{ ok: boolean; reason?: string; delivery?: Delivery }> {
  const d = await getDelivery(input.deliveryId);
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
    await queryRun("UPDATE deliveries SET otp_attempts = $1 WHERE id = $2", [attempts, input.deliveryId]);
    await recordAudit({ actorUserId: input.userId, actorRole: "delivery_partner", action: "delivery.otp_failed", entityType: "delivery", entityId: input.deliveryId, meta: { attempts } });
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await queryRun("UPDATE deliveries SET status = 'HandoverFailed' WHERE id = $1", [input.deliveryId]);
      publishDelivery(input.deliveryId, d.request_id, DELIVERY_STATUS.HANDOVER_FAILED);
      publish(channels.pharmacy(d.pharmacy_id), { type: "delivery", deliveryId: input.deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.HANDOVER_FAILED });
      return { ok: false, reason: "Too many wrong attempts — handover failed" };
    }
    return { ok: false, reason: `Incorrect OTP (${OTP_MAX_ATTEMPTS - attempts} left)` };
  }

  // Geofence check against last known location.
  const last = await lastKnownLocation(input.deliveryId);
  if (last && !isDemoMode()) {
    const distM = haversineKm(last, { lat: d.destination_lat, lng: d.destination_lng }) * 1000;
    if (distM > GEOFENCE_METERS) {
      await recordAudit({ actorUserId: input.userId, actorRole: "delivery_partner", action: "delivery.geofence_reject", entityType: "delivery", entityId: input.deliveryId, meta: { distM } });
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
  await queryRun(
    "UPDATE deliveries SET status = 'Delivered', delivered_at = $1, id_checked = $2, proof_json = $3, otp_hash = NULL, otp_enc = NULL WHERE id = $4",
    [nowIso(), input.idChecked ? 1 : 0, JSON.stringify(proof), input.deliveryId]
  );
  await recordAudit({ actorUserId: input.userId, actorRole: "delivery_partner", action: "delivery.delivered", entityType: "delivery", entityId: input.deliveryId, meta: proof });
  publishDelivery(input.deliveryId, d.request_id, DELIVERY_STATUS.DELIVERED);
  publish(channels.pharmacy(d.pharmacy_id), { type: "delivery", deliveryId: input.deliveryId, requestId: d.request_id, status: DELIVERY_STATUS.DELIVERED });
  await finalizeDeliveredRequest(d.request_id);
  return { ok: true, delivery: await getDelivery(input.deliveryId) };
}

// Marks the underlying request Completed and commits the reserved stock.
async function finalizeDeliveredRequest(requestId: number): Promise<void> {
  await withTransaction<{ ok: boolean }>(async (tx) => {
    const req = (await tx.one("SELECT * FROM requests WHERE id = $1", [requestId])) as
      | { status: string; medicine_id: number; preferred_pharmacy_id: number | null }
      | undefined;
    if (!req || req.status === "Completed" || req.status === "Cancelled") return { ok: true };
    const confirmed = (await tx.all(
      "SELECT * FROM reservations WHERE request_id = $1 AND status IN ('confirmed','active')",
      [requestId]
    )) as { id: number; pharmacy_id: number; qty: number }[];
    for (const r of confirmed) {
      await tx.run(
        "UPDATE inventory SET qty_total = GREATEST(0, qty_total - $1), qty_locked = GREATEST(0, qty_locked - $2) WHERE pharmacy_id = $3 AND medicine_id = $4",
        [r.qty, r.qty, r.pharmacy_id, req.medicine_id]
      );
      await tx.run("UPDATE reservations SET status = 'completed' WHERE id = $1", [r.id]);
    }
    await tx.run("UPDATE requests SET status = 'Completed' WHERE id = $1", [requestId]);
    if (req.preferred_pharmacy_id) {
      await tx.run("UPDATE pharmacies SET fulfilment_count = fulfilment_count + 1 WHERE id = $1", [
        req.preferred_pharmacy_id,
      ]);
    }
    return { ok: true };
  });
  publish(channels.request(requestId), { type: "request", requestId, status: "Completed" });
}

// The OTP is numeric; only the assigned rider's active delivery exposes its hash state.
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "XXXXXX";
  const last4 = phone.slice(-4);
  return `XXXXXX${last4}`;
}

// -------------------------------------------------------------- retention

export async function purgeOldLocations(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return queryRun(
    `DELETE FROM delivery_location WHERE delivery_id IN (
       SELECT id FROM deliveries WHERE status IN ('Delivered','ReturnedToPharmacy','Cancelled') AND delivered_at IS NOT NULL AND delivered_at < $1
     )`,
    [cutoff]
  );
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

export async function deliveryView(id: number) {
  const d = await getDelivery(id);
  if (!d) return null;
  const pharmacy = await queryOne("SELECT * FROM pharmacies WHERE id = $1", [d.pharmacy_id]);
  const partner = d.partner_id
    ? await queryOne("SELECT id, name, phone, vehicle_number, rating FROM users WHERE id = $1", [
        d.partner_id,
      ])
    : null;
  const request = await queryOne("SELECT * FROM requests WHERE id = $1", [d.request_id]);
  const last = await lastKnownLocation(id);
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

export async function listDeliveriesForPartner(partnerId: number) {
  return queryAll(
    `SELECT d.*, p.name AS pharmacy_name
     FROM deliveries d JOIN pharmacies p ON p.id = d.pharmacy_id
     WHERE d.partner_id = $1 ORDER BY d.id DESC LIMIT 50`,
    [partnerId]
  );
}

export async function listActiveDeliveriesForPharmacy(pharmacyId: number) {
  return queryAll(
    `SELECT d.*, u.name AS partner_name, u.vehicle_number
     FROM deliveries d LEFT JOIN users u ON u.id = d.partner_id
     WHERE d.pharmacy_id = $1 AND d.status NOT IN ('Delivered','Cancelled','ReturnedToPharmacy')
     ORDER BY d.id DESC`,
    [pharmacyId]
  );
}

export async function listAllDeliveries() {
  return queryAll(
    `SELECT d.*, p.name AS pharmacy_name, u.name AS partner_name
     FROM deliveries d
     LEFT JOIN pharmacies p ON p.id = d.pharmacy_id
     LEFT JOIN users u ON u.id = d.partner_id
     ORDER BY d.id DESC LIMIT 200`
  );
}

export async function pendingOffersForPartner(partnerId: number) {
  await sweepDeliveries();
  return (await queryAll(
    `SELECT o.id AS offer_id, o.expires_at, d.*, p.name AS pharmacy_name, p.lat AS pharmacy_lat, p.lng AS pharmacy_lng
     FROM delivery_offers o
     JOIN deliveries d ON d.id = o.delivery_id
     JOIN pharmacies p ON p.id = d.pharmacy_id
     WHERE o.partner_id = $1 AND o.status = 'offered' AND d.status = 'SearchingPartner'
     ORDER BY o.id DESC`,
    [partnerId]
  )) as (Delivery & { offer_id: number; expires_at: string })[];
}

export async function getSettingInt(key: string, fallback: number): Promise<number> {
  const v = await getSetting(key);
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
export async function demoStep(
  deliveryId: number
): Promise<{ ok: boolean; status?: string; reason?: string }> {
  const d = await getDelivery(deliveryId);
  if (!d) return { ok: false, reason: "Delivery not found" };
  if (d.status === DELIVERY_STATUS.SEARCHING) {
    let offer = (await queryOne(
      "SELECT partner_id FROM delivery_offers WHERE delivery_id = $1 AND status = 'offered'",
      [deliveryId]
    )) as { partner_id: number } | undefined;
    if (!offer) {
      await offerNextPartner(deliveryId);
      offer = (await queryOne(
        "SELECT partner_id FROM delivery_offers WHERE delivery_id = $1 AND status = 'offered'",
        [deliveryId]
      )) as { partner_id: number } | undefined;
    }
    if (offer) await acceptOffer(deliveryId, offer.partner_id);
    return { ok: true, status: (await getDelivery(deliveryId))?.status };
  }
  if (d.status === DELIVERY_STATUS.AWAITING_PHARMACY_APPROVAL) {
    const res = await transitionDelivery(deliveryId, DELIVERY_STATUS.ASSIGNED, { userId: 0, role: "admin" });
    if (!res.ok) return { ok: false, reason: res.reason };
    await demoMove(deliveryId);
    return { ok: true, status: DELIVERY_STATUS.ASSIGNED };
  }
  const idx = HAPPY_PATH.indexOf(d.status as never);
  if (idx === -1 || idx === HAPPY_PATH.length - 1) {
    await demoMove(deliveryId);
    return { ok: true, status: d.status };
  }
  const next = HAPPY_PATH[idx + 1];
  const res = await transitionDelivery(deliveryId, next, { userId: 0, role: "admin" });
  await demoMove(deliveryId);
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, status: next };
}

// Places the rider a little further along the pharmacy → destination line.
export async function demoMove(deliveryId: number): Promise<void> {
  const d = await getDelivery(deliveryId);
  if (!d || !d.partner_id) return;
  const pharmacy = (await queryOne("SELECT lat, lng FROM pharmacies WHERE id = $1", [
    d.pharmacy_id,
  ])) as { lat: number; lng: number };
  const dest = { lat: d.destination_lat, lng: d.destination_lng };
  const countRow = (await queryOne(
    "SELECT COUNT(*)::int AS c FROM delivery_location WHERE delivery_id = $1",
    [deliveryId]
  )) as { c: number };
  const count = countRow.c;
  const t = Math.min(1, (count + 1) / 24);
  const pos = interpolate(pharmacy, dest, t);
  const heading = headingDeg(count > 0 ? interpolate(pharmacy, dest, Math.max(0, t - 1 / 24)) : pharmacy, dest);
  await queryRun(
    `INSERT INTO delivery_location (delivery_id, partner_id, lat, lng, heading, speed_mps, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [deliveryId, d.partner_id, pos.lat, pos.lng, heading, 8, nowIso()]
  );
  publish(channels.delivery(deliveryId), {
    type: "location",
    deliveryId,
    lat: pos.lat,
    lng: pos.lng,
    heading,
  });
}
