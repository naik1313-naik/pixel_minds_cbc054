import { cookies } from "next/headers";
import { validateSession, type DbUser, type SessionRow } from "./auth";

export const SESSION_COOKIE = "mm_session";

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function getCurrentUser(): Promise<{ user: DbUser; session: SessionRow } | null> {
  const token = await getSessionToken();
  if (!token) return null;
  return validateSession(token);
}
