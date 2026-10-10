import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Page } from "@playwright/test";

interface Credential {
  email: string;
  password: string;
  totpSecret?: string;
}

let cache: Map<string, Credential> | null = null;

function loadCreds(): Map<string, Credential> {
  if (cache) return cache;
  const file = path.join(process.cwd(), ".e2e-data", ".demo-credentials.txt");
  if (!fs.existsSync(file)) throw new Error(`Credentials file missing: ${file}`);
  const map = new Map<string, Credential>();
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let current: Credential | null = null;
  for (const line of lines) {
    const head = line.match(/^\S+\s+(\S+@\S+)/);
    if (head) {
      current = { email: head[1], password: "" };
      map.set(head[1], current);
      continue;
    }
    const pw = line.match(/^\s+password:\s+(.+)$/);
    if (pw && current) current.password = pw[1].trim();
    const secret = line.match(/^\s+TOTP secret:\s+(\S+)/);
    if (secret && current) current.totpSecret = secret[1].trim();
  }
  cache = map;
  return map;
}

export function credentialFor(email: string): Credential {
  const cred = loadCreds().get(email);
  if (!cred) throw new Error(`No credential found for ${email}`);
  return cred;
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
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

export function totp(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

// Signs in through the real login form and waits for the role landing page.
export async function loginAs(page: Page, email: string, expectedPath: string) {
  const cred = credentialFor(email);
  await page.goto("/login");
  await page.getByLabel("Email").fill(cred.email);
  await page.getByLabel("Password").fill(cred.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // 2FA-enabled accounts (admin, owner1) show a second step; others navigate away.
  const otpField = page.getByLabel("Authentication code");
  const outcome = await Promise.race([
    otpField.waitFor({ state: "visible", timeout: 30_000 }).then(() => "otp" as const),
    page.waitForURL(`**${expectedPath}`, { timeout: 30_000 }).then(() => "nav" as const),
  ]).catch(() => "timeout" as const);

  if (outcome === "otp") {
    if (!cred.totpSecret) throw new Error(`2FA required for ${email} but no TOTP secret available`);
    await otpField.fill(totp(cred.totpSecret));
    await page.getByRole("button", { name: "Verify & sign in" }).click();
  }
  await page.waitForURL(`**${expectedPath}`, { timeout: 30_000 });
}

