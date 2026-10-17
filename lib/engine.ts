import { randomUUID } from "crypto";
import {
  queryOne,
  queryAll,
  queryRun,
  withTransaction,
  nowIso,
  getSetting,
  setSetting,
  type TxClient,
} from "./db";
import {
  WHOLESALE_RATE,
  PLATFORM_FEE_RATE,
  REQUEST_STATUS,
  CUSTOMER_LOCATION,
} from "./constants";
import { haversineKm } from "./geo";
import { recordAudit } from "./audit";
import { publish, channels } from "./sse";
import { createDeliveryForRequest, getDeliveryForRequest } from "./delivery";
import { createIntent, refundPaymentForRequest, settlePaymentForRequest } from "./payments";

/** Thrown for client-fixable problems in a request; surfaces as HTTP 400. */
export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export interface Pharmacy {
  id: number;
  name: string;
  address: string;
  lat: number;
  lng: number;
  drug_licence_no: string;
  verification_status: string;
  response_score: number;
  fulfilment_count: number;
  licence_verified?: string | null;
  licence_checked_at?: string | null;
  licence_meta_json?: string | null;
  created_at: string;
}
export interface Medicine {
  id: number;
  name: string;
  salt: string;
  price_paise: number;
  rx_required: number;
  synonyms: string | null;
  category: string | null;
  strength: string | null;
  dosage_form: string | null;
}

const LOCK_DEFAULT_SECONDS = 1800; // 30 minutes

// expiry_date is stored as ISO 'YYYY-MM-DD' text, so compare as text.
const TODAY_TEXT = "CURRENT_DATE::text";

export async function getLockSeconds(): Promise<number> {
  const v = await getSetting("lock_seconds");
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : LOCK_DEFAULT_SECONDS;
}
export async function setLockSeconds(sec: number): Promise<void> {
  await setSetting("lock_seconds", String(Math.max(5, Math.floor(sec))));
}
export async function is20sLockEnabled(): Promise<boolean> {
  return (await getLockSeconds()) === 20;
}

// ---------------------------------------------------------------- reads

export async function listPharmacies(): Promise<Pharmacy[]> {
  return (await queryAll("SELECT * FROM pharmacies ORDER BY id")) as Pharmacy[];
}
export async function getPharmacy(id: number): Promise<Pharmacy | undefined> {
  return (await queryOne("SELECT * FROM pharmacies WHERE id = $1", [id])) as Pharmacy | undefined;
}
export async function listMedicines(): Promise<Medicine[]> {
  return (await queryAll("SELECT * FROM medicines ORDER BY id")) as Medicine[];
}
export async function getMedicine(id: number): Promise<Medicine | undefined> {
  return (await queryOne("SELECT * FROM medicines WHERE id = $1", [id])) as Medicine | undefined;
}

export interface StockRow {
  pharmacy_id: number;
  medicine_id: number;
  qty_total: number;
  qty_locked: number;
  expiry_date: string | null;
  free: number;
}

// Free stock = unlocked and not expired network-wide for a medicine.
export async function availability(medicineId: number) {
  const medicine = await getMedicine(medicineId);
  if (!medicine) return null;
  const rows = (await queryAll(
    `SELECT i.*, i.qty_total - i.qty_locked AS free, p.name AS pharmacy_name, p.verification_status, p.lat, p.lng
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
       WHERE i.medicine_id = $1
         AND i.qty_total - i.qty_locked > 0
         AND (i.expiry_date IS NULL OR i.expiry_date >= ${TODAY_TEXT})
       ORDER BY free DESC`,
    [medicineId]
  )) as (StockRow & { pharmacy_name: string; verification_status: string; lat: number; lng: number })[];
  const total_free = rows
    .filter((r) => r.verification_status === "verified")
    .reduce((s, r) => s + r.free, 0);
  return { medicine, total_free, pharmacies: rows };
}

