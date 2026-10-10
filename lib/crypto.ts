import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataDir } from "./paths";

// ---------------------------------------------------------------------------
// Dev secret management.
// Production requires real env vars. Development falls back to a locally
// generated, gitignored secrets file so nothing secret is ever hardcoded.
// ---------------------------------------------------------------------------

let cachedDevSecrets: Record<string, string> | null = null;
function devSecrets(): Record<string, string> {
  if (cachedDevSecrets) return cachedDevSecrets;
  const file = path.join(dataDir(), ".dev-secrets.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let secrets: Record<string, string>;
  if (fs.existsSync(file)) {
    secrets = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    secrets = {
      APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
      SESSION_PEPPER: crypto.randomBytes(32).toString("hex"),
    };
    fs.writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  }
  cachedDevSecrets = secrets;
  return secrets;
}

function requireSecret(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`Missing required secret ${name}. Set it in the environment.`);
  }
  return devSecrets()[name];
}

export function encryptionKey(): Buffer {
  return crypto.createHash("sha256").update(requireSecret("APP_ENCRYPTION_KEY")).digest();
}

export function sessionPepper(): string {
  return requireSecret("SESSION_PEPPER");
}

// ------------------------------------------------------------------ symmetric

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), enc.toString("base64"), tag.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB, encB, tagB] = payload.split(".");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivB, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64")), decipher.final()]).toString(
    "utf8"
  );
}

// ------------------------------------------------------------------- digests

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacHex(input: string, key: string): string {
  return crypto.createHmac("sha256", key).update(input).digest("hex");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // still do a comparison to reduce timing signal
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function randomDigits(len: number): string {
  let out = "";
  while (out.length < len) out += crypto.randomInt(0, 10).toString();
  return out;
}

// --------------------------------------------------------------------- base32

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/g, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ----------------------------------------------------------------------- TOTP
// RFC 6238 (SHA-1, 6 digits, 30s period, +/-1 window).

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, "0");
}

export function totpCode(secretBase32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 1000 / 30));
}

export function verifyTotp(secretBase32: string, token: string, atMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(atMs / 1000 / 30);
  for (let w = -1; w <= 1; w++) {
    if (timingSafeEqual(hotp(secret, step + w), token)) return true;
  }
  return false;
}

export function totpUri(secretBase32: string, email: string, issuer = "MediMesh"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(
    email
  )}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
