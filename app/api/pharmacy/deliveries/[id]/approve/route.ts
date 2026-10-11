import { guard, json } from "@/lib/api-utils";
import { approveAssignment } from "@/lib/delivery";

export const POST = guard(["pharmacy_owner", "pharmacy_staff", "admin"], async (ctx, _req, params) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return json({ ok: false, reason: "Invalid id" }, 400);
  const res = await approveAssignment(id, {
    userId: ctx.user.id,
    role: ctx.user.role,
    pharmacyId: ctx.user.pharmacy_id,
  });
  if (!res.ok) return json({ ok: false, reason: res.reason }, res.status ?? 400);
  return json({ ok: true });
});
