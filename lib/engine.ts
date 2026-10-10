import { randomUUID } from "crypto";
import { getDb, nowIso, getSetting, setSetting } from "./db";
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
}

const LOCK_DEFAULT_SECONDS = 1800; // 30 minutes
export function getLockSeconds(): number {
  const v = getSetting("lock_seconds");
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : LOCK_DEFAULT_SECONDS;
}
export function setLockSeconds(sec: number): void {
  setSetting("lock_seconds", String(Math.max(5, Math.floor(sec))));
}
export function is20sLockEnabled(): boolean {
  return getLockSeconds() === 20;
}

// ---------------------------------------------------------------- reads

export function listPharmacies(): Pharmacy[] {
  return getDb().prepare("SELECT * FROM pharmacies ORDER BY id").all() as Pharmacy[];
}
export function getPharmacy(id: number): Pharmacy | undefined {
  return getDb().prepare("SELECT * FROM pharmacies WHERE id = ?").get(id) as Pharmacy | undefined;
}
export function listMedicines(): Medicine[] {
  return getDb().prepare("SELECT * FROM medicines ORDER BY id").all() as Medicine[];
}
export function getMedicine(id: number): Medicine | undefined {
  return getDb().prepare("SELECT * FROM medicines WHERE id = ?").get(id) as Medicine | undefined;
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
export function availability(medicineId: number) {
  const db = getDb();
  const medicine = getMedicine(medicineId);
  if (!medicine) return null;
  const rows = db
    .prepare(
      `SELECT i.*, i.qty_total - i.qty_locked AS free, p.name AS pharmacy_name, p.verification_status, p.lat, p.lng
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
       WHERE i.medicine_id = ?
         AND i.qty_total - i.qty_locked > 0
         AND (i.expiry_date IS NULL OR i.expiry_date >= date('now'))
       ORDER BY free DESC`
    )
    .all(medicineId) as (StockRow & { pharmacy_name: string; verification_status: string; lat: number; lng: number })[];
  const total_free = rows
    .filter((r) => r.verification_status === "verified")
    .reduce((s, r) => s + r.free, 0);
  return { medicine, total_free, pharmacies: rows };
}

export function totalFreeStock(medicineId: number): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(i.qty_total - i.qty_locked),0) AS total
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
       WHERE i.medicine_id = ? AND p.verification_status = 'verified'
         AND (i.expiry_date IS NULL OR i.expiry_date >= date('now'))`
    )
    .get(medicineId) as { total: number };
  return row.total;
}

export function freeStockAt(pharmacyId: number, medicineId: number): number {
  const row = getDb()
    .prepare(
      `SELECT (qty_total - qty_locked) AS free FROM inventory
       WHERE pharmacy_id = ? AND medicine_id = ?
         AND (expiry_date IS NULL OR expiry_date >= date('now'))`
    )
    .get(pharmacyId, medicineId) as { free: number } | undefined;
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
export function rankPharmacies(
  medicineId: number,
  qty: number,
  origin: { lat: number; lng: number } = CUSTOMER_LOCATION
): Ranked[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.*, i.qty_total - i.qty_locked AS free, i.expiry_date
       FROM pharmacies p JOIN inventory i ON i.pharmacy_id = p.id
       WHERE i.medicine_id = ? AND p.verification_status = 'verified'
         AND i.qty_total - i.qty_locked > 0
         AND (i.expiry_date IS NULL OR i.expiry_date >= date('now'))`
    )
    .all(medicineId) as (Pharmacy & { free: number; expiry_date: string | null })[];
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
    } satisfies Ranked;
  });
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // expiry-aware tie-break: earlier expiring stock first
    const ea = a.expiry ?? "9999-12-31";
    const eb = b.expiry ?? "9999-12-31";
    return ea < eb ? -1 : ea > eb ? 1 : 0;
  });
  return ranked;
}

// ---------------------------------------------------------------- locking

