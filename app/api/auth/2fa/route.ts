import type { NextRequest } from "next/server";
import { z } from "zod";
import { complete2fa, createSession } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session";
import { json, error, clientIp, sameOrigin } from "@/lib/api-utils";
import { rateLimit } from "@/lib/rate-limit";

const schema = z.object({
  challenge: z.string().min(10).max(2000),
  code: z.string().min(6).max(64),
});

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return error(403, "Cross-origin request blocked");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "Invalid JSON");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");

  // A 6-digit code is the weakest credential in the system, so it gets the
  // tightest limit: six-digit space falls fast without this.
  const limited = rateLimit(`2fa:${parsed.data.challenge}:${clientIp(req)}`, 6, 120_000);
  if (!limited.ok) {
    return new Response(JSON.stringify({ error: "Too many codes. Try again shortly." }), {
      status: 429,
      headers: { "retry-after": String(limited.retryAfterSeconds) },
    });
  }

  const ip = clientIp(req);
  const result = await complete2fa(parsed.data.challenge, parsed.data.code, { ip });
  if (!result.ok || !result.user) return error(401, result.reason ?? "Invalid code");

  const token = await createSession(result.user.id, result.user.role, {
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  await setSessionCookie(token);
  return json({ ok: true, role: result.user.role, name: result.user.name });
}
