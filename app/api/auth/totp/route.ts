import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import { guard, json, error } from "@/lib/api-utils";
import { totpEnableSchema } from "@/lib/validation";
import { getDb } from "@/lib/db";
import {
  generateTotpSecret,
  totpUri,
  encryptSecret,
  decryptSecret,
  verifyTotp,
  randomToken,
  sha256Hex,
} from "@/lib/crypto";
import { enableTotp, disableTotp } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";

export const POST = guard(null, async (ctx) => {
  const secret = generateTotpSecret();
  getDb()
    .prepare("UPDATE users SET totp_secret_enc = ?, totp_enabled = 0 WHERE id = ?")
    .run(encryptSecret(secret), ctx.user.id);
  const uri = totpUri(secret, ctx.user.email);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
  return json({ secret, uri, qr });
});

export const PUT = guard(null, async (ctx, req: NextRequest) => {
  const body = await req.json().catch(() => null);
  const parsed = totpEnableSchema.safeParse(body);
  if (!parsed.success) return error(400, "Invalid input");
  const row = getDb()
    .prepare("SELECT totp_secret_enc FROM users WHERE id = ?")
    .get(ctx.user.id) as { totp_secret_enc: string | null } | undefined;
  if (!row?.totp_secret_enc) return error(400, "Start 2FA setup first");
  const secret = decryptSecret(row.totp_secret_enc);
  if (!verifyTotp(secret, parsed.data.code)) return error(400, "Invalid code");

  enableTotp(ctx.user.id, row.totp_secret_enc);
  const db = getDb();
  db.prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(ctx.user.id);
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    const code = randomToken(9);
    codes.push(code);
    db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)").run(
      ctx.user.id,
      sha256Hex(code.toLowerCase())
    );
  }
  recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: "auth.2fa_enabled", entityType: "user", entityId: ctx.user.id });
  return json({ ok: true, recoveryCodes: codes });
});

export const DELETE = guard(null, async (ctx) => {
  disableTotp(ctx.user.id);
  getDb().prepare("DELETE FROM recovery_codes WHERE user_id = ?").run(ctx.user.id);
  recordAudit({ actorUserId: ctx.user.id, actorRole: ctx.user.role, action: "auth.2fa_disabled", entityType: "user", entityId: ctx.user.id });
  return json({ ok: true });
});
