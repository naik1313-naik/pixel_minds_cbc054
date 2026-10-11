import type { NextRequest } from "next/server";
import { z } from "zod";
import { queryReturning, nowIso } from "@/lib/db";
import { registerUser } from "@/lib/auth";
import {
  registerCustomerSchema,
  registerPharmacySchema,
  registerRiderSchema,
} from "@/lib/validation";
import { json, error, clientIp, sameOrigin } from "@/lib/api-utils";
import { recordAudit } from "@/lib/audit";
import { getIdentityProvider } from "@/lib/providers";
import type { DocumentCheck } from "@/lib/identity";

const bodySchema = z.discriminatedUnion("role", [
  registerCustomerSchema.extend({ role: z.literal("customer") }),
  registerPharmacySchema.extend({ role: z.literal("pharmacy_owner") }),
  registerRiderSchema.extend({ role: z.literal("delivery_partner") }),
]);

function docSummary(check: DocumentCheck) {
  return {
    type: check.kind,
    masked: check.masked,
    valid: check.status === "verified",
    status: check.status,
    reference: check.reference,
    reasons: check.reasons,
  };
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return error(403, "Cross-origin request blocked");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "Invalid JSON");
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return error(400, parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const data = parsed.data;
  const ip = clientIp(req);
  const identity = getIdentityProvider();

  let pharmacyId: number | undefined;
  let licenceCheck: DocumentCheck | undefined;
  if (data.role === "pharmacy_owner") {
    // Verify the drug licence before the pharmacy row is created.
    licenceCheck = await identity.verify({ type: "DRUG_LICENCE", number: data.licence, name: data.name });
    if (licenceCheck.status === "invalid" || licenceCheck.status === "format_error") {
      return error(400, `Drug licence failed verification: ${licenceCheck.reasons[0] ?? "invalid number"}`, {
        doc: docSummary(licenceCheck),
      });
    }
    const row = await queryReturning<{ id: number }>(
      `INSERT INTO pharmacies (name, address, lat, lng, drug_licence_no, verification_status, response_score, fulfilment_count, licence_verified, licence_checked_at, licence_meta_json, created_at)
         VALUES ($1, $2, $3, $4, $5, 'verified', 0.8, 0, $6, $7, $8, $9)
         RETURNING id`,
      [
        data.pharmacyName,
        data.address,
        data.lat,
        data.lng,
        licenceCheck.normalized,
        licenceCheck.status,
        nowIso(),
        JSON.stringify({
          masked: licenceCheck.masked,
          reference: licenceCheck.reference,
          reasons: licenceCheck.reasons,
        }),
        nowIso(),
      ]
    );
    pharmacyId = row?.id;
  }

  const result = await registerUser({
    email: data.email,
    name: data.name,
    phone: data.phone,
    password: data.password,
    role: data.role,
    pharmacyId,
    vehicle: data.role === "delivery_partner" ? data.vehicle : undefined,
    idType: data.role === "delivery_partner" ? data.idType : undefined,
    idNumber: data.role === "delivery_partner" ? data.idNumber : undefined,
  });

  if (!result.ok) {
    return error(400, result.reason ?? "Registration failed", {
      issues: result.issues,
      doc: result.docCheck ? docSummary(result.docCheck) : undefined,
    });
  }
  await recordAudit({
    actorUserId: result.userId,
    actorRole: data.role,
    action: "auth.register",
    entityType: "user",
    entityId: result.userId,
    ip,
    meta: pharmacyId ? { pharmacyId } : undefined,
  });
  const check = licenceCheck ?? result.docCheck;
  return json({
    ok: true,
    role: data.role,
    pending: false,
    doc: check ? docSummary(check) : undefined,
    message:
      data.role === "customer"
        ? "Account created. You can sign in."
        : data.role === "pharmacy_owner"
          ? "Pharmacy registered and approved. Your documents passed automated checks — you can sign in now."
          : "You're verified as a delivery partner. You can sign in and go online now.",
  });
}
