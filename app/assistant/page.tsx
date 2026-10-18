import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import NavBar from "@/components/NavBar";
import AssistantPanel from "@/components/assistant/AssistantPanel";

export const dynamic = "force-dynamic";

/**
 * The assistant page.
 *
 * Requires a session, like every other role surface. There is no anonymous mode:
 * the assistant reads your own orders, so there has to be a "you".
 */
export default async function AssistantPage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");

  return (
    <div className="min-h-screen bg-slate-50">
      <NavBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <AssistantPanel name={current.user.name ?? "there"} />
      </main>
    </div>
  );
}
