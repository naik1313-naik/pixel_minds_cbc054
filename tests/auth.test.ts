import { describe, it, expect, beforeEach } from "vitest";
import { getDb, resetDemo } from "@/lib/db";
import {
  registerUser,
  login,
  complete2fa,
  createSession,
  validateSession,
  revokeSession,
  listSessions,
  findUserByEmail,
  enableTotp,
  consumeRecoveryCode,
  isRateLimited,
} from "@/lib/auth";
import { generateTotpSecret, encryptSecret, totpCode, sha256Hex } from "@/lib/crypto";

const PW = "Correct-Horse-Battery-9!";

async function makeCustomer(email = "t@example.com") {
  const r = await registerUser({ email, name: "Test Person", password: PW, role: "customer" });
  expect(r.ok).toBe(true);
  return r.userId!;
}

describe("registration", () => {
  beforeEach(() => resetDemo());

  it("rejects weak passwords via policy", async () => {
    const r = await registerUser({ email: "w@example.com", name: "Weak", password: "password123", role: "customer" });
    expect(r.ok).toBe(false);
    expect(r.issues && r.issues.length).toBeGreaterThan(0);
  });

  it("rejects duplicate emails", async () => {
    await makeCustomer("dup@example.com");
    const r = await registerUser({ email: "dup@example.com", name: "Dup", password: PW, role: "customer" });
    expect(r.ok).toBe(false);
  });

  it("never stores the raw password", async () => {
    await makeCustomer("hash@example.com");
    const u = findUserByEmail("hash@example.com")!;
    expect(u.password_hash).not.toContain(PW);
    expect(u.password_hash.startsWith("$argon2id$")).toBe(true);
  });
});

describe("login", () => {
  beforeEach(() => resetDemo());

  it("authenticates with the correct password and rejects the wrong one", async () => {
    await makeCustomer("ok@example.com");
    const good = await login("ok@example.com", PW, { ip: "10.0.0.1" });
    expect(good.ok).toBe(true);
    const bad = await login("ok@example.com", "wrong-password-123!", { ip: "10.0.0.1" });
    expect(bad.ok).toBe(false);
  });

  it("locks the account after repeated failures", async () => {
    await makeCustomer("lock@example.com");
    for (let i = 0; i < 5; i++) await login("lock@example.com", "nope-nope-nope-1!", { ip: "10.0.0.2" });
    const u = findUserByEmail("lock@example.com")!;
    expect(u.locked_until).toBeTruthy();
    const res = await login("lock@example.com", PW, { ip: "10.0.0.2" });
    expect(res.ok).toBe(false);
  });

  it("rate-limits an abusive IP", async () => {
    await makeCustomer("rate@example.com");
    for (let i = 0; i < 21; i++) await login("rate@example.com", "bad-bad-bad-bad-1!", { ip: "10.0.0.9" });
    expect(isRateLimited("10.0.0.9")).toBe(true);
  });
});

describe("two-factor auth", () => {
  beforeEach(() => resetDemo());

  it("requires and verifies a TOTP code", async () => {
    const userId = await makeCustomer("2fa@example.com");
    const secret = generateTotpSecret();
    enableTotp(userId, encryptSecret(secret));

    const step = await login("2fa@example.com", PW, { ip: "10.0.0.3" });
    expect(step.requires2fa).toBe(true);
    expect(step.challenge).toBeTruthy();

    const wrong = complete2fa(step.challenge!, "000000");
    expect(wrong.ok).toBe(false);

    const code = totpCode(secret);
    const good = complete2fa(step.challenge!, code);
    expect(good.ok).toBe(true);
  });

  it("consumes a recovery code exactly once", async () => {
    const userId = await makeCustomer("rec@example.com");
    const code = "abc-def-ghi";
    getDb()
      .prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)")
      .run(userId, sha256Hex(code));
    expect(consumeRecoveryCode(userId, code)).toBe(true);
    expect(consumeRecoveryCode(userId, code)).toBe(false);
  });
});

describe("sessions", () => {
  beforeEach(() => resetDemo());

  it("validates, lists and revokes sessions", async () => {
    const userId = await makeCustomer("sess@example.com");
    const token = createSession(userId, "customer", { ip: "1.2.3.4" });
    expect(validateSession(token)?.user.id).toBe(userId);
    expect(listSessions(userId).length).toBe(1);
    revokeSession(token);
    expect(validateSession(token)).toBeNull();
  });

  it("stores only a hash of the session token", async () => {
    const userId = await makeCustomer("sess2@example.com");
    const token = createSession(userId, "customer", {});
    const row = getDb().prepare("SELECT token_hash FROM sessions WHERE user_id = ?").get(userId) as {
      token_hash: string;
    };
    expect(row.token_hash).not.toBe(token);
  });

  it("rejects a tampered token", async () => {
    const userId = await makeCustomer("sess3@example.com");
    const token = createSession(userId, "customer", {});
    expect(validateSession(`${token}x`)).toBeNull();
  });
});
