import { guard, json } from "@/lib/api-utils";
import { queryAll } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Every order in the network, with the three parties attached.
 *
 * One query rather than three tabs: the question an operator actually asks is
 * "who ordered this, which pharmacy is fulfilling it, and which rider is carrying
 * it", and that answer only exists as a join. Splitting it across the pharmacy
 * and partner tabs makes the person a delivery is stuck on invisible.
 *
 * Customer contact details are intentionally absent here — an operator needs to
 * resolve an order, not to browse the patient list. Phone numbers are released
 * only through the contact flow, which logs it.
 */
export const GET = guard(["admin"], async () => {
  const orders = await queryAll(
    `SELECT
        r.id                AS request_id,
        r.status           AS request_status,
        r.fulfilment_type,
        r.qty,
        r.created_at,
        r.customer_id,
        r.customer_name,
        r.amount_paise,
        r.payment_status,
        m.name             AS medicine_name,
        m.rx_required,
        p.id               AS pharmacy_id,
        p.name             AS pharmacy_name,
        d.id               AS delivery_id,
        d.status           AS delivery_status,
        d.assigned_at,
        d.picked_up_at,
        d.delivered_at,
        d.distance_km,
        d.eta_minutes,
        u.id               AS partner_id,
        u.name             AS partner_name,
        u.vehicle_number,
        pay.status         AS payment_status_detail,
        pay.pharmacy_amount_paise,
        pa.settlement_ref,
        pa.block_number
      FROM requests r
      LEFT JOIN medicines m  ON m.id = r.medicine_id
      LEFT JOIN pharmacies p ON p.id = r.preferred_pharmacy_id
      LEFT JOIN deliveries d ON d.request_id = r.id
      LEFT JOIN users u      ON u.id = d.partner_id
      LEFT JOIN payments pay ON pay.request_id = r.id
      LEFT JOIN payment_audit pa ON pa.payment_id = pay.id
      ORDER BY r.id DESC
      LIMIT 300`
  );
  return json({ orders });
});