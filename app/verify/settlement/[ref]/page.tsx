import Link from "next/link";
import { notFound } from "next/navigation";
import { getChainStatus } from "@/lib/blockchain/client";
import { verifySettlementRef } from "@/lib/blockchain/settlements";
import { rupees } from "@/lib/constants";
import { Badge } from "@/components/ui";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_STYLES: Record<string, { tone: "emerald" | "rose" | "amber" | "slate"; label: string }> = {
  SETTLED: { tone: "emerald", label: "Recorded on chain" },
  PENDING: { tone: "amber", label: "Awaiting chain" },
  MISMATCH: { tone: "rose", label: "Disputed — do not rely on this" },
  NOT_FOUND: { tone: "slate", label: "Not found on chain" },
  UNAVAILABLE: { tone: "amber", label: "Chain unavailable" },
};

const EXPLORER = process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL ?? "";

/**
 * Public settlement verification.
 *
 * Deliberately unauthenticated: the whole value of anchoring a settlement is
 * that a customer, a regulator or a judge's parent can check it themselves. The
 * page shows what the chain says and what it does not, in the same breath —
 * a verification screen that only ever prints ✅ is how an audit trail turns
 * into marketing.
 */
export default async function VerifySettlementPage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  const { ref } = await params;
  if (!ref || ref.length > 64) notFound();

  const [verification, chain] = await Promise.all([verifySettlementRef(ref), getChainStatus()]);
  const style = STATE_STYLES[verification.status] ?? STATE_STYLES.NOT_FOUND;
  const disputed = verification.status === "MISMATCH";

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <Link href="/" className="text-sm text-teal-700 hover:underline">
          ← MediMesh
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Settlement verification</h1>
        <p className="mt-1 font-mono text-sm text-slate-500">{verification.settlementRef}</p>
      </div>

      <div className={`rounded-2xl border bg-white p-6 shadow-sm ${disputed ? "border-rose-300" : "border-slate-200"}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            On-chain status
          </span>
          <Badge tone={style.tone}>{style.label}</Badge>
        </div>

        <dl className="mt-5 space-y-3 text-sm">
          <Row label="Amount paid to pharmacy">
            {verification.amountPaise > 0 ? rupees(verification.amountPaise) : "—"}
          </Row>
          <Row label="Pharmacy">{verification.pharmacyName ?? "—"}</Row>
          <Row label="Beneficiary wallet">
            <span className="break-all font-mono text-xs">
              {verification.beneficiaryWallet ?? "—"}
            </span>
          </Row>
          <Row label="Order reference">
            <span className="font-mono text-xs">{verification.orderRef || "—"}</span>
          </Row>
          <Row label="Recorded at">
            {verification.settledAtUnix
              ? new Date(verification.settledAtUnix * 1000).toLocaleString("en-IN")
              : "—"}
          </Row>
          <Row label="Metadata hash">
            <span className="break-all font-mono text-xs">{verification.metadataHash ?? "—"}</span>
          </Row>
          <Row label="Record unaltered">
            {verification.metadataMatches === null
              ? "Not verifiable locally"
              : verification.metadataMatches
                ? "Yes — recomputed hash matches the anchored one"
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

        {EXPLORER && verification.txHash ? (
          <a
            className="mt-4 inline-flex items-center gap-1 text-sm text-teal-700 hover:underline"
            href={`${EXPLORER}/tx/${verification.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction on the block explorer
          </a>
        ) : null}
      </div>

      <div
        className={`rounded-2xl border p-5 ${
          disputed ? "border-rose-300 bg-rose-50" : "border-amber-200 bg-amber-50"
        }`}
      >
        <h2
          className={`text-sm font-semibold ${disputed ? "text-rose-900" : "text-amber-900"}`}
        >
          What this does and does not prove
        </h2>
        <p
          className={`mt-2 text-sm leading-relaxed ${disputed ? "text-rose-800" : "text-amber-800"}`}
        >
          {verification.note}
        </p>
      </div>

      <p className="text-xs leading-relaxed text-slate-400">
        No customer identity is published here or stored on-chain. This page shows a pharmacy&apos;s
        business name and wallet because those are what a settlement is meant to be
        attributable to — the patient is never part of the record.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>MediMesh ledger · chainId {chain.chainId ?? "unavailable"}</span>
        <span>·</span>
        <span>{chain.ready ? "contract reachable" : (chain.error ?? "contract not reachable")}</span>
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