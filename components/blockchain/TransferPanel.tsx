"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, Check, X } from "lucide-react";
import { Alert, Badge, Button, Card, toast } from "@/components/ui";
import { api } from "@/lib/client";
import { TransactionRef } from "./BlockchainStatus";

interface Transfer {
  id: number;
  transfer_ref: string;
  batch_ref: string;
  batch_id: number;
  from_pharmacy_id: number;
  to_pharmacy_id: number;
  from_name: string;
  to_name: string;
  quantity: number;
  status: string;
  tx_hash: string | null;
  block_number: number | null;
  confirm_tx_hash: string | null;
  confirm_block_number: number | null;
  reject_reason: string | null;
  error: string | null;
  stock_applied: number;
}

interface Pharmacy {
  id: number;
  name: string;
}

const TONE: Record<string, "emerald" | "amber" | "rose" | "slate"> = {
  Initiated: "amber",
  Confirmed: "emerald",
  Rejected: "rose",
  Cancelled: "slate",
  Failed: "rose",
};

export default function TransferPanel({ myPharmacyId }: { myPharmacyId: number | null }) {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [pharmacies, setPharmacies] = useState<Pharmacy[]>([]);
  const [batches, setBatches] = useState<{ id: number; batch_ref: string; pharmacy_id: number }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  const [batchId, setBatchId] = useState<number | "">("");
  const [toPharmacy, setToPharmacy] = useState<number | "">("");
  const [quantity, setQuantity] = useState(10);

  const load = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([
        api.get<{ transfers: Transfer[]; pharmacies: Pharmacy[] }>("/api/blockchain/transfers"),
        api.get<{ batches: { id: number; batch_ref: string; pharmacy_id: number }[] }>(
          "/api/blockchain/batches"
        ),
      ]);
      setTransfers(t.transfers);
      setPharmacies(t.pharmacies ?? []);
      setBatches(b.batches);
      const mine = b.batches.find((x) => x.pharmacy_id === myPharmacyId);
      if (mine && batchId === "") setBatchId(mine.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load transfers");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPharmacyId]);

  useEffect(() => {
    load();
  }, [load]);

  async function initiate() {
    if (batchId === "" || toPharmacy === "") return toast("Pick a batch and a destination", "error");
    setBusy(-1);
    setError("");
    try {
      await api.post(
        "/api/blockchain/transfers",
        { batchId, fromPharmacyId: myPharmacyId, toPharmacyId: toPharmacy, quantity },
        { "idempotency-key": crypto.randomUUID() }
      );
      toast("Transfer initiated on-chain", "success");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Transfer failed";
      setError(msg);
      toast(msg, "error");
    } finally {
      setBusy(null);
    }
  }

  async function settle(id: number, action: "confirm" | "reject") {
    setBusy(id);
    try {
      await api.post(`/api/blockchain/transfers/${id}/${action}`, {
        reason: action === "reject" ? "Rejected by destination pharmacy" : undefined,
      });
      toast(action === "confirm" ? "Transfer confirmed" : "Transfer rejected", "success");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    } finally {
      setBusy(null);
    }
  }

  const myBatches = batches.filter((b) => b.pharmacy_id === myPharmacyId);

  return (
    <div className="space-y-4">
      {myPharmacyId != null && (
        <Card className="p-4">
          <h3 className="flex items-center gap-2 font-semibold text-slate-900">
            <ArrowRightLeft className="h-4 w-4 text-teal-600" /> Transfer a batch
          </h3>
          {error && <div className="mt-3"><Alert><span>{error}</span></Alert></div>}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Batch</span>
              <select
                value={batchId}
                onChange={(e) => setBatchId(e.target.value === "" ? "" : Number(e.target.value))}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Select a batch…</option>
                {myBatches.map((b) => (
                  <option key={b.id} value={b.id}>{b.batch_ref}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                To pharmacy
              </span>
              <select
                value={toPharmacy}
                onChange={(e) => setToPharmacy(e.target.value === "" ? "" : Number(e.target.value))}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">Select destination…</option>
                {pharmacies.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Units</span>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>
          {myBatches.length === 0 && (
            <p className="mt-2 text-xs text-slate-500">Register a batch first to enable transfers.</p>
          )}
          <Button className="mt-3" loading={busy === -1} disabled={!batchId || toPharmacy === ""} onClick={initiate}>
            Initiate transfer
          </Button>
        </Card>
      )}

      <Card className="divide-y divide-slate-100">
        {transfers.length === 0 && (
          <p className="p-6 text-center text-sm text-slate-400">No transfers yet.</p>
        )}
        {transfers.map((t) => {
          const inbound = t.to_pharmacy_id === myPharmacyId;
          return (
            <div key={t.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-slate-800">{t.transfer_ref}</span>
                  <Badge tone={TONE[t.status] ?? "slate"}>{t.status}</Badge>
                  {inbound && <Badge tone="teal">inbound</Badge>}
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  <span className="font-mono text-xs">{t.batch_ref}</span> · {t.quantity} units
                </p>
                <p className="text-xs text-slate-500">
                  {t.from_name} → {t.to_name}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  {t.tx_hash && <TransactionRef txHash={t.tx_hash} blockNumber={t.block_number} />}
                  {t.confirm_tx_hash && (
                    <TransactionRef txHash={t.confirm_tx_hash} blockNumber={t.confirm_block_number} />
                  )}
                </div>
                {t.reject_reason && <p className="mt-1 text-xs text-rose-600">{t.reject_reason}</p>}
                {t.error && <p className="mt-1 text-xs text-rose-600">{t.error}</p>}
              </div>

              {/* Only the destination sees settlement actions. */}
              {inbound && t.status === "Initiated" && (
                <div className="flex gap-2">
                  <Button loading={busy === t.id} onClick={() => settle(t.id, "confirm")}>
                    <Check className="h-4 w-4" /> Confirm
                  </Button>
                  <Button variant="danger" loading={busy === t.id} onClick={() => settle(t.id, "reject")}>
                    <X className="h-4 w-4" /> Reject
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
