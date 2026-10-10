import { randomUUID } from "crypto";
import { getDb, nowIso } from "./db";
import {
  randomToken,
  hmacHex,
  timingSafeEqual,
  sessionPepper,
  sha256Hex,
  verifyTotp,
  decryptSecret,
  encryptSecret,
} from "./crypto";
import { verifyPassword, hashPassword, checkPasswordPolicy } from "./password";
import { recordAudit } from "./audit";
import type { Role } from "./constants";
import { getIdentityProvider } from "./providers";
import type { DocumentCheck } from "./identity";

const SESSION_IDLE_MINUTES = 60;
const SESSION_ABSOLUTE_HOURS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const RATE_WINDOW_MINUTES = 15;
const RATE_MAX_PER_WINDOW = 20;

export interface DbUser {
  id: number;
  email: string;
  name: string;
  phone: string | null;
  password_hash: string;
  role: Role;
  pharmacy_id: number | null;
  totp_secret_enc: string | null;
  totp_enabled: number;
  vehicle_number: string | null;
  id_type: string | null;
  id_last4: string | null;
  id_number_enc: string | null;
  doc_status: string | null;
  doc_checked_at: string | null;
  doc_meta_json: string | null;
  partner_online: number;
  partner_status: string | null;
  rating: number;
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  last_login_at: string | null;
}

export function findUserByEmail(email: string): DbUser | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE lower(email) = lower(?)")
    .get(email) as DbUser | undefined;
}
export function findUserById(id: number): DbUser | undefined {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as DbUser | undefined;
}

export function publicUser(u: DbUser) {
  const { password_hash: _p, totp_secret_enc: _t, id_number_enc: _i, ...rest } = u;
  void _p;
  void _t;
  void _i;
  return {
    ...rest,
    doc: parseDocMeta(rest.doc_meta_json),
  };
}

function parseDocMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- sessions

function hashToken(token: string): string {
  return hmacHex(token, sessionPepper());
}

export function createSession(
  userId: number,
  role: string,
  meta: { userAgent?: string | null; ip?: string | null } = {}
): string {
  const db = getDb();
  const token = randomToken(32);
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, role, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    randomUUID(),
    hashToken(token),
    userId,
    role,
    new Date(now).toISOString(),
    new Date(now).toISOString(),
    new Date(now + SESSION_IDLE_MINUTES * 60_000).toISOString(),
    new Date(now + SESSION_ABSOLUTE_HOURS * 3_600_000).toISOString(),
    meta.userAgent ?? null,
    meta.ip ?? null
  );
  return token;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: number;
  role: string;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked: number;
}

export function validateSession(token: string): { session: SessionRow; user: DbUser } | null {
  if (!token) return null;
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .get(hashToken(token)) as SessionRow | undefined;
  if (!session || session.revoked) return null;
  const now = Date.now();
  if (new Date(session.idle_expires_at).getTime() < now) return null;
  if (new Date(session.absolute_expires_at).getTime() < now) return null;
  const user = findUserById(session.user_id);
  if (!user) return null;
  // Sliding idle window.
  db.prepare("UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?").run(
    new Date(now).toISOString(),
    new Date(now + SESSION_IDLE_MINUTES * 60_000).toISOString(),
    session.id
  );
  return { session, user };
}

export function revokeSession(token: string): void {
  getDb()
    .prepare("UPDATE sessions SET revoked = 1 WHERE token_hash = ?")
    .run(hashToken(token));
}

export function revokeAllForUser(userId: number): number {
  const info = getDb()
    .prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0")
    .run(userId);
  return info.changes;
}

export function listSessions(userId: number): SessionRow[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50")
    .all(userId) as SessionRow[];
}

// ---------------------------------------------------- login + 2FA + rate limit

export interface LoginResult {
  ok: boolean;
  reason?: string;
  user?: DbUser;
  requires2fa?: boolean;
  challenge?: string;
}

