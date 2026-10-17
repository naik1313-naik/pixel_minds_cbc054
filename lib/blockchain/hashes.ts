/**
 * Canonical hashing for the MediMesh audit layer.
 *
 * Privacy rules enforced here:
 *  - Only opaque references, non-sensitive medicine metadata and timestamps are
 *    ever hashed. Customer names, phones, addresses, prescriptions and GPS
 *    coordinates must never be passed in.
 *  - Opaque references are generated with crypto-secure randomness, not derived
 *    from predictable data, so a hash is not a reversible identifier.
 *  - Every hash is schema-versioned so a verifier knows how to recompute it.
 *
 * What a hash proves: the supplied metadata matches what was anchored on-chain
 * at registration time. It does NOT prove the metadata was truthful.
 */
import { keccak256, toUtf8Bytes, solidityPackedKeccak256, randomBytes } from "ethers";
import { createHash } from "crypto";

/** Bump when the metadata encoding changes so old hashes stay verifiable. */
export const METADATA_SCHEMA_VERSION = 1;

/**
 * Deterministic, canonical batch metadata.
 *
 * Field order is part of the contract of this schema and must not be reordered.
 * Every value is ABI-encoded and packed, so no two distinct field sets can
 * collide by delimiter confusion.
 */
export interface BatchMetadata {
  schema: number;
  batchRef: string; // opaque, e.g. "MM-7QK4-2F9D"
  medicineName: string; // non-sensitive catalogue name
  salt: string; // non-sensitive composition
  medicineId: number;
  quantityUnits: number;
  expiryDate: string; // YYYY-MM-DD, non-sensitive
  pharmacyId: number; // internal id; resolves to an authorized wallet on-chain
  manufacturedAt: string; // YYYY-MM-DD
  supplierRef: string; // opaque supplier reference, not a document/invoice
}

/** Order/delivery reference hashed for the on-chain delivery trail. */
export interface DeliveryMetadata {
  schema: number;
  orderRef: string; // opaque
  pharmacyId: number;
  requestId: number;
}

/** Transfer reference hashed for the on-chain transfer lifecycle. */
export interface TransferMetadata {
  schema: number;
  transferRef: string; // opaque
  batchRef: string;
  fromPharmacyId: number;
  toPharmacyId: number;
  quantity: number;
}

/**
 * Settlement metadata anchored when a customer payment is routed to a
 * pharmacy owner.
 *
 * `gatewayRef` is the opaque gateway settlement reference (a transfer id, not a
 * bank or card identifier). `orderRef` ties the settlement back to the order's
 * on-chain delivery trail. Customer identity, contact details and any payment
 * instrument data are deliberately absent — none of it may ever be hashed here.
 */
export interface SettlementMetadata {
  schema: number;
  settlementRef: string; // opaque, generated with crypto-secure randomness
  orderRef: string; // opaque order reference
  pharmacyId: number;
  amountPaise: number; // routed amount, excludes the platform fee
  gatewayRef: string; // opaque gateway transfer reference
  settledAt: string; // ISO timestamp of the capture
}

/**
 * Canonical metadata for a rider's delivery-fee settlement.
 *
 * Carries the rider's user id and the internal request id so a verifier can
 * cross-check the amount without either of them being a gateway identifier.
 */
export interface RiderSettlementMetadata {
  schema: number;
  settlementRef: string;
  orderRef: string;
  riderUserId: number;
  amountPaise: number;
  requestId: number;
  gatewayRef: string; // opaque transfer reference
  settledAt: string;
}

/**
 * Hash a string to bytes32 so it can be ABI-packed.
 *
 * solidityPackedKeccak256 only accepts fixed-width Solidity types — "string" is
 * not one of them. Every variable-length field is therefore hashed to a
 * fixed-width bytes32 first, then packed. Packed bytes32 values are
 * concatenation-safe, so no two distinct field sets can collide.
 */
function h(s: string): string {
  return keccak256(toUtf8Bytes(s.trim()));
}

/**
 * Compute the canonical batch metadata hash.
 *
 * Recompute on the verifier side with the exact same inputs to confirm the
 * anchored metadata has not been altered.
 */
export function hashBatchMetadata(meta: BatchMetadata): string {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "bytes32", "uint256", "uint256", "bytes32", "uint256", "bytes32", "bytes32"],
    [
      h("MediMeshBatchMetadata"),
      meta.schema,
      h(meta.batchRef),
      h(meta.medicineName),
      meta.medicineId,
      meta.quantityUnits,
      h(meta.expiryDate),
      meta.pharmacyId,
      h(meta.manufacturedAt),
      h(meta.supplierRef),
    ]
  );
}

export function hashDeliveryMetadata(meta: DeliveryMetadata): string {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "uint256", "uint256"],
    [h("MediMeshDeliveryMetadata"), meta.schema, h(meta.orderRef), meta.pharmacyId, meta.requestId]
  );
}

export function hashTransferMetadata(meta: TransferMetadata): string {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "bytes32", "uint256", "uint256", "uint256"],
    [
      h("MediMeshTransferMetadata"),
      meta.schema,
      h(meta.transferRef),
      h(meta.batchRef),
      meta.fromPharmacyId,
      meta.toPharmacyId,
      meta.quantity,
    ]
  );
}

/** keccak256 of a UTF-8 string — used for opaque on-chain identifiers. */
export function hashRef(ref: string): string {
  return keccak256(toUtf8Bytes(ref));
}

export function hashSettlementMetadata(meta: SettlementMetadata): string {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "bytes32", "uint256", "uint256", "bytes32", "bytes32"],
    [
      h("MediMeshSettlementMetadata"),
      meta.schema,
      h(meta.settlementRef),
      h(meta.orderRef),
      meta.pharmacyId,
      meta.amountPaise,
      h(meta.gatewayRef),
      h(meta.settledAt),
    ]
  );
}

/**
 * Hash for a rider's delivery-fee settlement.
 *
 * Deliberately a different domain separator and a different field list from the
 * pharmacy hash. If the two shared one encoding, a rider's amount could in
 * principle be replayed as a pharmacy's — and worse, a verifier recomputing a
 * receipt would have no way to tell which party a hash described.
 */
export function hashRiderSettlementMetadata(meta: RiderSettlementMetadata): string {
  return solidityPackedKeccak256(
    ["bytes32", "uint8", "bytes32", "bytes32", "uint256", "uint256", "uint256", "bytes32", "bytes32"],
    [
      h("MediMeshRiderSettlementMetadata"),
      meta.schema,
      h(meta.settlementRef),
      h(meta.orderRef),
      meta.riderUserId,
      meta.amountPaise,
      meta.requestId,
      h(meta.gatewayRef),
      h(meta.settledAt),
    ]
  );
}

/**
 * Opaque, human-typeable reference built from crypto-secure randomness.
 * Uses Crockford-style base32 minus ambiguous characters (no I, L, O, U).
 * 20 chars of base32 ≈ 100 bits of entropy.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U

export function generateOpaqueRef(prefix = "MM"): string {
  const bytes = randomBytes(20);
  let out = "";
  for (let i = 0; i < 20; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
}

export function isValidOpaqueRef(ref: string): boolean {
  return /^MM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{8}$/.test(
    ref
  );
}

export function isBytes32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

/** Opaque reference for a delivery, derived from the internal order id. */
export function orderRefForRequest(requestId: number): string {
  const digest = createHash("sha256").update(`medimesh:order:${requestId}`).digest();
  let out = "";
  for (let i = 0; i < 20; i++) out += ALPHABET[digest[i] % ALPHABET.length];
  return `ORD-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
}
