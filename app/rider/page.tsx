import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import RiderApp from "@/components/rider/RiderApp";

export const dynamic = "force-dynamic";

export default async function RiderPage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  if (current.user.role !== "delivery_partner" && current.user.role !== "admin") {
    redirect(current.user.role === "customer" ? "/app" : "/pharmacy");
  }
  return (
    <RiderApp
      name={current.user.name}
      online={Boolean(current.user.partner_online)}
      partnerStatus={current.user.partner_status ?? "unknown"}
    />
  );
}
