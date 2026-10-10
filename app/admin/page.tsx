import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import AdminConsole from "@/components/admin/AdminConsole";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  if (current.user.role !== "admin") {
    redirect(
      current.user.role === "customer"
        ? "/app"
        : current.user.role === "delivery_partner"
        ? "/rider"
        : "/pharmacy"
    );
  }
  return <AdminConsole />;
}