export async function totalFreeStock(medicineId: number): Promise<number> {
  const row = await queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(i.qty_total - i.qty_locked),0)::int AS total
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
       WHERE i.medicine_id = $1 AND p.verification_status = 'verified'
         AND (i.expiry_date IS NULL OR i.expiry_date >= ${TODAY_TEXT})`,
    [medicineId]
  );
  return row ? row.total : 0;
}

export async function freeStockAt(pharmacyId: number, medicineId: number): Promise<number> {
  const row = await queryOne<{ free: number }>(
    `SELECT (qty_total - qty_locked) AS free FROM inventory
       WHERE pharmacy_id = $1 AND medicine_id = $2
         AND (expiry_date IS NULL OR expiry_date >= ${TODAY_TEXT})`,
    [pharmacyId, medicineId]
  );
  return row ? Math.max(0, row.free) : 0;
}

// ---------------------------------------------------------------- scoring

export interface Ranked {
  pharmacy: Pharmacy;
  distance_km: number;
  free: number;
  expiry: string | null;
  score: number;
  stock_confidence: number;
}

function stockConfidence(free: number, qty: number): number {
  if (qty <= 0) return 0;
  return Math.min(1, free / qty);
}

// score = 0.4*(1/distance) + 0.3*stock_confidence + 0.2*response_score + 0.1*fulfilment_history
export async function rankPharmacies(
  medicineId: number,
  qty: number,
  origin: { lat: number; lng: number } = CUSTOMER_LOCATION
): Promise<Ranked[]> {
  const rows = (await queryAll(
    `SELECT p.*, i.qty_total - i.qty_locked AS free, i.expiry_date
       FROM pharmacies p JOIN inventory i ON i.pharmacy_id = p.id
       WHERE i.medicine_id = $1 AND p.verification_status = 'verified'
         AND i.qty_total - i.qty_locked > 0
         AND (i.expiry_date IS NULL OR i.expiry_date >= ${TODAY_TEXT})`,
    [medicineId]
  )) as (Pharmacy & { free: number; expiry_date: string | null })[];
  const ranked: Ranked[] = rows.map((r) => {
    const distance_km = haversineKm({ lat: r.lat, lng: r.lng }, origin);
    const sc = stockConfidence(r.free, qty);
    const history = Math.min(1, r.fulfilment_count / 50);
    const score =
      0.4 * (1 / Math.max(0.1, distance_km)) +
      0.3 * sc +
      0.2 * r.response_score +
      0.1 * history;
    return {
      pharmacy: {
        id: r.id,
        name: r.name,
        address: r.address,
        lat: r.lat,
        lng: r.lng,
        drug_licence_no: r.drug_licence_no,
        verification_status: r.verification_status,
        response_score: r.response_score,
        fulfilment_count: r.fulfilment_count,
        created_at: r.created_at,
      },
      distance_km,
      free: r.free,
      expiry: r.expiry_date,
      score,
      stock_confidence: sc,
    };
  });
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ea = a.expiry ?? "9999-12-31";
    const eb = b.expiry ?? "9999-12-31";
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });
  return ranked;
}

// ---------------------------------------------------------------- locking

async function tryLock(
  pharmacyId: number,
  medicineId: number,
  qty: number,
  tx?: TxClient
): Promise<boolean> {
  const sql = `UPDATE inventory SET qty_locked = qty_locked + $1
     WHERE pharmacy_id = $2 AND medicine_id = $3
       AND qty_total - qty_locked >= $4
       AND (expiry_date IS NULL OR expiry_date >= ${TODAY_TEXT})`;
  const params = [qty, pharmacyId, medicineId, qty];
  const changes = tx ? await tx.run(sql, params) : await queryRun(sql, params);
  return changes === 1;
}

async function releaseLock(
  pharmacyId: number,
  medicineId: number,
  qty: number,
  tx?: TxClient
): Promise<void> {
  const sql = `UPDATE inventory SET qty_locked = GREATEST(0, qty_locked - $1)
     WHERE pharmacy_id = $2 AND medicine_id = $3`;
  const params = [qty, pharmacyId, medicineId];
  if (tx) await tx.run(sql, params);
  else await queryRun(sql, params);
}

// ---------------------------------------------------------------- expire sweep

// Idempotent: releases expired active locks and expires their requests.
export async function sweepExpired(): Promise<number> {
  const now = nowIso();
  const stale = await queryAll<{ request_id: number }>(
    `SELECT DISTINCT request_id FROM reservations
       WHERE status = 'active' AND lock_expires_at < $1`,
    [now]
  );
  let expired = 0;
  for (const { request_id } of stale) {
    const didExpire = await withTransaction(async (tx) => {
      const req = await tx.one<{ status: string }>("SELECT status FROM requests WHERE id = $1", [
        request_id,
      ]);
      if (!req) return false;
      if (
        [REQUEST_STATUS.COMPLETED, REQUEST_STATUS.CANCELLED, REQUEST_STATUS.REJECTED, REQUEST_STATUS.EXPIRED].includes(
          req.status as never
        )
      )
        return false;
      const active = await tx.all<{ id: number; pharmacy_id: number; qty: number }>(
        "SELECT * FROM reservations WHERE request_id = $1 AND status = 'active'",
        [request_id]
      );
      const medRow = await tx.one<{ medicine_id: number }>(
        "SELECT medicine_id FROM requests WHERE id = $1",
        [request_id]
      );
      for (const r of active) {
        await releaseLock(r.pharmacy_id, medRow!.medicine_id, r.qty, tx);
        await tx.run("UPDATE reservations SET status = 'expired' WHERE id = $1", [r.id]);
      }
      await tx.run("UPDATE requests SET status = $1, secured_qty = 0 WHERE id = $2", [
        REQUEST_STATUS.EXPIRED,
        request_id,
      ]);
      return true;
    });
    if (didExpire) {
      publish(channels.request(request_id), {
        type: "request",
        requestId: request_id,
        status: REQUEST_STATUS.EXPIRED,
      });
      expired++;
    }
  }
  return expired;
}

// ---------------------------------------------------------------- create + source

export interface CreateRequestInput {
  medicineId: number;
  qty: number;
  customerId: number | null;
  customerName: string;
  fulfilmentType: "pickup" | "delivery";
  deliveryAddress?: string;
  deliveryLat?: number;
  deliveryLng?: number;
  area?: string;
  /** Customer's explicit pharmacy choice; takes priority over auto-ranking. */
  preferredPharmacyId?: number | null;
  idempotencyKey?: string;
}

export async function createRequest(input: CreateRequestInput) {
  if (input.idempotencyKey) {
    const existing = await queryOne<{ id: number }>(
      "SELECT id FROM requests WHERE idempotency_key = $1",
      [input.idempotencyKey]
    );
    if (existing) return { requestId: existing.id, created: false };
  }
  const medicine = await getMedicine(input.medicineId);
  if (!medicine) throw new Error("Unknown medicine");
  const qty = Math.max(1, Math.min(50, Math.floor(input.qty)));

  // A customer may point the request at any specific pharmacy (including a
  // freshly registered one with no stock yet). It must exist and be verified,
  // otherwise the request would never reach an owner.
  let preferredPharmacyId: number | null = null;
  if (input.preferredPharmacyId != null) {
    const chosen = await queryOne<{ id: number }>(
      "SELECT id FROM pharmacies WHERE id = $1 AND verification_status = 'verified'",
      [input.preferredPharmacyId]
    );
    if (!chosen) throw new RequestValidationError("Selected pharmacy is not available");
    preferredPharmacyId = chosen.id;
  }

  const requestId = await withTransaction(async (tx) => {
    const row = await tx.one<{ id: number }>(
      `INSERT INTO requests (customer_id, customer_name, medicine_id, qty, preferred_pharmacy_id,
           fulfilment_type, delivery_address, delivery_lat, delivery_lng, status, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
      [
        input.customerId,
        input.customerName,
        input.medicineId,
        qty,
        preferredPharmacyId,
        input.fulfilmentType,
        input.deliveryAddress ?? null,
        input.deliveryLat ?? null,
        input.deliveryLng ?? null,
        REQUEST_STATUS.REQUESTED,
        input.idempotencyKey ?? randomUUID(),
        nowIso(),
      ]
    );
    const id = row!.id;
    await tx.run(
      "INSERT INTO demand_events (medicine_id, area, qty, created_at) VALUES ($1, $2, $3, $4)",
      [input.medicineId, input.area ?? CUSTOMER_LOCATION.area, qty, nowIso()]
    );
    return id;
  });

  await sourceRequest(requestId);
  return { requestId, created: true };
}

