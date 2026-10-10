import { sha256Hex } from "./crypto";

// ---------------------------------------------------------------------------
// Identity / document verification.
//
// This answers "is the document number a person typed actually valid?" in two
// layers, without ever calling a real government gateway:
//
//   1. STRUCTURAL + CHECKSUM validation (offline, deterministic):
//        - Aadhaar   → 12 digits, first digit 2-9, Verhoeff checksum digit
//        - PAN       → AAAAA9999A with a valid holder-type letter
//        - DL        → Indian driving-licence layout (state + RTO + year + serial)
//        - Voter/EPIC→ 3 letters + 7 digits
//        - Passport  → 1 letter + 7 digits
//        - DrugLicence → Indian retail/wholesale drug licence number
//      A wrong-length / wrong-shape / bad-checksum number is rejected here.
//
//   2. REGISTRY LOOKUP via a swappable IdentityProvider (lib/providers.ts):
//      confirms the number was actually issued. The demo provider is
//      deterministic so tests and the UI behave predictably.
//
// Nothing here trusts the client; the same functions run on the server.
// ---------------------------------------------------------------------------

export type DocumentKind =
  | "AADHAAR"
  | "PAN"
  | "DL"
  | "VOTER"
  | "PASSPORT"
  | "DRUG_LICENCE"
  | "UNKNOWN";

export type DocStatus = "verified" | "invalid" | "format_error" | "unverifiable";

export interface DocumentCheck {
  kind: DocumentKind;
  /** Canonical, storage-safe form of the number (e.g. spacing removed). */
  normalized: string;
  /** Privacy-preserving display form. */
  masked: string;
  formatValid: boolean;
  /** null when the document type has no checksum digit. */
  checksumValid: boolean | null;
  status: DocStatus;
  reasons: string[];
  /** Registry reference when a lookup succeeded. */
  reference: string | null;
  registryFound: boolean;
}

// --------------------------------------------------------------- type parsing

const TYPE_ALIASES: Record<string, DocumentKind> = {
  aadhaar: "AADHAAR",
  aadhar: "AADHAAR",
  uid: "AADHAAR",
  uidai: "AADHAAR",
  pan: "PAN",
  dl: "DL",
  "driving licence": "DL",
  "driving license": "DL",
  driving: "DL",
  licence: "DL",
  license: "DL",
  voter: "VOTER",
  epic: "VOTER",
  "voter id": "VOTER",
  voterid: "VOTER",
  passport: "PASSPORT",
  "drug licence": "DRUG_LICENCE",
  "drug license": "DRUG_LICENCE",
  druglicence: "DRUG_LICENCE",
  druglicense: "DRUG_LICENCE",
  "drug_licence": "DRUG_LICENCE",
  "drug licence number": "DRUG_LICENCE",
};

export function parseDocumentKind(type: string): DocumentKind {
  const key = type.trim().toLowerCase();
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];
  const squashed = key.replace(/\s+/g, "");
  return TYPE_ALIASES[squashed] ?? "UNKNOWN";
}

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  AADHAAR: "Aadhaar",
  PAN: "PAN card",
  DL: "Driving licence",
  VOTER: "Voter ID (EPIC)",
  PASSPORT: "Passport",
  DRUG_LICENCE: "Drug licence",
  UNKNOWN: "Document",
};

// ------------------------------------------------------------------- Verhoeff
// Dihedral D5 checksum used by UIDAI for the 12th Aadhaar digit.

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Validate a digit string of any length against the Verhoeff checksum. */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const nums = digits.split("").reverse().map(Number);
  for (let i = 0; i < nums.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][nums[i]]];
  }
  return c === 0;
}

/** Append the correct Verhoeff check digit to a payload (used for seeding). */
export function verhoeffCheckDigit(payload: string): string {
  if (!/^\d+$/.test(payload)) throw new Error("verhoeffCheckDigit requires digits");
  let c = 0;
  const nums = payload.split("").reverse().map(Number);
  for (let i = 0; i < nums.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][nums[i]]];
  }
  return String(VERHOEFF_INV[c]);
}

// --------------------------------------------------------------- heuristics

/** Reject obviously fake numbers (all-same digits, all-zeros tail). */
function looksFabricated(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true;
  if (/0{4}$/.test(digits)) return true;
  return false;
}

// ----------------------------------------------------------------- validators

interface FormatOutcome {
  formatValid: boolean;
  checksumValid: boolean | null;
  reasons: string[];
}

