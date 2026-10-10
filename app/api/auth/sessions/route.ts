import { guard, json } from "@/lib/api-utils";
import { listSessions, revokeAllForUser } from "@/lib/auth";
import { createSession } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session";

export const GET = guard(null, async (ctx) => {
  const sessions = listSessions(ctx.user.id).map((s) => ({
    id: s.id,
    created_at: s.created_at,
    last_seen_at: s.last_seen_at,
    revoked: s.revoked,
  }));
  return json({ sessions });
});

// Revoke all other sessions, then issue a fresh one for this device.
export const DELETE = guard(null, async (ctx, req) => {
  revokeAllForUser(ctx.user.id);
  const token = createSession(ctx.user.id, ctx.user.role, {
    userAgent: req.headers.get("user-agent"),
  });
  await setSessionCookie(token);
  return json({ ok: true });
});
