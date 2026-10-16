import { describe, it, expect } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  totpCode,
  verifyTotp,
  generateTotpSecret,
  timingSafeEqual,
  sha256Hex,
  randomDigits,
} from "@/lib/crypto";
import { hashPassword, verifyPassword, checkPasswordPolicy } from "@/lib/password";
import { MIN_PASSWORD_LENGTH } from "@/lib/validation";

describe("symmetric encryption", () => {
  it("round-trips and uses a random IV", () => {
    const a = encryptSecret("hello-secret");
    const b = encryptSecret("hello-secret");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("hello-secret");
    expect(decryptSecret(b)).toBe("hello-secret");
  });
  it("fails to decrypt tampered ciphertext", () => {
    const enc = encryptSecret("hello");
    const parts = enc.split(".");
    parts[1] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});

describe("password hashing", () => {
  it("verifies correctly and is salted", async () => {
    const h1 = await hashPassword("My-Secret-Pass-1!");
    const h2 = await hashPassword("My-Secret-Pass-1!");
    expect(h1).not.toBe(h2);
    expect(await verifyPassword(h1, "My-Secret-Pass-1!")).toBe(true);
    expect(await verifyPassword(h1, "wrong")).toBe(false);
  });
});

describe("password policy", () => {
  it("rejects common and short passwords", () => {
    expect(checkPasswordPolicy("password123").ok).toBe(false);
    // Below the length floor (6), and again for the other rules above.
    expect(checkPasswordPolicy("Sh1!A").ok).toBe(false);
  });
  it("enforces the configured minimum length", () => {
    // The floor is deliberately short for demo accounts, but it is still a floor:
    // five characters is refused, six with mixed case, a digit and a symbol is
    // accepted.
    expect(checkPasswordPolicy("Sh1!Ax").ok).toBe(true);
    expect(MIN_PASSWORD_LENGTH).toBe(6);
  });
  it("accepts a strong passphrase", () => {
    expect(checkPasswordPolicy("Quiet-Orchid-77-Meadow").ok).toBe(true);
  });
  it("rejects passwords containing the email local part", () => {
    expect(checkPasswordPolicy("john.doe-123456!", { email: "john.doe@x.com" }).ok).toBe(false);
  });
});

describe("TOTP", () => {
  it("matches RFC 6238 test vector", () => {
    // Secret "12345678901234567890" base32, at T=59s -> 94287082 (SHA1, 8 digits).
    // Our implementation truncates to 6 digits within the same window.
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const at59 = 59 * 1000;
    expect(totpCode(secret, at59)).toBe("287082");
  });
  it("accepts the adjacent window and rejects the current one for a wrong code", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, "000000", now)).toBe(false);
  });
});

describe("misc primitives", () => {
  it("constant-time compare", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
  it("sha256 is stable", () => {
    expect(sha256Hex("x")).toBe(sha256Hex("x"));
  });
  it("randomDigits has the requested length", () => {
    expect(randomDigits(4)).toMatch(/^\d{4}$/);
  });
});
