import { describe, it, expect } from "vitest";
import {
  verhoeffValid,
  verhoeffCheckDigit,
  parseDocumentKind,
  normalizeDocument,
  maskDocument,
  verifyDocument,
  demoRegistryLookup,
} from "@/lib/identity";

function validAadhaar(base11: string): string {
  return base11 + verhoeffCheckDigit(base11);
}

describe("Verhoeff checksum (Aadhaar)", () => {
  it("accepts a number generated with the correct check digit", () => {
    for (const base of ["23456789012", "98765432109", "55512345678"]) {
      expect(verhoeffValid(validAadhaar(base))).toBe(true);
    }
  });

  it("rejects a tampered check digit", () => {
    const ok = validAadhaar("23456789012");
    const last = Number(ok.slice(-1));
    const bad = ok.slice(0, -1) + String((last + 1) % 10);
    expect(verhoeffValid(bad)).toBe(false);
  });

  it("rejects non-digit input", () => {
    expect(verhoeffValid("23456ABC012")).toBe(false);
  });
});

describe("type parsing + masking", () => {
  it("maps aliases to canonical kinds", () => {
    expect(parseDocumentKind("aadhar")).toBe("AADHAAR");
    expect(parseDocumentKind("Driving Licence")).toBe("DL");
    expect(parseDocumentKind("EPIC")).toBe("VOTER");
    expect(parseDocumentKind("drug license")).toBe("DRUG_LICENCE");
    expect(parseDocumentKind("nonsense")).toBe("UNKNOWN");
  });

  it("normalizes and masks without leaking the full number", () => {
    expect(normalizeDocument("AADHAAR", "2345 6789 0123")).toBe("234567890123");
    expect(maskDocument("AADHAAR", "234567890123")).toBe("XXXX XXXX 0123");
    expect(maskDocument("PAN", "ABCPE1234F")).toBe("XXXXXX234F");
  });
});

describe("verifyDocument", () => {
  it("verifies a well-formed, issued Aadhaar", () => {
    const aadhaar = validAadhaar("23456789012");
    const res = verifyDocument({ type: "Aadhaar", number: aadhaar, name: "Asha" }, demoRegistryLookup);
    expect(res.status).toBe("verified");
    expect(res.checksumValid).toBe(true);
    expect(res.reference).toMatch(/^GOV-AAD-/);
    expect(res.masked).toBe(`XXXX XXXX ${aadhaar.slice(-4)}`);
  });

  it("flags a bad Aadhaar checksum", () => {
    const ok = validAadhaar("23456789012");
    const tampered = ok.slice(0, 3) + String((Number(ok[3]) + 1) % 10) + ok.slice(4);
    const res = verifyDocument({ type: "Aadhaar", number: tampered }, demoRegistryLookup);
    expect(res.status).toBe("invalid");
    expect(res.checksumValid).toBe(false);
  });

  it("rejects fabricated numbers that pass structure (ending 0000)", () => {
    const res = verifyDocument({ type: "PAN", number: "ABCPE0000F" }, demoRegistryLookup);
    expect(res.status).toBe("invalid");
    expect(res.registryFound).toBe(false);
  });

  it("validates PAN holder-type letter", () => {
    expect(verifyDocument({ type: "PAN", number: "ABCPE1234F" }).status).not.toBe("format_error");
    const bad = verifyDocument({ type: "PAN", number: "ABCDE1234F" });
    expect(bad.status).toBe("format_error");
    expect(bad.formatValid).toBe(false);
  });

  it("validates driving licences", () => {
    expect(verifyDocument({ type: "DL", number: "KA0120180001234" }).formatValid).toBe(true);
    expect(verifyDocument({ type: "DL", number: "KA012018000123" }).formatValid).toBe(false);
    expect(verifyDocument({ type: "DL", number: "KA0112750001234" }).formatValid).toBe(false);
  });

  it("validates voter, passport and drug licence formats", () => {
    expect(verifyDocument({ type: "Voter", number: "ABC1234567" }).formatValid).toBe(true);
    expect(verifyDocument({ type: "Voter", number: "AB1234567" }).formatValid).toBe(false);
    expect(verifyDocument({ type: "Passport", number: "M1234567" }).formatValid).toBe(true);
    expect(verifyDocument({ type: "Passport", number: "MM123456" }).formatValid).toBe(false);
    expect(verifyDocument({ type: "DrugLicence", number: "KA-BLR-20B-12345" }).formatValid).toBe(true);
    expect(verifyDocument({ type: "DrugLicence", number: "KA-BLR-99X-0001" }).formatValid).toBe(false);
  });

  it("returns format_error for unsupported types and blank input", () => {
    expect(verifyDocument({ type: "wat", number: "123" }).status).toBe("format_error");
    expect(verifyDocument({ type: "PAN", number: "" }).status).toBe("format_error");
  });
});
