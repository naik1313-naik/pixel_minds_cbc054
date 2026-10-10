import type { NextRequest } from "next/server";
import { getSessionToken, clearSessionCookie } from "@/lib/session";
import { revokeSession } from "@/lib/auth";
import { json } from "@/lib/api-utils";

export async function POST(_req: NextRequest) {
  const token = await getSessionToken();
  if (token) revokeSession(token);
  await clearSessionCookie();
  return json({ ok: true });
}