function tryLock(pharmacyId: number, medicineId: number, qty: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE inventory SET qty_locked = qty_locked + ?
       WHERE pharmacy_id = ? AND medicine_id = ?
         AND qty_total - qty_locked >= ?
         AND (expiry_date IS NULL OR expiry_date >= date('now'))`
    )
    .run(qty, pharmacyId, medicineId, qty);
  return info.changes === 1;
}

function releaseLock(pharmacyId: number, medicineId: number, qty: number): void {
  getDb()
    .prepare(
      `UPDATE inventory SET qty_locked = MAX(0, qty_locked - ?)
       WHERE pharmacy_id = ? AND medicine_id = ?`
    )
    .run(qty, pharmacyId, medicineId);
}

// ---------------------------------------------------------------- expire sweep

// Idempotent: releases expired active locks and expires their requests.
export function sweepExpired(): number {
  const db = getDb();
  const now = nowIso();
  const stale = db
    .prepare(
      `SELECT DISTINCT request_id FROM reservations
       WHERE status = 'active' AND lock_expires_at < ?`
    )
    .all(now) as { request_id: number }[];
  let expired = 0;
  for (const { request_id } of stale) {
    const tx = db.transaction(() => {
      const req = db
        .prepare("SELECT status FROM requests WHERE id = ?")
        .get(request_id) as { status: string } | undefined;
      if (!req) return;
      if ([REQUEST_STATUS.COMPLETED, REQUEST_STATUS.CANCELLED, REQUEST_STATUS.REJECTED, REQUEST_STATUS.EXPIRED].includes(req.status as never))
        return;
      const active = db
        .prepare("SELECT * FROM reservations WHERE request_id = ? AND status = 'active'")
        .all(request_id) as { id: number; pharmacy_id: number; qty: number; medicine_id?: number }[];
      const medRow = db
        .prepare("SELECT medicine_id FROM requests WHERE id = ?")
        .get(request_id) as { medicine_id: number };
      for (const r of active) {
        releaseLock(r.pharmacy_id, medRow.medicine_id, r.qty);
        db.prepare("UPDATE reservations SET status = 'expired' WHERE id = ?").run(r.id);
      }
      db.prepare("UPDATE requests SET status = ?, secured_qty = 0 WHERE id = ?").run(
        REQUEST_STATUS.EXPIRED,
        request_id
      );
      publish(channels.request(request_id), { type: "request", requestId: request_id, status: REQUEST_STATUS.EXPIRED });
      expired++;
    });
    tx();
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
  idempotencyKey?: string;
}

export function createRequest(input: CreateRequestInput) {
  const db = getDb();
  if (input.idempotencyKey) {
    const existing = db
      .prepare("SELECT id FROM requests WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as { id: number } | undefined;
    if (existing) return { requestId: existing.id, created: false };
  }
  const medicine = getMedicine(input.medicineId);
  if (!medicine) throw new Error("Unknown medicine");
  const qty = Math.max(1, Math.min(50, Math.floor(input.qty)));

  let requestId = 0;
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO requests (customer_id, customer_name, medicine_id, qty, preferred_pharmacy_id,
           fulfilment_type, delivery_address, delivery_lat, delivery_lng, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.customerId,
        input.customerName,
        input.medicineId,
        qty,
        input.fulfilmentType,
        input.deliveryAddress ?? null,
        input.deliveryLat ?? null,
        input.deliveryLng ?? null,
        REQUEST_STATUS.REQUESTED,
        input.idempotencyKey ?? randomUUID(),
        nowIso()
      );
    requestId = Number(info.lastInsertRowid);
    db.prepare(
      "INSERT INTO demand_events (medicine_id, area, qty, created_at) VALUES (?, ?, ?, ?)"
    ).run(input.medicineId, input.area ?? CUSTOMER_LOCATION.area, qty, nowIso());
  });
  tx();

  sourceRequest(requestId);
  return { requestId, created: true };
}

// Distributes locked stock across ranked pharmacies. Idempotent-ish: only runs
// from a Requested state.
export function sourceRequest(requestId: number) {
  const db = getDb();
  const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as
    | {
        id: number;
        medicine_id: number;
        qty: number;
        status: string;
        fulfilment_type: string;
        delivery_lat: number | null;
        delivery_lng: number | null;
      }
    | undefined;
  if (!req || req.status !== REQUEST_STATUS.REQUESTED) return;
  const medicine = getMedicine(req.medicine_id)!;
  const origin =
    req.fulfilment_type === "delivery" && req.delivery_lat != null && req.delivery_lng != null
      ? { lat: req.delivery_lat, lng: req.delivery_lng }
      : CUSTOMER_LOCATION;

  const ranked = rankPharmacies(req.medicine_id, req.qty, origin);
  const lockSeconds = getLockSeconds();
  const expires = new Date(Date.now() + lockSeconds * 1000).toISOString();

  let needed = req.qty;
  let secured = 0;
  let preferred: number | null = null;
  let preferredQty = 0;

  const tx = db.transaction(() => {
    for (const r of ranked) {
      if (needed <= 0) break;
      const take = Math.min(needed, r.free);
      if (take <= 0) continue;
      if (!tryLock(r.pharmacy.id, req.medicine_id, take)) continue;
      db.prepare(
        `INSERT INTO reservations (request_id, pharmacy_id, qty, lock_expires_at, status, kind, created_at)
         VALUES (?, ?, ?, ?, 'active', 'primary', ?)`
      ).run(requestId, r.pharmacy.id, take, expires, nowIso());
      needed -= take;
      secured += take;
      if (take > preferredQty) {
        preferredQty = take;
        preferred = r.pharmacy.id;
      }
    }

    let status: string;
    if (secured === 0) {
      status = REQUEST_STATUS.UNAVAILABLE;
      db.prepare(
        "INSERT INTO lost_sales (medicine_id, pharmacy_id, qty, value, created_at) VALUES (?, NULL, ?, ?, ?)"
      ).run(req.medicine_id, req.qty, medicine.price_paise * req.qty, nowIso());
    } else if (secured < req.qty) {
      status = REQUEST_STATUS.PARTIAL;
    } else {
      status = medicine.rx_required ? REQUEST_STATUS.NEEDS_VERIFICATION : REQUEST_STATUS.SOURCING;
    }
    db.prepare("UPDATE requests SET status = ?, secured_qty = ?, preferred_pharmacy_id = ? WHERE id = ?").run(
      status,
      secured,
      preferred,
      requestId
    );
  });
  tx();

  const updated = db.prepare("SELECT status FROM requests WHERE id = ?").get(requestId) as {
    status: string;
  };
  publish(channels.request(requestId), { type: "request", requestId, status: updated.status });
  if (preferred) publish(channels.pharmacy(preferred), { type: "request", requestId, status: updated.status });
}

// ---------------------------------------------------------------- actions

export function verifyRx(requestId: number, actor: { userId: number; role: string }) {
  const db = getDb();
  const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as
    | { status: string; medicine_id: number }
    | undefined;
  if (!req) return { ok: false, reason: "Not found" };
  if (![REQUEST_STATUS.NEEDS_VERIFICATION, REQUEST_STATUS.SOURCING].includes(req.status as never))
    return { ok: false, reason: "Not awaiting verification" };
  db.prepare("UPDATE requests SET rx_verified = 1, rx_verified_by = ? WHERE id = ?").run(
    actor.userId,
    requestId
  );
  if (req.status === REQUEST_STATUS.NEEDS_VERIFICATION) {
    db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(REQUEST_STATUS.SOURCING, requestId);
    publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.SOURCING });
  }
  recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "request.rx_verified", entityType: "request", entityId: requestId });
  return { ok: true };
}

export function confirmRequest(requestId: number, actor: { userId: number; role: string }) {
  const db = getDb();
  const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as
    | { status: string; medicine_id: number; preferred_pharmacy_id: number; rx_verified: number; secured_qty: number; fulfilment_type: string }
    | undefined;
  if (!req) return { ok: false, reason: "Not found" };
  if (![REQUEST_STATUS.SOURCING, REQUEST_STATUS.NEEDS_VERIFICATION, REQUEST_STATUS.PARTIAL].includes(req.status as never))
    return { ok: false, reason: `Cannot confirm from ${req.status}` };
  if (actor.role !== "admin") {
    const user = db.prepare("SELECT pharmacy_id FROM users WHERE id = ?").get(actor.userId) as
      | { pharmacy_id: number | null }
      | undefined;
    if (!user || user.pharmacy_id !== req.preferred_pharmacy_id)
      return { ok: false, reason: "Not your pharmacy" };
  }
  const medicine = getMedicine(req.medicine_id)!;
  if (medicine.rx_required && !req.rx_verified)
    return { ok: false, reason: "Prescription must be verified first" };

  const now = nowIso();
  const tx = db.transaction(() => {
    const reservations = db
      .prepare("SELECT * FROM reservations WHERE request_id = ? AND status = 'active'")
      .all(requestId) as { id: number; pharmacy_id: number; qty: number; kind: string }[];
    for (const r of reservations) {
      if (r.pharmacy_id === req.preferred_pharmacy_id) {
        db.prepare("UPDATE reservations SET status = 'confirmed' WHERE id = ?").run(r.id);
      } else {
        // Borrowed units: recorded in the ledger and removed from the source store.
        const wholesale = Math.round(medicine.price_paise * r.qty * WHOLESALE_RATE);
        const fee = Math.round(medicine.price_paise * r.qty * PLATFORM_FEE_RATE);
        db.prepare(
          `INSERT INTO ledger (request_id, from_pharmacy_id, to_pharmacy_id, medicine_id, qty,
             wholesale_amount, platform_fee, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(requestId, r.pharmacy_id, req.preferred_pharmacy_id, req.medicine_id, r.qty, wholesale, fee, now);
        db.prepare("UPDATE inventory SET qty_total = MAX(qty_locked, qty_total - ?), qty_locked = MAX(0, qty_locked - ?) WHERE pharmacy_id = ? AND medicine_id = ?").run(
          r.qty,
          r.qty,
          r.pharmacy_id,
          req.medicine_id
        );
        db.prepare("UPDATE reservations SET status = 'borrowed' WHERE id = ?").run(r.id);
      }
    }
    db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(REQUEST_STATUS.CONFIRMED, requestId);
  });
  tx();
  recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "request.confirmed", entityType: "request", entityId: requestId });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.CONFIRMED });
  publish(channels.pharmacy(req.preferred_pharmacy_id), { type: "request", requestId, status: REQUEST_STATUS.CONFIRMED });
  return { ok: true };
}

