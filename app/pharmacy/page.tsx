import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getPharmacy } from "@/lib/engine";
import PharmacyConsole from "@/components/pharmacy/PharmacyConsole";

export const dynamic = "force-dynamic";

export default async function PharmacyPage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  if (current.user.role !== "pharmacy_owner" && current.user.role !== "pharmacy_staff" && current.user.role !== "admin") {
    redirect(current.user.role === "customer" ? "/app" : "/rider");
  }
  const pharmacy = current.user.pharmacy_id ? await getPharmacy(current.user.pharmacy_id) : null;
  return (
    <PharmacyConsole
      pharmacyName={pharmacy?.name ?? "Pharmacy console"}
      verification={pharmacy?.verification_status ?? "unknown"}
      pharmacyId={current.user.pharmacy_id ?? null}
    />
  );
}
