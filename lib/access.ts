import { getDb } from "./db";
import type { DbUser } from "./auth";

export interface RequestAccessRow {
  id?: number;
  customer_id: number | null;
  preferred_pharmacy_id: number | null;
}

export function canViewRequest(user: DbUser, request: RequestAccessRow): boolean {
  if (user.role === "admin") return true;
  if (user.role === "customer") return request.customer_id === user.id;
  if (user.role === "pharmacy_owner" || user.role === "pharmacy_staff") {
    return request.preferred_pharmacy_id != null && request.preferred_pharmacy_id === user.pharmacy_id;
  }
  if (user.role === "delivery_partner") {
    return hasDeliveryAssignment(user.id, request);
  }
  return false;
}

function hasDeliveryAssignment(partnerId: number, request: { id?: number }): boolean {
  if (!request.id) return false;
  const row = getDb()
    .prepare("SELECT 1 AS ok FROM deliveries WHERE request_id = ? AND partner_id = ?")
    .get(request.id, partnerId) as { ok: number } | undefined;
  return !!row;
}

export function canViewDelivery(user: DbUser, delivery: { partner_id: number | null; pharmacy_id: number; request_id: number }): boolean {
  if (user.role === "admin") return true;
  if (user.role === "delivery_partner") return delivery.partner_id === user.id;
  if (user.role === "pharmacy_owner" || user.role === "pharmacy_staff") return delivery.pharmacy_id === user.pharmacy_id;
  if (user.role === "customer") {
    const row = getDb()
      .prepare("SELECT customer_id FROM requests WHERE id = ?")
      .get(delivery.request_id) as { customer_id: number | null } | undefined;
    return row?.customer_id === user.id;
  }
  return false;
}
