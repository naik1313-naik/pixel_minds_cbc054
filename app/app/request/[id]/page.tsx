import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import RequestTracker from "@/components/customer/RequestTracker";
import { getRequestDetail } from "@/lib/engine";
import { canViewRequest } from "@/lib/access";

export const dynamic = "force-dynamic";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { id } = await params;
  const requestId = Number(id);
  if (!Number.isFinite(requestId)) notFound();
  const detail = getRequestDetail(requestId);
  if (!detail) notFound();
  if (
    !canViewRequest(current.user, {
      customer_id: detail.request.customer_id,
      preferred_pharmacy_id: detail.request.preferred_pharmacy_id,
      id: requestId,
    })
  )
    redirect("/app");
  return <RequestTracker requestId={requestId} />;
}
