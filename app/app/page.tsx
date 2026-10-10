import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import CustomerApp from "@/components/customer/CustomerApp";

export const dynamic = "force-dynamic";

export default async function CustomerHomePage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  if (current.user.role !== "customer") {
    redirect(
      current.user.role === "admin"
        ? "/admin"
        : current.user.role === "delivery_partner"
        ? "/rider"
        : "/pharmacy"
    );
  }
  return <CustomerApp customerName={current.user.name} />;
}
