import type { NextRequest } from "next/server";
import { guard, json } from "@/lib/api-utils";
import { queryAll } from "@/lib/db";
import { publicUser } from "@/lib/auth";
import type { DbUser } from "@/lib/auth";

export const GET = guard(["admin"], async (_ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  const rows = role
    ? await queryAll<DbUser>("SELECT * FROM users WHERE role = $1 ORDER BY id", [role])
    : await queryAll<DbUser>("SELECT * FROM users ORDER BY id");
  return json({ users: await Promise.all(rows.map((r) => publicUser(r))) });
});
