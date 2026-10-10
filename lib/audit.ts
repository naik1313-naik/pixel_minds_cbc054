import { getDb, nowIso } from "./db";

export interface AuditInput {
  actorUserId?: number | null;
  actorRole?: string | null;
  action: string;
  entityType?: string;
  entityId?: string | number;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

// Append-only audit log. Never log secrets or request bodies.
export function recordAudit(input: AuditInput): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, entity_id, meta_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.actorUserId ?? null,
      input.actorRole ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId != null ? String(input.entityId) : null,
      input.meta ? JSON.stringify(input.meta) : null,
      input.ip ?? null,
      nowIso()
    );
}

export function listAudit(opts: { limit?: number; actorUserId?: number; roles?: string[] } = {}) {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 100, 500);
  if (opts.actorUserId) {
    return db
      .prepare("SELECT * FROM audit_log WHERE actor_user_id = ? ORDER BY id DESC LIMIT ?")
      .all(opts.actorUserId, limit);
  }
  return db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
}
