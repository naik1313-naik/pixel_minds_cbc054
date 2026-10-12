import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
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
