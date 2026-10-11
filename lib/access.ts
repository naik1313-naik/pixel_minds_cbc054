import { queryOne } from "./db";
import type { DbUser } from "./auth";

export interface RequestAccessRow {
  id?: number;
  customer_id: number | null;
  preferred_pharmacy_id: number | null;
}

export async function canViewRequest(user: DbUser, request: RequestAccessRow): Promise<boolean> {
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

async function hasDeliveryAssignment(partnerId: number, request: { id?: number }): Promise<boolean> {
  if (!request.id) return false;
  const row = await queryOne<{ ok: number }>(
    "SELECT 1 AS ok FROM deliveries WHERE request_id = $1 AND partner_id = $2",
    [request.id, partnerId]
  );
  return !!row;
}

export async function canViewDelivery(
  user: DbUser,
  delivery: { partner_id: number | null; pharmacy_id: number; request_id: number }
): Promise<boolean> {
  if (user.role === "admin") return true;
  if (user.role === "delivery_partner") return delivery.partner_id === user.id;
  if (user.role === "pharmacy_owner" || user.role === "pharmacy_staff")
    return delivery.pharmacy_id === user.pharmacy_id;
  if (user.role === "customer") {
    const row = await queryOne<{ customer_id: number | null }>(
      "SELECT customer_id FROM requests WHERE id = $1",
      [delivery.request_id]
    );
    return row?.customer_id === user.id;
  }
  return false;
}