// Distributes locked stock across ranked pharmacies. Idempotent-ish: only runs
// from a Requested state.
export async function sourceRequest(requestId: number): Promise<void> {
  const req = await queryOne<{
    id: number;
    medicine_id: number;
    qty: number;
    status: string;
    fulfilment_type: string;
    delivery_lat: number | null;
    delivery_lng: number | null;
    preferred_pharmacy_id: number | null;
  }>("SELECT * FROM requests WHERE id = $1", [requestId]);
  if (!req || req.status !== REQUEST_STATUS.REQUESTED) return;
  const medicine = (await getMedicine(req.medicine_id))!;
  const origin =
    req.fulfilment_type === "delivery" && req.delivery_lat != null && req.delivery_lng != null
      ? { lat: req.delivery_lat, lng: req.delivery_lng }
      : CUSTOMER_LOCATION;

  const rankedAll = await rankPharmacies(req.medicine_id, req.qty, origin);
  const chosenPharmacyId: number | null = req.preferred_pharmacy_id ?? null;

  // A customer-selected pharmacy is served first; the rest of the network is
  // still used to top up any shortfall.
  const ranked = chosenPharmacyId
    ? [
        ...rankedAll.filter((r) => r.pharmacy.id === chosenPharmacyId),
        ...rankedAll.filter((r) => r.pharmacy.id !== chosenPharmacyId),
      ]
    : rankedAll;
  const lockSeconds = await getLockSeconds();
  const expires = new Date(Date.now() + lockSeconds * 1000).toISOString();

  const { preferred, status } = await withTransaction(async (tx) => {
    let needed = req.qty;
    let secured = 0;
    // Honour the customer's choice as the primary pharmacy even before any
    // stock is locked, so the request reaches that pharmacy's owner.
    let preferred: number | null = chosenPharmacyId;
    let preferredQty = 0;

    for (const r of ranked) {
      if (needed <= 0) break;
      const take = Math.min(needed, r.free);
      if (take <= 0) continue;
      if (!(await tryLock(r.pharmacy.id, req.medicine_id, take, tx))) continue;
      await tx.run(
        `INSERT INTO reservations (request_id, pharmacy_id, qty, lock_expires_at, status, kind, created_at)
           VALUES ($1, $2, $3, $4, 'active', 'primary', $5)`,
        [requestId, r.pharmacy.id, take, expires, nowIso()]
      );
      needed -= take;
      secured += take;
      // A customer-picked pharmacy always stays primary; otherwise the
      // pharmacy that contributed the most units wins.
      if (preferred == null && take > preferredQty) {
        preferredQty = take;
        preferred = r.pharmacy.id;
      }
    }

    let status: string;
    if (secured === 0) {
      if (chosenPharmacyId) {
        // Directed request: the customer asked this pharmacy specifically, so
        // hand it to the owner even with no stock yet (they can restock and
        // confirm). Not a lost sale.
        status = medicine.rx_required
          ? REQUEST_STATUS.NEEDS_VERIFICATION
          : REQUEST_STATUS.SOURCING;
      } else {
        status = REQUEST_STATUS.UNAVAILABLE;
        await tx.run(
          "INSERT INTO lost_sales (medicine_id, pharmacy_id, qty, value, created_at) VALUES ($1, NULL, $2, $3, $4)",
          [req.medicine_id, req.qty, medicine.price_paise * req.qty, nowIso()]
        );
      }
    } else if (secured < req.qty) {
      status = REQUEST_STATUS.PARTIAL;
    } else {
      status = medicine.rx_required ? REQUEST_STATUS.NEEDS_VERIFICATION : REQUEST_STATUS.SOURCING;
    }
    await tx.run(
      "UPDATE requests SET status = $1, secured_qty = $2, preferred_pharmacy_id = $3 WHERE id = $4",
      [status, secured, preferred, requestId]
    );
    return { preferred, status };
  });

  publish(channels.request(requestId), { type: "request", requestId, status });
  if (preferred) publish(channels.pharmacy(preferred), { type: "request", requestId, status });
}

