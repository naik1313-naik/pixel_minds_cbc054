import { guard, json } from "@/lib/api-utils";
import { getChainStatus } from "@/lib/blockchain/client";

export const runtime = "nodejs";

/**
 * Read-only blockchain health check.
 *
 * Public so the landing page and the public /verify route can render an honest
 * connection state. It never exposes the signing key, the RPC URL credentials,
 * or any private data — only network identity and readiness.
 */
export async function GET() {
  const status = await getChainStatus();
  return json(status, 200);
}
