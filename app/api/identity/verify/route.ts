import type { NextRequest } from "next/server";
import { json, error, clientIp, sameOrigin } from "@/lib/api-utils";
import { identityVerifySchema } from "@/lib/validation";
import { getIdentityProvider } from "@/lib/providers";

// Lightweight in-memory throttle: document checks are cheap but public.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, { count: number; resetAt: number }>();
function throttled(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return error(403, "Cross-origin request blocked");
  const ip = clientIp(req);
  if (throttled(ip)) return error(429, "Too many verification requests. Try again shortly.");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "Invalid JSON");
  }
  const parsed = identityVerifySchema.safeParse(body);
  if (!parsed.success) return error(400, parsed.error.issues[0]?.message ?? "Invalid input");

  const check = await getIdentityProvider().verify({
    type: parsed.data.idType,
    number: parsed.data.idNumber,
    name: parsed.data.name,
  });

  // Never echo the full number back — only the masked form.
  return json({
    type: check.kind,
    masked: check.masked,
    valid: check.status === "verified",
    status: check.status,
    checksumValid: check.checksumValid,
    reference: check.reference,
    reasons: check.reasons,
  });
}