function validateAadhaar(raw: string): FormatOutcome {
  const reasons: string[] = [];
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(digits)) {
    return { formatValid: false, checksumValid: null, reasons: ["Aadhaar must be exactly 12 digits"] };
  }
  if (digits[0] === "0" || digits[0] === "1") {
    return { formatValid: false, checksumValid: null, reasons: ["Aadhaar cannot start with 0 or 1"] };
  }
  const checksumValid = verhoeffValid(digits);
  if (!checksumValid) reasons.push("Aadhaar checksum (Verhoeff) failed — likely a typo or invented number");
  if (looksFabricated(digits)) reasons.push("Aadhaar looks fabricated");
  return { formatValid: true, checksumValid, reasons };
}

function validatePan(raw: string): FormatOutcome {
  const value = raw.trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(value)) {
    return {
      formatValid: false,
      checksumValid: null,
      reasons: ["PAN must be 5 letters, 4 digits, then 1 letter (e.g. ABCDE1234F)"],
    };
  }
  const holder = value[3];
  const validHolders = "ABCFGHLJPTK";
  if (!validHolders.includes(holder)) {
    return {
      formatValid: false,
      checksumValid: null,
      reasons: [`PAN holder-type character '${holder}' is invalid`],
    };
  }
  return { formatValid: true, checksumValid: null, reasons: [] };
}

function validateDl(raw: string): FormatOutcome {
  const value = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  // State (2 letters) + RTO (2 digits) + issue year (4 digits) + 7-digit serial.
  if (!/^[A-Z]{2}\d{2}\d{4}\d{7}$/.test(value)) {
    return {
      formatValid: false,
      checksumValid: null,
      reasons: ["Driving licence must be state(2) + RTO(2) + year(4) + serial(7), e.g. KA0120180001234"],
    };
  }
  const year = Number(value.slice(4, 8));
  const now = new Date().getUTCFullYear();
  if (year < 1980 || year > now + 1) {
    return { formatValid: false, checksumValid: null, reasons: ["Driving licence issue year is out of range"] };
  }
  return { formatValid: true, checksumValid: null, reasons: [] };
}

function validateVoter(raw: string): FormatOutcome {
  const value = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z]{3}\d{7}$/.test(value)) {
    return { formatValid: false, checksumValid: null, reasons: ["Voter ID (EPIC) must be 3 letters + 7 digits"] };
  }
  return { formatValid: true, checksumValid: null, reasons: [] };
}

function validatePassport(raw: string): FormatOutcome {
  const value = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z]\d{7}$/.test(value)) {
    return { formatValid: false, checksumValid: null, reasons: ["Passport number must be 1 letter + 7 digits"] };
  }
  return { formatValid: true, checksumValid: null, reasons: [] };
}

function validateDrugLicence(raw: string): FormatOutcome {
  const value = raw.trim().toUpperCase();
  // Optional state code + optional city code + form 20/21 with sub-letter + serial.
  // Examples accepted: "KA-BLR-20B-12345", "20B/21B-12345", "KA20B12345".
  const compact = value.replace(/[\s/-]/g, "");
  if (!/^(?:[A-Z]{2})?(?:[A-Z]{2,4})?(?:20|21)[A-C]?\d{3,7}$/.test(compact)) {
    return {
      formatValid: false,
      checksumValid: null,
      reasons: ["Drug licence must look like KA-BLR-20B-12345"],
    };
  }
  if (compact.length < 7) {
    return { formatValid: false, checksumValid: null, reasons: ["Drug licence number is too short"] };
  }
  return { formatValid: true, checksumValid: null, reasons: [] };
}

function validateByKind(kind: DocumentKind, raw: string): FormatOutcome {
  switch (kind) {
    case "AADHAAR":
      return validateAadhaar(raw);
    case "PAN":
      return validatePan(raw);
    case "DL":
      return validateDl(raw);
    case "VOTER":
      return validateVoter(raw);
    case "PASSPORT":
      return validatePassport(raw);
    case "DRUG_LICENCE":
      return validateDrugLicence(raw);
    default:
      return { formatValid: false, checksumValid: null, reasons: ["Unknown document type"] };
  }
}

// ------------------------------------------------------------------ normalize

export function normalizeDocument(kind: DocumentKind, raw: string): string {
  const trimmed = raw.trim().toUpperCase();
  if (kind === "AADHAAR") return trimmed.replace(/[\s-]/g, "");
  if (kind === "DRUG_LICENCE") return trimmed; // keep readable grouping for humans
  return trimmed.replace(/[\s-]/g, "");
}

export function maskDocument(kind: DocumentKind, normalized: string): string {
  if (kind === "AADHAAR" && normalized.length === 12) {
    return `XXXX XXXX ${normalized.slice(-4)}`;
  }
  if (kind === "DRUG_LICENCE") {
    const tail = normalized.slice(-4);
    return `${normalized.slice(0, Math.max(0, normalized.length - tail.length)).replace(/[A-Z0-9]/g, "X")}${tail}`;
  }
  if (normalized.length <= 4) return normalized;
  return "X".repeat(normalized.length - 4) + normalized.slice(-4);
}