export function rejectRequest(requestId: number, actor: { userId: number; role: string }, reason?: string) {
  const db = getDb();
  const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as
    | { status: string; medicine_id: number; preferred_pharmacy_id: number }
    | undefined;
  if (!req) return { ok: false, reason: "Not found" };
  if (actor.role !== "admin") {
    const user = db.prepare("SELECT pharmacy_id FROM users WHERE id = ?").get(actor.userId) as
      | { pharmacy_id: number | null }
      | undefined;
    if (!user || user.pharmacy_id !== req.preferred_pharmacy_id)
      return { ok: false, reason: "Not your pharmacy" };
  }
  const tx = db.transaction(() => {
    const active = db
      .prepare("SELECT * FROM reservations WHERE request_id = ? AND status = 'active'")
      .all(requestId) as { id: number; pharmacy_id: number; qty: number }[];
    for (const r of active) {
      releaseLock(r.pharmacy_id, req.medicine_id, r.qty);
      db.prepare("UPDATE reservations SET status = 'rejected' WHERE id = ?").run(r.id);
    }
    db.prepare("UPDATE requests SET status = ?, secured_qty = 0 WHERE id = ?").run(REQUEST_STATUS.REJECTED, requestId);
  });
  tx();
  recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "request.rejected", entityType: "request", entityId: requestId, meta: reason ? { reason } : undefined });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.REJECTED });
  return { ok: true };
}

