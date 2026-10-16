/**
 * Fixed-window rate limiting for authentication and payment endpoints.
 *
 * In-memory on purpose: the deployment is a single Next.js instance, and these
 * are abuse brakes, not a billing-grade quota. The important properties are that
 * a limit exists at all, that it is checked *before* any credential comparison or
 * gateway call, and that the caller is told when to come back.
 *
 * A failed window is not a security boundary — it only slows guessing down. The
 * real protections stay where they belong: constant-time signature checks,
 * per-account lockout after repeated failures, and signed webhook verification.
 */
import { clientIp } from "./api-utils";
import type { NextRequest } from "next/server";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Keeps the map from growing without bound on a long-running process. */
const MAX_BUCKETS = 10_000;

function sweep(now: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  // Still oversized after dropping expired windows: shed the oldest half rather
  // than grow forever.
  if (buckets.size > MAX_BUCKETS) {
    const entries = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let i = 0; i < entries.length / 2; i++) buckets.delete(entries[i][0]);
  }
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets; 0 when the request is allowed. */
  retryAfterSeconds: number;
}

/**
 * Counts one hit against `key`.
 *
 * The key should combine the client IP with the thing being protected (an email
 * address, or a route name) so that one abusive network cannot lock out an
 * unrelated user, and one account cannot be guessed at from many hosts.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { ok: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
}

/** Convenience wrapper for routes: rate-limits by IP plus an optional subject. */
export function limitBy(
  req: NextRequest,
  scope: string,
  limit: number,
  windowMs: number,
  subject?: string
): RateLimitResult {
  const key = subject ? `${scope}:${subject.toLowerCase()}` : `${scope}:ip`;
  return rateLimit(key, limit, windowMs);
}

export function clientKey(req: NextRequest): string {
  return clientIp(req);
}

/** Test seam — clears all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}