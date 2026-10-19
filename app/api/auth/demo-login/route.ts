import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { clientIp, error, json, sameOrigin } from "@/lib/api-utils";
import { createSession } from "@/lib/auth";
import { setSessionCookie } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { isDemoLoginAllowedInProd, isDemoMode } from "@/lib/demo";
import { DemoLoginError, findDemoUser, listAvailableDemoAccounts } from "@/lib/demo-accounts";

export const runtime = "nodejs";

const loginSchema = z.object({ key: z.string().min(2).max(40) });

/**
 * Which demo personas can be signed in with one tap.
 *
 * Returns `{ enabled: false }` in production so the UI can hide itself; the
 * POST route enforces the same rule independently, so hiding the button is a
 * courtesy, not the security boundary.
 */
export async function GET() {
  if (!isDemoLoginAllowedInProd()) return json({ enabled: false, accounts: [] });
  const accounts = await listAvailableDemoAccounts();
  return json({ enabled: true, accounts });
}

/**
 * One-tap sign-in for a seeded demo persona.
 *
 * Bypasses the password and the second factor, so it is refused in production
 * and restricted to the seeded @medimesh.demo accounts. Each use is written to
 * the audit log — a demo shortcut must not leave the security log looking
 * cleaner than reality.
 */
export async function POST(req: NextRequest) {
  if (!isDemoLoginAllowedInProd()) return error(404, "Not found");
  if (!sameOrigin(req)) return error(403, "Cross-origin request blocked");

  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");

  let user;
  try {
    user = await findDemoUser(parsed.data.key);
  } catch (e) {
    if (e instanceof DemoLoginError) return error(e.status, e.message);
    throw e;
  }

  const ip = clientIp(req);
  const token = await createSession(user.id, user.role, {
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  await setSessionCookie(token);
  await recordAudit({
    actorUserId: user.id,
    actorRole: user.role,
    action: "auth.demo_login",
    entityType: "user",
    entityId: user.id,
    ip,
    // Recorded because a demo sign-in skips the password *and* the second factor.
    // On a public deployment that is worth being able to see afterwards.
    meta: {
      key: parsed.data.key,
      publicDemo: !isDemoMode(),
    },
  });
  return NextResponse.json({ ok: true, role: user.role, name: user.name });
}