export function markReady(requestId: number, actor: { userId: number; role: string }) {
  const db = getDb();
  const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as
    | { status: string; fulfilment_type: string; preferred_pharmacy_id: number }
    | undefined;
  if (!req) return { ok: false, reason: "Not found" };
  if (req.status !== REQUEST_STATUS.CONFIRMED) return { ok: false, reason: `Cannot ready from ${req.status}` };
  if (actor.role !== "admin") {
    const user = db.prepare("SELECT pharmacy_id FROM users WHERE id = ?").get(actor.userId) as
      | { pharmacy_id: number | null }
      | undefined;
    if (!user || user.pharmacy_id !== req.preferred_pharmacy_id)
      return { ok: false, reason: "Not your pharmacy" };
  }
  db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(REQUEST_STATUS.READY, requestId);
  recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "request.ready", entityType: "request", entityId: requestId });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.READY });
  publish(channels.pharmacy(req.preferred_pharmacy_id), { type: "request", requestId, status: REQUEST_STATUS.READY });

  let deliveryId: number | null = null;
  if (req.fulfilment_type === "delivery") {
    const d = createDeliveryForRequest(requestId);
    deliveryId = d ? d.id : null;
  }
  return { ok: true, deliveryId };
}

export function completeRequest(requestId: number, actor: { userId: number; role: string }) {
  const db = getDb();
  const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as
    | { status: string; medicine_id: number; preferred_pharmacy_id: number; secured_qty: number; fulfilment_type: string; customer_id: number | null }
    | undefined;
  if (!req) return { ok: false, reason: "Not found" };
  if (![REQUEST_STATUS.READY, REQUEST_STATUS.CONFIRMED].includes(req.status as never))
    return { ok: false, reason: `Cannot complete from ${req.status}` };
  if (actor.role === "customer" && req.customer_id !== actor.userId)
    return { ok: false, reason: "Not your request" };

  const tx = db.transaction(() => {
    const confirmed = db
      .prepare("SELECT * FROM reservations WHERE request_id = ? AND status IN ('confirmed','active')")
      .all(requestId) as { id: number; pharmacy_id: number; qty: number }[];
    for (const r of confirmed) {
      db.prepare(
        "UPDATE inventory SET qty_total = MAX(0, qty_total - ?), qty_locked = MAX(0, qty_locked - ?) WHERE pharmacy_id = ? AND medicine_id = ?"
      ).run(r.qty, r.qty, r.pharmacy_id, req.medicine_id);
      db.prepare("UPDATE reservations SET status = 'completed' WHERE id = ?").run(r.id);
    }
    db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(REQUEST_STATUS.COMPLETED, requestId);
    if (req.preferred_pharmacy_id) {
      db.prepare("UPDATE pharmacies SET fulfilment_count = fulfilment_count + 1 WHERE id = ?").run(
        req.preferred_pharmacy_id
      );
    }
  });
  tx();
  recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "request.completed", entityType: "request", entityId: requestId });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.COMPLETED });
  if (req.preferred_pharmacy_id) publish(channels.pharmacy(req.preferred_pharmacy_id), { type: "request", requestId, status: REQUEST_STATUS.COMPLETED });
  return { ok: true };
}