// ------------------------------------------------------------------- checks

export interface VerifyInput {
  type: string;
  number: string;
  name?: string;
}

// Structural + checksum check with no registry call. Returns a check whose
// status is `format_error` / `invalid` on failure, or a provisional `verified`.
function structuralCheck(input: VerifyInput): DocumentCheck {
  const kind = parseDocumentKind(input.type);
  const raw = (input.number ?? "").trim();
  const normalized = kind === "UNKNOWN" ? raw.toUpperCase() : normalizeDocument(kind, raw);
  const masked = kind === "UNKNOWN" ? normalized : maskDocument(kind, normalized);

  const base: DocumentCheck = {
    kind,
    normalized,
    masked,
    formatValid: false,
    checksumValid: null,
    status: "format_error",
    reasons: [],
    reference: null,
    registryFound: false,
  };

  if (kind === "UNKNOWN") {
    return { ...base, reasons: [`Unsupported document type: ${input.type}`] };
  }
  if (!raw) {
    return { ...base, reasons: ["Document number is required"] };
  }

  const fmt = validateByKind(kind, raw);
  base.formatValid = fmt.formatValid;
  base.checksumValid = fmt.checksumValid;
  base.reasons = [...fmt.reasons];

  if (!fmt.formatValid) return base; // format_error
  if (fmt.checksumValid === false) return { ...base, status: "invalid" };
  return { ...base, status: "verified" }; // provisional, refined by finalize()
}

function finalize(check: DocumentCheck, result: RegistryLookupResult | null): DocumentCheck {
  if (check.status === "format_error" || check.status === "invalid") return check;
  if (result) {
    check.registryFound = result.found;
    check.reference = result.reference;
    if (result.unavailable) {
      return {
        ...check,
        status: "unverifiable",
        reasons: [...check.reasons, result.note ?? "Document registry is unavailable"],
      };
    }
    if (!result.found) {
      return {
        ...check,
        status: "invalid",
        reasons: [...check.reasons, result.note ?? "Document not found in the issuing registry"],
      };
    }
  }
  return {
    ...check,
    status: "verified",
    reasons: check.reasons.length ? check.reasons : ["Document number is well-formed and issued"],
  };
}

/**
 * Full verification: structure + checksum + optional (synchronous) registry
 * lookup. Always returns a result object; never throws on bad input.
 */
export function verifyDocument(input: VerifyInput, lookup?: DocumentRegistryLookup): DocumentCheck {
  const check = structuralCheck(input);
  const skip = check.status === "format_error" || check.status === "invalid";
  const result = lookup && !skip ? lookup({ type: check.kind, number: check.normalized, name: input.name }) : null;
  return finalize(check, result);
}

/** Async variant, used when the registry is a real (network) KYC gateway. */
export async function verifyDocumentAsync(
  input: VerifyInput,
  lookup?: AsyncDocumentRegistryLookup
): Promise<DocumentCheck> {
  const check = structuralCheck(input);
  if (!lookup || check.status === "format_error" || check.status === "invalid") {
    return finalize(check, null);
  }
  const result = await lookup({ type: check.kind, number: check.normalized, name: input.name });
  return finalize(check, result);
}

export interface RegistryLookupResult {
  found: boolean;
  reference: string | null;
  note?: string;
  /** Optional name-on-record comparison. */
  nameMatch?: boolean;
  /** Set when the registry itself could not be reached (→ `unverifiable`). */
  unavailable?: boolean;
}

export type DocumentRegistryLookup = (input: {
  type: DocumentKind;
  number: string;
  name?: string;
}) => RegistryLookupResult;

export type AsyncDocumentRegistryLookup = (input: {
  type: DocumentKind;
  number: string;
  name?: string;
}) => RegistryLookupResult | Promise<RegistryLookupResult>;

/** Deterministic demo registry: issued unless the number is clearly bogus. */
export function demoRegistryLookup(input: {
  type: DocumentKind;
  number: string;
  name?: string;
}): RegistryLookupResult {
  const digits = input.number.replace(/\D/g, "");
  const blocked = looksFabricated(digits) || /(?:^|[^a-z])invalid/i.test(input.number);
  if (blocked) {
    return { found: false, reference: null, note: "No record of this document at the issuing authority" };
  }
  const ref = `GOV-${input.type.slice(0, 3)}-${sha256Hex(input.number).slice(0, 10).toUpperCase()}`;
  return { found: true, reference: ref, nameMatch: true };
}

export function isVerified(check: DocumentCheck): boolean {
  return check.status === "verified";
}
