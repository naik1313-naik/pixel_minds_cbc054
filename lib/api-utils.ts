import { NextResponse, type NextRequest } from "next/server";
import { getSessionToken } from "./session";
import { validateSession, type DbUser } from "./auth";
import type { Role } from "./constants";

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export function error(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "127.0.0.1";
}

export interface AuthContext {
  user: DbUser;
  token: string;
}

export async function authUser(): Promise<AuthContext | null> {
  const token = await getSessionToken();
  if (!token) return null;
  const res = await validateSession(token);
  if (!res) return null;
  return { user: res.user, token };
}

export function isRole(user: DbUser, roles: Role[]): boolean {
  return roles.includes(user.role);
}

// Mutating requests must come from the same origin (defence-in-depth on top of
// SameSite=Lax cookies).
export function sameOrigin(req: NextRequest): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const host = req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Wraps a handler with auth + role checks and uniform error handling.
export function guard(
  roles: Role[] | null,
  handler: (ctx: AuthContext, req: NextRequest, params: Record<string, string>) => Promise<Response>
) {
  return async (req: NextRequest, context: { params: Promise<Record<string, string>> }) => {
    try {
      if (req.method !== "GET" && !sameOrigin(req)) {
        return error(403, "Cross-origin request blocked");
      }
      const ctx = await authUser();
      if (!ctx) return error(401, "Not signed in");
      if (roles && !roles.includes(ctx.user.role)) return error(403, "Forbidden");
      const params = context?.params ? await context.params : {};
      return await handler(ctx, req, params);
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message);
      // eslint-disable-next-line no-console
      console.error(e);
      return error(500, "Something went wrong");
    }
  };
}