// ---------------------------------------------------------------- actions

export async function verifyRx(requestId: number, actor: { userId: number; role: string }) {
  const req = await queryOne<{ status: string; medicine_id: number }>(
    "SELECT * FROM requests WHERE id = $1",
    [requestId]
  );
  if (!req) return { ok: false, reason: "Not found" };
  if (![REQUEST_STATUS.NEEDS_VERIFICATION, REQUEST_STATUS.SOURCING].includes(req.status as never))
    return { ok: false, reason: "Not awaiting verification" };
  await queryRun("UPDATE requests SET rx_verified = 1, rx_verified_by = $1 WHERE id = $2", [
    actor.userId,
    requestId,
  ]);
  if (req.status === REQUEST_STATUS.NEEDS_VERIFICATION) {
    await queryRun("UPDATE requests SET status = $1 WHERE id = $2", [
      REQUEST_STATUS.SOURCING,
      requestId,
    ]);
    publish(channels.request(requestId), {
      type: "request",
      requestId,
      status: REQUEST_STATUS.SOURCING,
    });
  }
  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "request.rx_verified",
    entityType: "request",
    entityId: requestId,
  });
  return { ok: true };
}

export async function confirmRequest(requestId: number, actor: { userId: number; role: string }) {
  const req = await queryOne<{
    status: string;
    medicine_id: number;
    preferred_pharmacy_id: number;
    rx_verified: number;
    secured_qty: number;
    fulfilment_type: string;
  }>("SELECT * FROM requests WHERE id = $1", [requestId]);
  if (!req) return { ok: false, reason: "Not found" };
  if (
    ![REQUEST_STATUS.SOURCING, REQUEST_STATUS.NEEDS_VERIFICATION, REQUEST_STATUS.PARTIAL].includes(
      req.status as never
    )
  )
    return { ok: false, reason: `Cannot confirm from ${req.status}` };
  if (actor.role !== "admin") {
    const user = await queryOne<{ pharmacy_id: number | null }>(
      "SELECT pharmacy_id FROM users WHERE id = $1",
      [actor.userId]
    );
    if (!user || user.pharmacy_id !== req.preferred_pharmacy_id)
      return { ok: false, reason: "Not your pharmacy" };
  }
  const medicine = (await getMedicine(req.medicine_id))!;
  if (medicine.rx_required && !req.rx_verified)
    return { ok: false, reason: "Prescription must be verified first" };

  const now = nowIso();
  await withTransaction(async (tx) => {
    const reservations = await tx.all<{ id: number; pharmacy_id: number; qty: number; kind: string }>(
      "SELECT * FROM reservations WHERE request_id = $1 AND status = 'active'",
      [requestId]
    );
    for (const r of reservations) {
      if (r.pharmacy_id === req.preferred_pharmacy_id) {
        await tx.run("UPDATE reservations SET status = 'confirmed' WHERE id = $1", [r.id]);
      } else {
        // Borrowed units: recorded in the ledger and removed from the source store.
        const wholesale = Math.round(medicine.price_paise * r.qty * WHOLESALE_RATE);
        const fee = Math.round(medicine.price_paise * r.qty * PLATFORM_FEE_RATE);
        await tx.run(
          `INSERT INTO ledger (request_id, from_pharmacy_id, to_pharmacy_id, medicine_id, qty,
             wholesale_amount, platform_fee, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [requestId, r.pharmacy_id, req.preferred_pharmacy_id, req.medicine_id, r.qty, wholesale, fee, now]
        );
        await tx.run(
          `UPDATE inventory SET qty_total = GREATEST(qty_locked, qty_total - $1), qty_locked = GREATEST(0, qty_locked - $2)
             WHERE pharmacy_id = $3 AND medicine_id = $4`,
          [r.qty, r.qty, r.pharmacy_id, req.medicine_id]
        );
        await tx.run("UPDATE reservations SET status = 'borrowed' WHERE id = $1", [r.id]);
      }
    }
    await tx.run("UPDATE requests SET status = $1 WHERE id = $2", [REQUEST_STATUS.CONFIRMED, requestId]);
  });
  // Confirming an order is the point the amount becomes owed, so this is where
  // the payment intent opens. A gateway outage must not block confirmation: the
  // intent is a database fact, the gateway order is created lazily on checkout.
  try {
    await createIntent(requestId);
  } catch (e) {
    await recordAudit({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "payment.intent_failed",
      entityType: "request",
      entityId: requestId,
      meta: { message: e instanceof Error ? e.message : "unknown" },
    });
  }
  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "request.confirmed",
    entityType: "request",
    entityId: requestId,
  });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.CONFIRMED });
  publish(channels.pharmacy(req.preferred_pharmacy_id), {
    type: "request",
    requestId,
    status: REQUEST_STATUS.CONFIRMED,
  });
  return { ok: true };
}

export async function rejectRequest(
  requestId: number,
  actor: { userId: number; role: string },
  reason?: string
) {
  const req = await queryOne<{ status: string; medicine_id: number; preferred_pharmacy_id: number }>(
    "SELECT * FROM requests WHERE id = $1",
    [requestId]
  );
  if (!req) return { ok: false, reason: "Not found" };
  if (actor.role !== "admin") {
    const user = await queryOne<{ pharmacy_id: number | null }>(
      "SELECT pharmacy_id FROM users WHERE id = $1",
      [actor.userId]
    );
    if (!user || user.pharmacy_id !== req.preferred_pharmacy_id)
      return { ok: false, reason: "Not your pharmacy" };
  }
  await withTransaction(async (tx) => {
    const active = await tx.all<{ id: number; pharmacy_id: number; qty: number }>(
      "SELECT * FROM reservations WHERE request_id = $1 AND status = 'active'",
      [requestId]
    );
    for (const r of active) {
      await releaseLock(r.pharmacy_id, req.medicine_id, r.qty, tx);
      await tx.run("UPDATE reservations SET status = 'rejected' WHERE id = $1", [r.id]);
    }
    await tx.run("UPDATE requests SET status = $1, secured_qty = 0 WHERE id = $2", [
      REQUEST_STATUS.REJECTED,
      requestId,
    ]);
  });
  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "request.rejected",
    entityType: "request",
    entityId: requestId,
    meta: reason ? { reason } : undefined,
  });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.REJECTED });
  return { ok: true };
}

export async function markReady(requestId: number, actor: { userId: number; role: string }) {
  const req = await queryOne<{ status: string; fulfilment_type: string; preferred_pharmacy_id: number }>(
    "SELECT * FROM requests WHERE id = $1",
    [requestId]
  );
  if (!req) return { ok: false, reason: "Not found" };
  if (req.status !== REQUEST_STATUS.CONFIRMED)
    return { ok: false, reason: `Cannot ready from ${req.status}` };
  if (actor.role !== "admin") {
    const user = await queryOne<{ pharmacy_id: number | null }>(
      "SELECT pharmacy_id FROM users WHERE id = $1",
      [actor.userId]
    );
    if (!user || user.pharmacy_id !== req.preferred_pharmacy_id)
      return { ok: false, reason: "Not your pharmacy" };
  }
  await queryRun("UPDATE requests SET status = $1 WHERE id = $2", [REQUEST_STATUS.READY, requestId]);
  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "request.ready",
    entityType: "request",
    entityId: requestId,
  });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.READY });
  publish(channels.pharmacy(req.preferred_pharmacy_id), {
    type: "request",
    requestId,
    status: REQUEST_STATUS.READY,
  });

  let deliveryId: number | null = null;
  if (req.fulfilment_type === "delivery") {
    const d = await createDeliveryForRequest(requestId);
    deliveryId = d ? d.id : null;
  }
  return { ok: true, deliveryId };
}

export async function completeRequest(requestId: number, actor: { userId: number; role: string }) {
  const req = await queryOne<{
    status: string;
    medicine_id: number;
    preferred_pharmacy_id: number;
    secured_qty: number;
    fulfilment_type: string;
    customer_id: number | null;
  }>("SELECT * FROM requests WHERE id = $1", [requestId]);
  if (!req) return { ok: false, reason: "Not found" };
  if (![REQUEST_STATUS.READY, REQUEST_STATUS.CONFIRMED].includes(req.status as never))
    return { ok: false, reason: `Cannot complete from ${req.status}` };
  if (actor.role === "customer" && req.customer_id !== actor.userId)
    return { ok: false, reason: "Not your request" };

  const expiringStock = await queryAll<{
    pharmacy_id: number;
    medicine_name: string;
    expiry_date: string | null;
  }>(
    `SELECT DISTINCT i.pharmacy_id, m.name AS medicine_name, i.expiry_date
       FROM reservations res
       JOIN requests r ON r.id = res.request_id
       JOIN inventory i
         ON i.pharmacy_id = res.pharmacy_id AND i.medicine_id = r.medicine_id
       JOIN medicines m ON m.id = r.medicine_id
      WHERE res.request_id = $1 AND res.status IN ('confirmed','active')`,
    [requestId]
  );
  const { today: todayText } =
    (await queryOne<{ today: string }>("SELECT CURRENT_DATE::text AS today"))!;

  // Expiry is checked again here, not only when the units were reserved. A batch
  // can pass its expiry date while an order sits Ready, and handing over expired
  // stock is the one mistake this whole system exists to prevent — so the check
  // that matters is the one at the moment of dispense, not the one that happened
  // to run first.
  for (const row of expiringStock) {
    if (row.expiry_date && row.expiry_date < todayText) {
      await recordAudit({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "request.blocked_expired_stock",
        entityType: "request",
        entityId: requestId,
        meta: { pharmacyId: row.pharmacy_id, medicine: row.medicine_name, expiry: row.expiry_date },
      });
      return {
        ok: false as const,
        reason:
          `${row.medicine_name} in this order expired on ${row.expiry_date} and cannot be handed ` +
          `over. Cancel the order and the customer is refunded automatically.`,
      };
    }
  }

  await withTransaction(async (tx) => {
    const confirmed = await tx.all<{ id: number; pharmacy_id: number; qty: number }>(
      "SELECT * FROM reservations WHERE request_id = $1 AND status IN ('confirmed','active')",
      [requestId]
    );

    for (const r of confirmed) {
      await tx.run(
        `UPDATE inventory SET qty_total = GREATEST(0, qty_total - $1), qty_locked = GREATEST(0, qty_locked - $2)
           WHERE pharmacy_id = $3 AND medicine_id = $4`,
        [r.qty, r.qty, r.pharmacy_id, req.medicine_id]
      );
      await tx.run("UPDATE reservations SET status = 'completed' WHERE id = $1", [r.id]);
    }
    await tx.run("UPDATE requests SET status = $1 WHERE id = $2", [REQUEST_STATUS.COMPLETED, requestId]);
    if (req.preferred_pharmacy_id) {
      await tx.run("UPDATE pharmacies SET fulfilment_count = fulfilment_count + 1 WHERE id = $1", [
        req.preferred_pharmacy_id,
      ]);
    }
  });
  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "request.completed",
    entityType: "request",
    entityId: requestId,
  });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.COMPLETED });
  if (req.preferred_pharmacy_id)
    publish(channels.pharmacy(req.preferred_pharmacy_id), {
      type: "request",
      requestId,
      status: REQUEST_STATUS.COMPLETED,
    });
  // Pickup fulfilment is done, so any captured payment is released to the
  // pharmacy owner. Safe to call repeatedly: settlement is idempotent.
  await settlePaymentForRequest(requestId, { userId: actor.userId, role: actor.role });
  return { ok: true };
}

export async function cancelRequest(requestId: number, actor: { userId: number; role: string }) {
  const req = await queryOne<{ status: string; medicine_id: number; customer_id: number | null }>(
    "SELECT * FROM requests WHERE id = $1",
    [requestId]
  );
  if (!req) return { ok: false, reason: "Not found" };
  if (actor.role === "customer" && req.customer_id !== actor.userId)
    return { ok: false, reason: "Not your request" };
  if ([REQUEST_STATUS.COMPLETED, REQUEST_STATUS.CANCELLED].includes(req.status as never))
    return { ok: false, reason: "Already final" };
  await withTransaction(async (tx) => {
    const active = await tx.all<{ id: number; pharmacy_id: number; qty: number }>(
      "SELECT * FROM reservations WHERE request_id = $1 AND status IN ('active','confirmed')",
      [requestId]
    );
    for (const r of active) {
      await releaseLock(r.pharmacy_id, req.medicine_id, r.qty, tx);
      await tx.run("UPDATE reservations SET status = 'cancelled' WHERE id = $1", [r.id]);
    }
    await tx.run("UPDATE requests SET status = $1 WHERE id = $2", [REQUEST_STATUS.CANCELLED, requestId]);
  });
  await recordAudit({
    actorUserId: actor.userId,
    actorRole: actor.role,
    action: "request.cancelled",
    entityType: "request",
    entityId: requestId,
  });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.CANCELLED });
  // Anything already captured is returned to the customer. An intent that was
  // never captured simply closes as cancelled.
  try {
    await refundPaymentForRequest(requestId, { userId: actor.userId, role: actor.role }, "Order cancelled");
  } catch (e) {
    // A failed refund must not mask the cancellation; it is recorded in the
    // audit log and surfaces on the payment record.
    // eslint-disable-next-line no-console
    console.error("refund after cancel failed", e);
    await recordAudit({
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "payment.refund_failed",
      entityType: "request",
      entityId: requestId,
      meta: { message: e instanceof Error ? e.message : "unknown" },
    });
  }
  return { ok: true };
}

// ---------------------------------------------------------------- queries

export interface RequestRow {
  id: number;
  customer_id: number | null;
  customer_name: string;
  medicine_id: number;
  qty: number;
  secured_qty: number;
  preferred_pharmacy_id: number | null;
  fulfilment_type: string;
  delivery_address: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  status: string;
  rx_verified: number;
  rx_verified_by: number | null;
  substitute_for_id: number | null;
  idempotency_key: string | null;
  amount_paise: number | null;
  platform_fee_paise: number | null;
  payment_status: string | null;
  created_at: string;
}

export async function getRequestDetail(requestId: number) {
  const request = (await queryOne("SELECT * FROM requests WHERE id = $1", [requestId])) as
    | RequestRow
    | undefined;
  if (!request) return null;
  const medicine = await getMedicine(request.medicine_id);
  const pharmacy = request.preferred_pharmacy_id ? await getPharmacy(request.preferred_pharmacy_id) : null;
  const reservations = await queryAll(
    "SELECT res.*, p.name AS pharmacy_name FROM reservations res JOIN pharmacies p ON p.id = res.pharmacy_id WHERE res.request_id = $1 ORDER BY res.id",
    [requestId]
  );
  const delivery = (await getDeliveryForRequest(requestId)) ?? null;
  return { request, medicine, pharmacy, reservations, delivery };
}

export async function listRequests(
  filter: { customerId?: number; pharmacyId?: number; status?: string; limit?: number } = {}
) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.customerId) {
    params.push(filter.customerId);
    where.push(`r.customer_id = $${params.length}`);
  }
  if (filter.pharmacyId) {
    params.push(filter.pharmacyId);
    where.push(`r.preferred_pharmacy_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`r.status = $${params.length}`);
  }
  params.push(Math.min(filter.limit ?? 100, 300));
  const sql = `SELECT r.*, m.name AS medicine_name, p.name AS pharmacy_name
    FROM requests r JOIN medicines m ON m.id = r.medicine_id
    LEFT JOIN pharmacies p ON p.id = r.preferred_pharmacy_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY r.id DESC LIMIT $${params.length}`;
  return queryAll(sql, params);
}

export async function listLedger(pharmacyId?: number) {
  if (pharmacyId) {
    return queryAll(
      `SELECT l.*, m.name AS medicine_name, f.name AS from_name, t.name AS to_name
         FROM ledger l JOIN medicines m ON m.id = l.medicine_id
         JOIN pharmacies f ON f.id = l.from_pharmacy_id JOIN pharmacies t ON t.id = l.to_pharmacy_id
         WHERE l.from_pharmacy_id = $1 OR l.to_pharmacy_id = $2 ORDER BY l.id DESC LIMIT 100`,
      [pharmacyId, pharmacyId]
    );
  }
  return queryAll(
    `SELECT l.*, m.name AS medicine_name, f.name AS from_name, t.name AS to_name
       FROM ledger l JOIN medicines m ON m.id = l.medicine_id
       JOIN pharmacies f ON f.id = l.from_pharmacy_id JOIN pharmacies t ON t.id = l.to_pharmacy_id
       ORDER BY l.id DESC LIMIT 100`
  );
}

export async function findSubstitutes(medicineId: number) {
  const med = await getMedicine(medicineId);
  if (!med) return [];
  const subs = (await queryAll("SELECT * FROM medicines WHERE salt = $1 AND id != $2 ORDER BY id", [
    med.salt,
    medicineId,
  ])) as Medicine[];
  return Promise.all(subs.map(async (s) => ({ medicine: s, total_free: await totalFreeStock(s.id) })));
}

export async function competingInfo(medicineId: number) {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const row = await queryOne<{ demand: number; events: number }>(
    "SELECT COALESCE(SUM(qty),0)::int AS demand, COUNT(*)::int AS events FROM demand_events WHERE medicine_id = $1 AND created_at >= $2",
    [medicineId, since]
  );
  const active = await queryOne<{ c: number }>(
    "SELECT COUNT(*)::int AS c FROM requests WHERE medicine_id = $1 AND status IN ('Requested','Sourcing','NeedsVerification','PartialOffer','Confirmed','Ready')",
    [medicineId]
  );
  return {
    recent_demand: row ? row.demand : 0,
    recent_events: row ? row.events : 0,
    active_requests: active ? active.c : 0,
    total_free: await totalFreeStock(medicineId),
  };
}

export async function simulateOutbreak(medicineId: number, area = CUSTOMER_LOCATION.area) {
  const rows = Array.from({ length: 8 }, () => [
    medicineId,
    area,
    1,
    new Date(Date.now() - Math.floor(Math.random() * 20) * 60_000).toISOString(),
  ]);
  await withTransaction(async (tx) => {
    for (const p of rows) {
      await tx.run(
        "INSERT INTO demand_events (medicine_id, area, qty, created_at) VALUES ($1, $2, $3, $4)",
        p
      );
    }
  });
  await recordAudit({
    actorRole: "system",
    action: "demo.outbreak",
    entityType: "medicine",
    entityId: medicineId,
    meta: { area },
  });
  return { ok: true };
}

export async function demandByArea() {
  return queryAll(
    "SELECT area, SUM(qty)::int AS demand, COUNT(*)::int AS events FROM demand_events GROUP BY area ORDER BY demand DESC"
  );
}

export async function insights() {
  const lowStock = await queryAll(
    `SELECT i.*, i.qty_total - i.qty_locked AS free, p.name AS pharmacy_name, m.name AS medicine_name
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id JOIN medicines m ON m.id = i.medicine_id
       WHERE i.qty_total - i.qty_locked > 0
         AND (i.expiry_date IS NULL OR i.expiry_date >= ${TODAY_TEXT})
       ORDER BY free ASC LIMIT 50`
  );
  const expiry = await queryAll(
    `SELECT i.*, p.name AS pharmacy_name, m.name AS medicine_name
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id JOIN medicines m ON m.id = i.medicine_id
       WHERE i.expiry_date IS NOT NULL AND i.expiry_date <= (CURRENT_DATE + INTERVAL '60 days')::text
       ORDER BY i.expiry_date ASC`
  );
  const lost = await queryAll(
    `SELECT l.medicine_id, m.name AS medicine_name, SUM(l.qty)::int AS qty, SUM(l.value)::int AS value
       FROM lost_sales l JOIN medicines m ON m.id = l.medicine_id
       GROUP BY l.medicine_id, m.name ORDER BY value DESC`
  );
  const lostTotal = await queryOne<{ total: number }>(
    "SELECT COALESCE(SUM(value),0)::int AS total FROM lost_sales"
  );
  const ledgerTotals = await queryOne<{ wholesale: number; fee: number }>(
    "SELECT COALESCE(SUM(wholesale_amount),0)::int AS wholesale, COALESCE(SUM(platform_fee),0)::int AS fee FROM ledger"
  );
  const perPharmacy = await queryAll(
    `SELECT p.id, p.name, p.fulfilment_count, p.response_score,
        (SELECT COALESCE(SUM(i.qty_total - i.qty_locked),0)::int FROM inventory i WHERE i.pharmacy_id = p.id) AS free_stock
       FROM pharmacies p ORDER BY p.fulfilment_count DESC`
  );
  return {
    lowStock,
    expiry,
    lostSales: { byMedicine: lost, total_value: lostTotal ? lostTotal.total : 0 },
    ledger: ledgerTotals ?? { wholesale: 0, fee: 0 },
    perPharmacy,
    demandByArea: await demandByArea(),
  };
}