function recordAttempt(email: string | null, ip: string | null, success: boolean): void {
  getDb()
    .prepare("INSERT INTO login_attempts (email, ip, success, created_at) VALUES (?, ?, ?, ?)")
    .run(email, ip, success ? 1 : 0, nowIso());
}

export function isRateLimited(ip: string | null): boolean {
  if (!ip) return false;
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND created_at >= ?")
    .get(ip, since) as { c: number };
  return row.c >= RATE_MAX_PER_WINDOW;
}

export async function login(
  email: string,
  password: string,
  meta: { ip?: string | null } = {}
): Promise<LoginResult> {
  const db = getDb();
  if (isRateLimited(meta.ip ?? null)) {
    recordAttempt(email, meta.ip ?? null, false);
    return { ok: false, reason: "Too many attempts. Try again later." };
  }
  const user = findUserByEmail(email);
  if (!user) {
    await hashPassword(password); // timing equalisation
    recordAttempt(email, meta.ip ?? null, false);
    return { ok: false, reason: "Invalid email or password" };
  }
  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    recordAttempt(email, meta.ip ?? null, false);
    return { ok: false, reason: "Account temporarily locked. Try later." };
  }
  const valid = await verifyPassword(user.password_hash, password);
  if (!valid) {
    const failed = user.failed_attempts + 1;
    const lockedUntil =
      failed >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString()
        : null;
    db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(
      failed,
      lockedUntil,
      user.id
    );
    recordAttempt(email, meta.ip ?? null, false);
    return { ok: false, reason: "Invalid email or password" };
  }
  recordAttempt(email, meta.ip ?? null, true);
  db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(user.id);

  if (user.totp_enabled) {
    return { ok: false, requires2fa: true, challenge: makeChallenge(user.id), user };
  }
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), user.id);
  return { ok: true, user };
}

function makeChallenge(userId: number): string {
  const exp = Date.now() + 5 * 60_000;
  const sig = hmacHex(`${userId}:${exp}`, sessionPepper());
  return Buffer.from(JSON.stringify({ userId, exp, sig })).toString("base64url");
}

export function readChallenge(challenge: string): { userId: number } | null {
  try {
    const parsed = JSON.parse(Buffer.from(challenge, "base64url").toString("utf8")) as {
      userId: number;
      exp: number;
      sig: string;
    };
    if (parsed.exp < Date.now()) return null;
    const expected = hmacHex(`${parsed.userId}:${parsed.exp}`, sessionPepper());
    if (!timingSafeEqual(expected, parsed.sig)) return null;
    return { userId: parsed.userId };
  } catch {
    return null;
  }
}

// Completes a 2FA login by verifying the TOTP or a recovery code.
export function complete2fa(
  challenge: string,
  code: string,
  meta: { ip?: string | null } = {}
): LoginResult {
  const c = readChallenge(challenge);
  if (!c) return { ok: false, reason: "Challenge expired. Sign in again." };
  const user = findUserById(c.userId);
  if (!user || !user.totp_secret_enc) return { ok: false, reason: "Invalid account" };

  let ok = false;
  let usedRecovery = false;
  if (/^\d{6}$/.test(code)) {
    const secret = decryptSecret(user.totp_secret_enc);
    ok = verifyTotp(secret, code);
  } else if (code.trim().length > 6) {
    ok = consumeRecoveryCode(user.id, code.trim());
    usedRecovery = ok;
  }
  if (!ok) {
    recordAttempt(user.email, meta.ip ?? null, false);
    return { ok: false, reason: "Invalid code" };
  }
  recordAttempt(user.email, meta.ip ?? null, true);
  getDb().prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), user.id);
  recordAudit({ actorUserId: user.id, actorRole: user.role, action: usedRecovery ? "auth.recovery_used" : "auth.2fa_ok", entityType: "user", entityId: user.id });
  return { ok: true, user };
}