export function cancelRequest(requestId: number, actor: { userId: number; role: string }) {
  const db = getDb();
  const req = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as
    | { status: string; medicine_id: number; customer_id: number | null }
    | undefined;
  if (!req) return { ok: false, reason: "Not found" };
  if (actor.role === "customer" && req.customer_id !== actor.userId)
    return { ok: false, reason: "Not your request" };
  if ([REQUEST_STATUS.COMPLETED, REQUEST_STATUS.CANCELLED].includes(req.status as never))
    return { ok: false, reason: "Already final" };
  const tx = db.transaction(() => {
    const active = db
      .prepare("SELECT * FROM reservations WHERE request_id = ? AND status IN ('active','confirmed')")
      .all(requestId) as { id: number; pharmacy_id: number; qty: number }[];
    for (const r of active) {
      releaseLock(r.pharmacy_id, req.medicine_id, r.qty);
      db.prepare("UPDATE reservations SET status = 'cancelled' WHERE id = ?").run(r.id);
    }
    db.prepare("UPDATE requests SET status = ? WHERE id = ?").run(REQUEST_STATUS.CANCELLED, requestId);
  });
  tx();
  recordAudit({ actorUserId: actor.userId, actorRole: actor.role, action: "request.cancelled", entityType: "request", entityId: requestId });
  publish(channels.request(requestId), { type: "request", requestId, status: REQUEST_STATUS.CANCELLED });
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
  created_at: string;
}

