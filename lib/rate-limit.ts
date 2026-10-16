/**
 * Fixed-window rate limiting for authentication and payment endpoints.
 *
 * Counters live in Postgres, not in process memory. That is the whole point of
 * this module: the deployment target is a serverless platform where every
 * request may land on a fresh instance with a fresh heap, so an in-memory map
 * resets itself on each cold start and never limits anything at all. The same
 * map also did not count across concurrent instances.
 *
 * A failed window is still not a security boundary — it only slows guessing
 * down. The real protections stay where they belong: constant-time signature
 * checks, per-account lockout after repeated failures, and signed webhook
 * verification.
 *
 * If the database is unreachable the limiter falls back to a process-local map
 * rather than throwing. A degraded limiter still slows an attacker down; an
 * outage that locks every customer out does not.
 */
import { clientIp } from "./api-utils";
import { queryOne, queryRun } from "./db";
import type { NextRequest } from "next/server";

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fallback buckets, used only while the database cannot be reached. */
const buckets = new Map<string, Bucket>();

const MAX_BUCKETS = 10_000;

function sweep(now: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_BUCKETS) {
    const entries = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let i = 0; i < entries.length / 2; i++) buckets.delete(entries[i][0]);
  }
}

function memoryLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: Math.max(0, limit - 1), retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return { ok: true, remaining: Math.max(0, limit - existing.count), retryAfterSeconds: 0 };
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
 *
 * One statement does the whole thing. An unconditional `count + 1` plus a
 * separate read would race: two simultaneous attempts could both read the old
 * count and both be admitted. Resetting a lapsed window has to happen in the same
 * statement for the same reason.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  try {
    const row = await queryOne<{ count: number; reset_at: string }>(
      `INSERT INTO rate_limit_buckets (bucket_key, count, reset_at)
            VALUES ($1, 1, now() + ($2::double precision * interval '1 millisecond'))
       ON CONFLICT (bucket_key) DO UPDATE SET
            count = CASE WHEN rate_limit_buckets.reset_at <= now()
                         THEN 1 ELSE rate_limit_buckets.count + 1 END,
            reset_at = CASE WHEN rate_limit_buckets.reset_at <= now()
                            THEN EXCLUDED.reset_at ELSE rate_limit_buckets.reset_at END
        RETURNING count, reset_at`,
      [key, windowMs]
    );

    // Housekeeping, cheaply: expired rows are dead weight, and this only runs on
    // roughly one request in fifty.
    if (Math.random() < 0.02) {
      await queryRun("DELETE FROM rate_limit_buckets WHERE reset_at <= now()").catch(() => {});
    }

    if (!row) return memoryLimit(key, limit, windowMs);
    const retry = Math.max(1, Math.ceil((new Date(row.reset_at).getTime() - Date.now()) / 1000));
    return {
      ok: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      retryAfterSeconds: row.count <= limit ? 0 : retry,
    };
  } catch {
    return memoryLimit(key, limit, windowMs);
  }
}

/** Convenience wrapper for routes: rate-limits by IP plus an optional subject. */
export async function limitBy(
  req: NextRequest,
  scope: string,
  limit: number,
  windowMs: number,
  subject?: string
): Promise<RateLimitResult> {
  const key = subject ? `${scope}:${subject.toLowerCase()}` : `${scope}:ip`;
  return rateLimit(key, limit, windowMs);
}

export function clientKey(req: NextRequest): string {
  return clientIp(req);
}

/** Test seam — clears the in-process fallback counters. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Test seam — clears the shared counters too. */
export async function clearRateLimitStore(): Promise<void> {
  buckets.clear();
  await queryRun("DELETE FROM rate_limit_buckets").catch(() => {});
}