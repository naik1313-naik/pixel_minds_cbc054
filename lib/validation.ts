import { z } from "zod";

/**
 * Minimum accepted password length.
 *
 * It lives here, not in lib/password.ts, because this module is imported by the
 * sign-up form in the browser and lib/password.ts pulls in argon2 — a native
 * server-only binding. Importing the constant from there broke the registration
 * page with a 500.
 *
 * Short enough to be memorable for a demonstration account, but the length rule
 * is not the only thing standing between an attacker and an account: mixed case,
 * a digit, a symbol, a common-password blocklist and per-account lockout after
 * repeated failures all still apply.
 */
export const MIN_PASSWORD_LENGTH = 6;

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(200);

export const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  code: z.string().max(64).optional(),
});

export const registerCustomerSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(2).max(80),
  phone: z.string().min(8).max(20).optional(),
  password: passwordSchema,
});

export const registerPharmacySchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(2).max(80),
  phone: z.string().min(8).max(20),
  password: passwordSchema,
  pharmacyName: z.string().min(2).max(120),
  address: z.string().min(4).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  licence: z.string().min(4).max(60),
});

export const registerRiderSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(2).max(80),
  phone: z.string().min(8).max(20),
  password: passwordSchema,
  vehicle: z.string().min(3).max(40),
  idType: z.string().min(2).max(20),
  idNumber: z.string().min(4).max(40),
});

export const identityVerifySchema = z.object({
  idType: z.string().min(2).max(20),
  idNumber: z.string().min(4).max(40),
  name: z.string().max(80).optional(),
});

export const createRequestSchema = z.object({
  medicineId: z.number().int().positive(),
  qty: z.number().int().min(1).max(50),
  fulfilmentType: z.enum(["pickup", "delivery"]).default("pickup"),
  // Customer's explicit pharmacy choice. The request is routed to this
  // pharmacy's owner instead of being auto-ranked across the network.
  preferredPharmacyId: z.number().int().positive().optional(),
  deliveryAddress: z.string().max(200).optional(),
  deliveryLat: z.number().min(-90).max(90).optional(),
  deliveryLng: z.number().min(-180).max(180).optional(),
});

export const inventoryUpdateSchema = z.object({
  medicineId: z.number().int().positive(),
  qtyTotal: z.number().int().min(0).max(100000),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const inventoryDeleteSchema = z.object({
  medicineId: z.number().int().positive(),
});

// ---------------------------------------------------------------- blockchain
// Mirrors the MedMeshLedger contract constraints. Non-sensitive fields only:
// customer PII is never accepted into a batch or transfer.

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date");

export const batchRegisterSchema = z.object({
  medicineId: z.number().int().positive(),
  quantityUnits: z.number().int().min(1).max(100000),
  expiryDate: dateString,
  manufacturedAt: dateString,
  supplierRef: z
    .string()
    .min(2, "Supplier reference is required")
    .max(64)
    .regex(/^[A-Za-z0-9\-_/.]+$/, "Use letters, digits, - _ / . only"),
});

export const transferInitiateSchema = z.object({
  batchId: z.number().int().positive(),
  fromPharmacyId: z.number().int().positive(),
  toPharmacyId: z.number().int().positive(),
  quantity: z.number().int().min(1, "Quantity must be greater than zero").max(100000),
});

export const transferSettleSchema = z.object({
  reason: z.string().max(200).optional(),
});

/** Milestones mirror MediMeshLedger.Milestone exactly. */
export const deliveryMilestoneSchema = z.object({
  milestone: z.enum(["Packed", "PickedUp", "OutForDelivery", "Delivered"]),
});

export const reconcileSchema = z.object({
  confirm: z.boolean().optional(),
});

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(-360).max(360).optional(),
  speed: z.number().min(0).max(200).optional(),
});

export const handoverSchema = z.object({
  otp: z.string().min(4).max(16),
  idChecked: z.boolean().optional().default(false),
});

export const transitionSchema = z.object({
  status: z.string().min(2).max(40),
  note: z.string().max(200).optional(),
});

export const totpEnableSchema = z.object({
  code: z.string().min(6).max(8),
});

// ------------------------------------------------------------------ payments

/**
 * Checkout verification payload. Ids come from the gateway's own checkout
 * callback; the signature is what actually proves the payment happened, and it
 * is re-derived server-side from our key secret.
 */
export const paymentVerifySchema = z.object({
  razorpayOrderId: z.string().min(4).max(64),
  razorpayPaymentId: z.string().min(4).max(64),
  razorpaySignature: z.string().min(16).max(256),
});