export function getRequestDetail(requestId: number) {
  const db = getDb();
  const request = db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as
    | RequestRow
    | undefined;
  if (!request) return null;
  const medicine = getMedicine(request.medicine_id);
  const pharmacy = request.preferred_pharmacy_id ? getPharmacy(request.preferred_pharmacy_id) : null;
  const reservations = db
    .prepare(
      "SELECT res.*, p.name AS pharmacy_name FROM reservations res JOIN pharmacies p ON p.id = res.pharmacy_id WHERE res.request_id = ? ORDER BY res.id"
    )
    .all(requestId);
  const delivery = getDeliveryForRequest(requestId) ?? null;
  return { request, medicine, pharmacy, reservations, delivery };
}

export function listRequests(filter: { customerId?: number; pharmacyId?: number; status?: string; limit?: number } = {}) {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.customerId) {
    where.push("r.customer_id = ?");
    params.push(filter.customerId);
  }
  if (filter.pharmacyId) {
    where.push("r.preferred_pharmacy_id = ?");
    params.push(filter.pharmacyId);
  }
  if (filter.status) {
    where.push("r.status = ?");
    params.push(filter.status);
  }
  const sql = `SELECT r.*, m.name AS medicine_name, p.name AS pharmacy_name
    FROM requests r JOIN medicines m ON m.id = r.medicine_id
    LEFT JOIN pharmacies p ON p.id = r.preferred_pharmacy_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY r.id DESC LIMIT ?`;
  return db.prepare(sql).all(...params, Math.min(filter.limit ?? 100, 300));
}

export function listLedger(pharmacyId?: number) {
  const db = getDb();
  if (pharmacyId) {
    return db
      .prepare(
        `SELECT l.*, m.name AS medicine_name, f.name AS from_name, t.name AS to_name
         FROM ledger l JOIN medicines m ON m.id = l.medicine_id
         JOIN pharmacies f ON f.id = l.from_pharmacy_id JOIN pharmacies t ON t.id = l.to_pharmacy_id
         WHERE l.from_pharmacy_id = ? OR l.to_pharmacy_id = ? ORDER BY l.id DESC LIMIT 100`
      )
      .all(pharmacyId, pharmacyId);
  }
  return db
    .prepare(
      `SELECT l.*, m.name AS medicine_name, f.name AS from_name, t.name AS to_name
       FROM ledger l JOIN medicines m ON m.id = l.medicine_id
       JOIN pharmacies f ON f.id = l.from_pharmacy_id JOIN pharmacies t ON t.id = l.to_pharmacy_id
       ORDER BY l.id DESC LIMIT 100`
    )
    .all();
}

export function findSubstitutes(medicineId: number) {
  const db = getDb();
  const med = getMedicine(medicineId);
  if (!med) return [];
  const subs = db
    .prepare("SELECT * FROM medicines WHERE salt = ? AND id != ? ORDER BY id")
    .all(med.salt, medicineId) as Medicine[];
  return subs.map((s) => ({ medicine: s, total_free: totalFreeStock(s.id) }));
}

