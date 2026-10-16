"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { Alert, Button, Card, Spinner, toast } from "@/components/ui";
import { api } from "@/lib/client";

/**
 * Operator view of the write outbox.
 *
 * The page exists to make one number unmissable: how many on-chain writes have an
 * unknown outcome. Everything else on this screen is context for that number.
 */

interface ReconState {
  counts: {
    needs_reconciliation: number;
    submitted: number;
    pending: number;
    failed: number;
    confirmed: number;
    settlement_gaps: number;
  };
  unsettled: {
    id: number;
    operation_ref: string;
    operation_type: string;
    entity_type: string;
    entity_id: number;
    status: string;
    tx_hash: string | null;
    attempts: number;
    last_error: string | null;
    updated_at: string;
  }[];
  recent: {
    id: number;
    operation_type: string;
    entity_type: string;
    entity_id: number;
    status: string;
    block_number: number | null;
  }[];
  chain: { ready: boolean; chainId: number | null; error?: string | null };
  note: string;
}

const TONE: Record<string, "rose" | "amber" | "slate" | "emerald"> = {
  NeedsReconciliation: "rose",
  Failed: "rose",
  Submitted: "amber",
  Pending: "amber",
  Confirmed: "emerald",
};

export default function ReconciliationPanel() {
  const [state, setState] = useState<ReconState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.get<ReconState>("/api/admin/reconciliation"));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load outbox state", "error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function reconcile() {
    setBusy(true);
    try {
      const res = await api.post<{ checked: number; confirmed: number; failed: number; stillPending: number }>(
        "/api/admin/reconciliation"
      );
      toast(
        `Checked ${res.checked} · ${res.confirmed} confirmed · ${res.failed} failed · ${res.stillPending} still pending`,
        res.stillPending > 0 || res.failed > 0 ? "error" : "success"
      );
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Reconciliation failed", "error");
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <Card className="p-5">
        <Spinner className="h-6 w-6 text-teal-600" />
      </Card>
    );
  }

  const { counts } = state;
  const gaps = counts.needs_reconciliation + counts.settlement_gaps;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-semibold text-slate-900">
              {gaps > 0 ? (
                <AlertTriangle className="h-4 w-4 text-rose-500" />
              ) : (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              )}
              Write outbox
            </h2>
            <p className="mt-1 text-sm text-slate-500">{state.note}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={load}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button onClick={reconcile} loading={busy}>
              Reconcile
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Needs reconciliation" value={counts.needs_reconciliation} tone="rose" />
          <Stat label="In flight" value={counts.submitted + counts.pending} tone="amber" />
          <Stat label="Failed" value={counts.failed} tone="rose" />
          <Stat label="Settlement gaps" value={counts.settlement_gaps} tone="rose" />
          <Stat label="Confirmed" value={counts.confirmed} tone="emerald" />
        </div>

        {!state.chain.ready ? (
          <Alert kind="error">
            <span>
              Chain unreachable{state.chain.error ? `: ${state.chain.error}` : ""}. Reconciliation reads
              the chain, so it cannot run until the node is back. Nothing is lost — unsettled rows are
              waiting.
            </span>
          </Alert>
        ) : null}
      </Card>

      <Card className="p-5">
        <h3 className="font-semibold text-slate-900">Unsettled operations</h3>
        {state.unsettled.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">Nothing is waiting. Every write has a known outcome.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-400">
                <tr>
                  <th className="py-2 pr-3">Operation</th>
                  <th className="py-2 pr-3">Entity</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Attempts</th>
                  <th className="py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.unsettled.map((op) => (
                  <tr key={op.id} className="align-top">
                    <td className="py-2 pr-3">
                      <p className="font-medium text-slate-800">{op.operation_type}</p>
                      <p className="font-mono text-xs text-slate-400">{op.operation_ref}</p>
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-600">
                      {op.entity_type} #{op.entity_id}
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          TONE[op.status] === "rose"
                            ? "bg-rose-100 text-rose-800"
                            : TONE[op.status] === "amber"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {op.status}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-600">{op.attempts}</td>
                    <td className="py-2 text-xs text-slate-500">
                      {op.tx_hash ? (
                        <p className="font-mono break-all">{op.tx_hash}</p>
                      ) : (
                        <p>no tx hash — never submitted</p>
                      )}
                      {op.last_error ? <p className="mt-1 text-rose-600">{op.last_error}</p> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {state.recent.length > 0 ? (
        <Card className="p-5">
          <h3 className="font-semibold text-slate-900">Recently confirmed</h3>
          <ul className="mt-3 space-y-1 text-xs text-slate-600">
            {state.recent.map((op) => (
              <li key={op.id}>
                {op.operation_type} · {op.entity_type} #{op.entity_id}
                {op.block_number != null ? ` · block ${op.block_number}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "rose" | "amber" | "emerald";
}) {
  const cls =
    tone === "rose"
      ? "bg-rose-50 text-rose-900"
      : tone === "amber"
        ? "bg-amber-50 text-amber-900"
        : "bg-emerald-50 text-emerald-900";
  return (
    <div className={`rounded-xl px-3 py-2 ${cls}`}>
      <p className="text-xs opacity-80">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}