export function consumeRecoveryCode(userId: number, code: string): boolean {
  const db = getDb();
  const hash = sha256Hex(code.toLowerCase());
  const row = db
    .prepare("SELECT id FROM recovery_codes WHERE user_id = ? AND used = 0 AND code_hash = ?")
    .get(userId, hash) as { id: number } | undefined;
  if (!row) return false;
  db.prepare("UPDATE recovery_codes SET used = 1, used_at = ? WHERE id = ?").run(nowIso(), row.id);
  return true;
}

// ------------------------------------------------------------- registration

export interface RegisterInput {
  email: string;
  name: string;
  phone?: string;
  password: string;
  role: "customer" | "pharmacy_owner" | "delivery_partner";
  pharmacyId?: number;
  vehicle?: string;
  idType?: string;
  idNumber?: string;
}

export interface RegisterResult {
  ok: boolean;
  reason?: string;
  userId?: number;
  issues?: string[];
  docCheck?: DocumentCheck;
}

export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const db = getDb();
  if (findUserByEmail(input.email)) return { ok: false, reason: "Email already registered" };
  const policy = checkPasswordPolicy(input.password, { email: input.email, name: input.name });
  if (!policy.ok) return { ok: false, reason: policy.issues[0], issues: policy.issues };

  // Identity verification for delivery partners happens before the row is
  // written, so an invalid/fabricated document can never create an account.
  let docCheck: DocumentCheck | undefined;
  let idLast4: string | null = null;
  let idNumberEnc: string | null = null;
  let docMetaJson: string | null = null;
  if (input.role === "delivery_partner") {
    docCheck = await getIdentityProvider().verify({
      type: input.idType ?? "",
      number: input.idNumber ?? "",
      name: input.name,
    });
    if (docCheck.status === "invalid" || docCheck.status === "format_error") {
      return {
        ok: false,
        reason: `${input.idType ?? "ID"} number failed verification: ${docCheck.reasons[0] ?? "invalid document"}`,
        docCheck,
      };
    }
    idLast4 = docCheck.normalized.slice(-4);
    idNumberEnc = encryptSecret(docCheck.normalized);
    docMetaJson = JSON.stringify({
      masked: docCheck.masked,
      reference: docCheck.reference,
      checksumValid: docCheck.checksumValid,
      reasons: docCheck.reasons,
    });
  }

  const hash = await hashPassword(input.password);
  // New delivery partners are approved automatically — no admin gate.
  const partnerStatus = input.role === "delivery_partner" ? "verified" : null;
  const info = db
    .prepare(
      `INSERT INTO users (email, name, phone, password_hash, role, pharmacy_id, vehicle_number, id_type, id_last4, id_number_enc, doc_status, doc_checked_at, doc_meta_json, partner_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.email,
      input.name,
      input.phone ?? null,
      hash,
      input.role,
      input.role === "pharmacy_owner" ? input.pharmacyId ?? null : null,
      input.vehicle ?? null,
      input.role === "delivery_partner" ? input.idType ?? null : null,
      idLast4,
      idNumberEnc,
      docCheck?.status ?? null,
      docCheck ? nowIso() : null,
      docMetaJson,
      partnerStatus,
      nowIso()
    );
  const userId = Number(info.lastInsertRowid);
  recordAudit({ actorUserId: userId, actorRole: input.role, action: "auth.register", entityType: "user", entityId: userId });
  return { ok: true, userId, docCheck };
}

// ------------------------------------------------------------- 2FA setup

export function enableTotp(userId: number, secretEnc: string): void {
  getDb().prepare("UPDATE users SET totp_secret_enc = ?, totp_enabled = 1 WHERE id = ?").run(secretEnc, userId);
}
export function disableTotp(userId: number): void {
  getDb().prepare("UPDATE users SET totp_secret_enc = NULL, totp_enabled = 0 WHERE id = ?").run(userId);
}