export function competingInfo(medicineId: number) {
  const db = getDb();
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const row = db
    .prepare("SELECT COALESCE(SUM(qty),0) AS demand, COUNT(*) AS events FROM demand_events WHERE medicine_id = ? AND created_at >= ?")
    .get(medicineId, since) as { demand: number; events: number };
  const active = db
    .prepare("SELECT COUNT(*) AS c FROM requests WHERE medicine_id = ? AND status IN ('Requested','Sourcing','NeedsVerification','PartialOffer','Confirmed','Ready')")
    .get(medicineId) as { c: number };
  return { recent_demand: row.demand, recent_events: row.events, active_requests: active.c, total_free: totalFreeStock(medicineId) };
}

export function simulateOutbreak(medicineId: number, area = CUSTOMER_LOCATION.area) {
  const db = getDb();
  const tx = db.transaction(() => {
    for (let i = 0; i < 8; i++) {
      db.prepare("INSERT INTO demand_events (medicine_id, area, qty, created_at) VALUES (?, ?, ?, ?)").run(
        medicineId,
        area,
        1,
        new Date(Date.now() - Math.floor(Math.random() * 20) * 60_000).toISOString()
      );
    }
  });
  tx();
  recordAudit({ actorRole: "system", action: "demo.outbreak", entityType: "medicine", entityId: medicineId, meta: { area } });
  return { ok: true };
}

export function demandByArea() {
  const db = getDb();
  return db
    .prepare("SELECT area, SUM(qty) AS demand, COUNT(*) AS events FROM demand_events GROUP BY area ORDER BY demand DESC")
    .all();
}

export function insights() {
  const db = getDb();
  const lowStock = db
    .prepare(
      `SELECT i.pharmacy_id, p.name AS pharmacy_name, i.medicine_id, m.name AS medicine_name,
              i.qty_total - i.qty_locked AS free, i.qty_total
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id JOIN medicines m ON m.id = i.medicine_id
       WHERE i.qty_total - i.qty_locked <= 2 AND i.qty_total > 0
       ORDER BY free ASC LIMIT 20`
    )
    .all();
  const expiry = db
    .prepare(
      `SELECT i.pharmacy_id, p.name AS pharmacy_name, i.medicine_id, m.name AS medicine_name,
              i.expiry_date, i.qty_total
       FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id JOIN medicines m ON m.id = i.medicine_id
       WHERE i.expiry_date IS NOT NULL AND i.expiry_date <= date('now','+90 day')
       ORDER BY i.expiry_date ASC LIMIT 20`
    )
    .all();
  const lost = db
    .prepare(
      `SELECT l.medicine_id, m.name AS medicine_name, SUM(l.qty) AS qty, SUM(l.value) AS value
       FROM lost_sales l JOIN medicines m ON m.id = l.medicine_id
       GROUP BY l.medicine_id ORDER BY value DESC`
    )
    .all();
  const lostTotal = db.prepare("SELECT COALESCE(SUM(value),0) AS total FROM lost_sales").get() as { total: number };
  const ledgerTotals = db
    .prepare("SELECT COALESCE(SUM(wholesale_amount),0) AS wholesale, COALESCE(SUM(platform_fee),0) AS fee FROM ledger")
    .get() as { wholesale: number; fee: number };
  const perPharmacy = db
    .prepare(
      `SELECT p.id, p.name, p.fulfilment_count, p.response_score,
        (SELECT COALESCE(SUM(i.qty_total - i.qty_locked),0) FROM inventory i WHERE i.pharmacy_id = p.id) AS free_stock
       FROM pharmacies p ORDER BY p.fulfilment_count DESC`
    )
    .all();
  return {
    lowStock,
    expiry,
    lostSales: { byMedicine: lost, total_value: lostTotal.total },
    ledger: ledgerTotals,
    perPharmacy,
    demandByArea: demandByArea(),
  };
}
