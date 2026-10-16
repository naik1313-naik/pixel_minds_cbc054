import { hash, verify, hashSync } from "@node-rs/argon2";
import type { Options } from "@node-rs/argon2";

// argon2id, 19 MiB memory, 2 iterations, parallelism 1 (OWASP-aligned).
// Algorithm.Argon2id === 2 (const enum member not importable under isolatedModules).
const ARGON_OPTS: Options = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTS);
}

// Synchronous variant used by the seed script (runs inside a sync transaction).
export function hashPasswordSync(password: string): string {
  return hashSync(password, ARGON_OPTS);
}

export async function verifyPassword(digest: string, password: string): Promise<boolean> {
  try {
    return await verify(digest, password, ARGON_OPTS);
  } catch {
    return false;
  }
}

// Used for timing-equalisation when the email is unknown.
let dummyHashCache: string | null = null;
export async function dummyHash(): Promise<string> {
  if (!dummyHashCache) dummyHashCache = await hashPassword("not-a-real-password-0000");
  return dummyHashCache;
}

const COMMON_PASSWORDS = new Set(
  `password password1 password123 passw0rd p@ssword p@ssw0rd 123456 12345678 123456789 1234567890
  1234567 12345 111111 000000 654321 666666 888888 123123 112233 qwerty qwerty123 qwertyuiop
  abc123 abcd1234 a1b2c3d4 letmein welcome welcome1 admin administrator admin123 root toor
  iloveyou princess monkey dragon sunshine football baseball superman batman trustno1 master
  shadow michael jennifer jordan hunter joshua andrew daniel charlie thomas robert matrix
  hello ninja stealth freedom whatever donald secret summer internet service canada
  michael1 jordan23 harley davidson ranger mustang lightning killer asshole fuckyou fuckyou1
  sniper pepper cheese peanut butter cookie chocolate banana orange purple silver golden
  liverpool liverpool1 arsenal chelsea barcelona real madrid india cricket cricket123
  krishna sairama shiva ganesh india123 mumbai delhi chennai kolkata bangalore bengaluru
  password! Password1 Password123 P@ssw0rd qwerty!@# 1q2w3e4r 1qaz2wsx zaq12wsx
  starwars starwars1 pokemon computer samsung google facebook twitter linkedin
  flower angel angels lovely lovely1 babygirl babyboy mylove forever1 nothing every1
  changeit changeme default guest test test123 demo demo123 medimesh pharmacy pharmacy123
  doctor nurse patient medicine health hospital clinic manus love heart soul`
    .split(/\s+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean)
);

// The floor itself lives in lib/validation.ts: this module is server-only (it
// loads argon2's native binding) and the sign-up form reads the constant in the
// browser.
import { MIN_PASSWORD_LENGTH } from "./validation";

export interface PasswordCheck {
  ok: boolean
  score: number; // 0-4
  issues: string[];
}

export function checkPasswordPolicy(
  password: string,
  context: { email?: string; name?: string } = {}
): PasswordCheck {
  const issues: string[] = [];
  const lower = password.toLowerCase();

  if (password.length < MIN_PASSWORD_LENGTH) {
    issues.push(`Must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) issues.push("Add a lowercase letter");
  if (!/[A-Z]/.test(password)) issues.push("Add an uppercase letter");
  if (!/[0-9]/.test(password)) issues.push("Add a number");
  if (!/[^A-Za-z0-9]/.test(password)) issues.push("Add a symbol");
  if (COMMON_PASSWORDS.has(lower)) issues.push("This password is too common");
  if (context.email) {
    const local = context.email.split("@")[0]?.toLowerCase();
    if (local && local.length >= 4 && lower.includes(local)) issues.push("Avoid using your email");
  }
  if (context.name) {
    const parts = context.name.toLowerCase().split(/\s+/).filter((p) => p.length >= 4);
    if (parts.some((p) => lower.includes(p))) issues.push("Avoid using your name");
  }
  // simple zxcvbn-like score
  let variety = 0;
  if (/[a-z]/.test(password)) variety++;
  if (/[A-Z]/.test(password)) variety++;
  if (/[0-9]/.test(password)) variety++;
  if (/[^A-Za-z0-9]/.test(password)) variety++;
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (variety >= 3) score++;
  if (password.length >= 16 && variety >= 3) score++;
  if (issues.length) score = Math.min(score, 2);

  return { ok: issues.length === 0, score: Math.min(4, score), issues };
}
