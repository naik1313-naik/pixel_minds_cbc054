import { json } from "@/lib/api-utils";
import { getCurrentUser } from "@/lib/session";
import { publicUser } from "@/lib/auth";
import { getPharmacy } from "@/lib/engine";

export async function GET() {
  const current = await getCurrentUser();
  if (!current) return json({ user: null });
  const user = publicUser(current.user);
  const pharmacy = current.user.pharmacy_id ? await getPharmacy(current.user.pharmacy_id) : null;
  return json({ user, pharmacy });
}
