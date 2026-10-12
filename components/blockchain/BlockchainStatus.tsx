"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Link2, RefreshCw, XCircle } from "lucide-react";
import { api } from "@/lib/client";
import { Badge } from "@/components/ui";

export interface ChainStatus {
  configured: boolean;
  rpcReachable: boolean;
  chainId: number | null;
  expectedChainId: number;
  contractAddress: string | null;
  contractDeployed: boolean;
  ready: boolean;
  signerConfigured: boolean;
  error?: string;
}

/**
 * Blockchain connection panel.
 *
 * Honest by construction: the green state is shown only when the provider
 * actually answered and the contract has deployed code at the configured
 * address. Never renders a "connected" indicator optimistically.
 */
export default function BlockchainStatus({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await api.get<ChainStatus>("/api/blockchain/status"));
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !status) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-400">
        Checking local blockchain…
      </div>
    );
  }

  if (!status) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
          <XCircle className="h-4 w-4" /> Blockchain status unavailable
        </div>
        <p className="mt-1 text-xs text-rose-700">The status endpoint could not be reached.</p>
      </div>
    );
  }

  const tone = status.ready ? "emerald" : status.rpcReachable ? "amber" : "rose";

  if (compact) {
    return (
      <span className="inline-flex items-center gap-2 text-xs text-slate-500">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${
            status.ready ? "bg-emerald-500" : status.rpcReachable ? "bg-amber-500" : "bg-rose-500"
          }`}
        />
        Local chain {status.ready ? "connected" : status.rpcReachable ? "no contract" : "offline"}
        {status.chainId ? ` · ${status.chainId}` : ""}
      </span>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {status.ready ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : status.rpcReachable ? (
            <AlertTriangle className="h-5 w-5 text-amber-500" />
          ) : (
            <XCircle className="h-5 w-5 text-rose-500" />
          )}
          <h3 className="font-semibold text-slate-900">Blockchain audit layer</h3>
        </div>
        <Badge tone={tone}>Local demo</Badge>
      </div>

      <dl className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
        <div className="flex justify-between gap-2 sm:justify-start sm:gap-2">
          <dt className="text-slate-400">RPC</dt>
          <dd className="font-medium">{status.rpcReachable ? "reachable" : "unreachable"}</dd>
        </div>
        <div className="flex justify-between gap-2 sm:justify-start sm:gap-2">
          <dt className="text-slate-400">Chain ID</dt>
          <dd className="font-medium">
            {status.chainId ?? "—"}
            {status.chainId != null && status.chainId !== status.expectedChainId ? (
              <span className="ml-1 text-rose-600">(expected {status.expectedChainId})</span>
            ) : null}
          </dd>
        </div>
        <div className="flex justify-between gap-2 sm:justify-start sm:gap-2">
          <dt className="text-slate-400">Contract</dt>
          <dd className="font-mono">
            {status.contractAddress ? `${status.contractAddress.slice(0, 10)}…` : "not configured"}
          </dd>
        </div>
        <div className="flex justify-between gap-2 sm:justify-start sm:gap-2">
          <dt className="text-slate-400">Signer</dt>
          <dd className="font-medium">{status.signerConfigured ? "configured" : "not configured"}</dd>
        </div>
      </dl>

      {!status.ready && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <p className="font-semibold">Local blockchain not ready.</p>
          <ol className="mt-1 list-inside list-decimal space-y-0.5">
            <li>
              <code className="rounded bg-amber-100 px-1">cd blockchain</code>
            </li>
            <li>
              <code className="rounded bg-amber-100 px-1">npm run node</code> (terminal 1)
            </li>
            <li>
              <code className="rounded bg-amber-100 px-1">npm run deploy</code> (terminal 2)
            </li>
          </ol>
          {status.error && <p className="mt-1 break-words">{status.error}</p>}
          <p className="mt-1">
            Everything except the audit layer keeps working while the chain is offline.
          </p>
        </div>
      )}

      <button
        onClick={load}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700 hover:underline"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
      </button>
    </div>
  );
}

export function TransactionRef({ txHash, blockNumber }: { txHash: string | null; blockNumber?: number | null }) {
  if (!txHash) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
      <Link2 className="h-3.5 w-3.5" />
      <span className="font-mono">{txHash.slice(0, 12)}…</span>
      {blockNumber != null && <span className="text-slate-400">block {blockNumber}</span>}
    </span>
  );
}
