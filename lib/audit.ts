import { queryRun, queryAll, nowIso } from "./db";

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
export async function recordAudit(input: AuditInput): Promise<void> {
  await queryRun(
    `INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, entity_id, meta_json, ip, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.actorUserId ?? null,
      input.actorRole ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId != null ? String(input.entityId) : null,
      input.meta ? JSON.stringify(input.meta) : null,
      input.ip ?? null,
      nowIso(),
    ]
  );
}

export async function listAudit(opts: { limit?: number; actorUserId?: number; roles?: string[] } = {}) {
  const limit = Math.min(opts.limit ?? 100, 500);
  if (opts.actorUserId) {
    return queryAll("SELECT * FROM audit_log WHERE actor_user_id = $1 ORDER BY id DESC LIMIT $2", [
      opts.actorUserId,
      limit,
    ]);
  }
  return queryAll("SELECT * FROM audit_log ORDER BY id DESC LIMIT $1", [limit]);
}
