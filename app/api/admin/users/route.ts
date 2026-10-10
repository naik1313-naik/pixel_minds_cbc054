import type { NextRequest } from "next/server";
import { guard, json } from "@/lib/api-utils";
import { getDb } from "@/lib/db";
import { publicUser } from "@/lib/auth";
import type { DbUser } from "@/lib/auth";

export const GET = guard(["admin"], async (_ctx, req: NextRequest) => {
  const url = new URL(req.url);
  const role = url.searchParams.get("role");
  const db = getDb();
  const rows = role
    ? (db.prepare("SELECT * FROM users WHERE role = ? ORDER BY id").all(role) as DbUser[])
    : (db.prepare("SELECT * FROM users ORDER BY id").all() as DbUser[]);
  return json({ users: rows.map(publicUser) });
});
