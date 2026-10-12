import Link from "next/link";
import { notFound } from "next/navigation";
import { getChainStatus } from "@/lib/blockchain/client";
import { verifyBatchRef } from "@/lib/blockchain/ledger";
import { Badge } from "@/components/ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_STYLES: Record<string, { tone: "emerald" | "rose" | "amber" | "slate"; label: string }> = {
  REGISTERED: { tone: "emerald", label: "Registered" },
  REVOKED: { tone: "rose", label: "Revoked" },
  PENDING: { tone: "amber", label: "Pending" },
  NOT_FOUND: { tone: "slate", label: "Not found on chain" },
  UNAVAILABLE: { tone: "amber", label: "Chain unavailable" },
};

export default async function VerifyBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  if (!batchId || batchId.length > 64) notFound();

  const [verification, chain] = await Promise.all([verifyBatchRef(batchId), getChainStatus()]);
  const style = STATE_STYLES[verification.status] ?? STATE_STYLES.NOT_FOUND;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <Link href="/" className="text-sm text-teal-700 hover:underline">
          ← MediMesh
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Batch verification</h1>
        <p className="mt-1 font-mono text-sm text-slate-500">{verification.batchRef}</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            On-chain status
          </span>
          <Badge tone={style.tone}>{style.label}</Badge>
        </div>

        <dl className="mt-5 space-y-3 text-sm">
          <Row label="Registered by">
            {verification.pharmacyName ?? verification.registeredBy ?? "—"}
          </Row>
          <Row label="Medicine">{verification.medicineName ?? "—"}</Row>
          <Row label="Quantity">{verification.quantityUnits ?? "—"} units</Row>
          <Row label="Expiry">{verification.expiryDate ?? "—"}</Row>
          <Row label="Registered at">
            {verification.registeredAt ? new Date(verification.registeredAt).toLocaleString("en-IN") : "—"}
          </Row>
          <Row label="Metadata hash">
            <span className="break-all font-mono text-xs">
              {verification.metadataHash ?? "—"}
            </span>
          </Row>
          <Row label="Metadata matches">
            {verification.metadataMatches === null
              ? "Not verifiable locally"
              : verification.metadataMatches
                ? "Yes — stored metadata is unaltered"
                : "No — stored metadata differs from the anchored hash"}
          </Row>
          {verification.txHash && (
            <Row label="Transaction">
              <span className="break-all font-mono text-xs">{verification.txHash}</span>
              {verification.blockNumber != null && (
                <span className="ml-2 text-xs text-slate-400">block {verification.blockNumber}</span>
              )}
            </Row>
          )}
        </dl>
      </div>

      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
        <h2 className="text-sm font-semibold text-amber-900">What this does and does not prove</h2>
        <p className="mt-2 text-sm leading-relaxed text-amber-800">{verification.note}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>
          Local demonstration chain · chainId {chain.chainId ?? "unavailable"}
        </span>
        <span>·</span>
        <span>
          {chain.ready ? "contract reachable" : (chain.error ?? "contract not reachable")}
        </span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-2 last:border-0">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right font-medium text-slate-800">{children}</dd>
    </div>
  );
}
