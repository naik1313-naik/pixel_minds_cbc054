import type { NextRequest } from "next/server";
import { guard, json, error } from "@/lib/api-utils";
import { canViewRequest } from "@/lib/access";
import { getRequestDetail } from "@/lib/engine";
import { maskPhone } from "@/lib/delivery";
import { queryOne } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { z } from "zod";

export const runtime = "nodejs";

const revealSchema = z.object({ reveal: z.literal(true) });

/**
 * Contact details for the rider carrying an order.
 *
 * The rider's phone number is withheld by default. A delivery needs the rider and
 * the customer to be able to reach each other — a locked parcel on a wrong
 * landing is exactly the failure this app exists to prevent — but "you can call
 * them" is not a reason for the number to sit in every payload the page loads.
 *
 * So: masked until asked for, revealed only to the customer who placed the order
 * (or the fulfilling pharmacy / an admin), only once a rider is actually
 * assigned, and every reveal is written to the audit log. That way the log shows
 * exactly which numbers were disclosed and when.
 */
export const GET = guard(null, async (ctx, _req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const detail = await getRequestDetail(id);
  if (!detail) return error(404, "Request not found");
  if (!(await canViewRequest(ctx.user, { ...detail.request, id })))
    return error(403, "Forbidden");

  // Only the ordering customer, the fulfilling pharmacy and admins get this.
  const isCustomer = ctx.user.role === "customer" && detail.request.customer_id === ctx.user.id;
  const isPharmacy =
    (ctx.user.role === "pharmacy_owner" || ctx.user.role === "pharmacy_staff") &&
    detail.request.preferred_pharmacy_id === ctx.user.pharmacy_id;
  const isAdmin = ctx.user.role === "admin";
  if (!isCustomer && !isPharmacy && !isAdmin) return error(403, "Forbidden");

  const rider = await queryOne<{ name: string; phone: string | null; vehicle_number: string | null }>(
    `SELECT u.name, u.phone, u.vehicle_number
       FROM deliveries d JOIN users u ON u.id = d.partner_id
      WHERE d.request_id = $1`,
    [id]
  );
  if (!rider) {
    // Nothing to hide, and an honest reason rather than an empty card.
    return json({ available: false, reason: "No rider is assigned to this order yet" });
  }

  return json({
    available: true,
    riderName: rider.name,
    vehicleNumber: rider.vehicle_number,
    phoneMasked: maskPhone(rider.phone),
    // The customer should know whose number they are about to call.
    pharmacyName: detail.pharmacy?.name ?? null,
  });
});

/** Releases the full number. Audited. */
export const POST = guard(["customer", "pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, req: NextRequest, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return error(400, "Invalid id");
  const body = await req.json().catch(() => null);
  if (!revealSchema.safeParse(body).success) return error(400, "Invalid input");

  const detail = await getRequestDetail(id);
  if (!detail) return error(404, "Request not found");
  if (!(await canViewRequest(ctx.user, { ...detail.request, id })))
    return error(403, "Forbidden");
  const isCustomer = ctx.user.role === "customer" && detail.request.customer_id === ctx.user.id;
  const isPharmacy =
    (ctx.user.role === "pharmacy_owner" || ctx.user.role === "pharmacy_staff") &&
    detail.request.preferred_pharmacy_id === ctx.user.pharmacy_id;
  if (!isCustomer && !isPharmacy && ctx.user.role !== "admin") return error(403, "Forbidden");

  const rider = await queryOne<{ id: number; name: string; phone: string | null }>(
    `SELECT u.id, u.name, u.phone
       FROM deliveries d JOIN users u ON u.id = d.partner_id
      WHERE d.request_id = $1`,
    [id]
  );
  if (!rider) return error(409, "No rider is assigned to this order yet");
  if (!rider.phone) return error(409, "This rider has no phone number on file");

  await recordAudit({
    actorUserId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "contact.phone_revealed",
    entityType: "request",
    entityId: id,
    meta: { riderId: rider.id, riderName: rider.name },
  });

  return json({
    available: true,
    riderName: rider.name,
    phone: rider.phone,
    phoneMasked: maskPhone(rider.phone),
  });
});