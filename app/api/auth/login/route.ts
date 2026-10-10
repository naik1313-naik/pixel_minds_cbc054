import type { NextRequest } from "next/server";
import { loginSchema } from "@/lib/validation";
import { login } from "@/lib/auth";
import { createSession } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session";
import { json, error, clientIp, sameOrigin } from "@/lib/api-utils";
import { recordAudit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return error(403, "Cross-origin request blocked");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return error(400, "Invalid JSON");
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");

  const ip = clientIp(req);
  const result = await login(parsed.data.email, parsed.data.password, { ip });
  if (result.requires2fa && result.challenge) {
    return json({ requires2fa: true, challenge: result.challenge });
  }
  if (!result.ok || !result.user) {
    return error(401, result.reason ?? "Invalid email or password");
  }
  const token = createSession(result.user.id, result.user.role, {
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  await setSessionCookie(token);
  recordAudit({ actorUserId: result.user.id, actorRole: result.user.role, action: "auth.login", entityType: "user", entityId: result.user.id, ip });
  return json({ ok: true, role: result.user.role, name: result.user.name });
}
