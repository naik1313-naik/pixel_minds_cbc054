"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, ShieldAlert } from "lucide-react";
import { Alert, Badge, Button, Card, Input, toast } from "@/components/ui";
import { api } from "@/lib/client";
import BlockchainStatus, { TransactionRef } from "./BlockchainStatus";

interface Medicine {
  id: number;
  name: string;
  salt: string;
  rx_required: number;
}

export interface BatchRow {
  id: number;
  batch_ref: string;
  medicine_name: string;
  pharmacy_name: string;
  quantity_units: number;
  expiry_date: string;
  manufactured_at: string;
  supplier_ref: string;
  metadata_hash: string;
  status: string;
  tx_hash: string | null;
  block_number: number | null;
  error: string | null;
}

const STATUS_TONE: Record<string, "emerald" | "amber" | "rose" | "slate"> = {
  Registered: "emerald",
  Revoked: "rose",
  Pending: "amber",
  Submitted: "amber",
  Failed: "rose",
  NeedsReconciliation: "amber",
};

export default function BatchPanel() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [medicineId, setMedicineId] = useState<number | "">("");
  const [quantity, setQuantity] = useState(50);
  const [expiry, setExpiry] = useState("");
  const [manufactured, setManufactured] = useState("");
  const [supplierRef, setSupplierRef] = useState("");

  const load = useCallback(async () => {
    try {
      const [b, m] = await Promise.all([
        api.get<{ batches: BatchRow[] }>("/api/blockchain/batches"),
        api.get<{ medicines: Medicine[] }>("/api/medicines"),
      ]);
      setBatches(b.batches);
      setMedicines(m.medicines);
      if (m.medicines[0] && medicineId === "") setMedicineId(m.medicines[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load batches");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    if (medicineId === "") return toast("Pick a medicine", "error");
    if (!expiry || !manufactured) return toast("Expiry and manufactured date are required", "error");
    if (supplierRef.trim().length < 2) return toast("Supplier reference is required", "error");

    setBusy(true);
    setError("");
    try {
      await api.post(
        "/api/blockchain/batches",
        {
          medicineId,
          quantityUnits: quantity,
          expiryDate: expiry,
          manufacturedAt: manufactured,
          supplierRef: supplierRef.trim(),
        },
        // Dedupes a double-click into one logical registration.
        { "idempotency-key": crypto.randomUUID() }
      );
      toast("Batch registered on-chain", "success");
      setOpen(false);
      setSupplierRef("");
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Registration failed";
      setError(msg);
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(batch: BatchRow) {
    if (!window.confirm(`Revoke batch ${batch.batch_ref}? This is recorded on-chain and cannot be undone.`)) {
      return;
    }
    try {
      await api.post(`/api/blockchain/batches/${batch.id}/revoke`);
      toast("Batch revoked", "success");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Revoke failed", "error");
    }
  }

  return (
    <div className="space-y-4">
      <BlockchainStatus />

      <Card className="p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between text-left"
        >
          <span className="flex items-center gap-2 font-semibold text-slate-900">
            <Plus className="h-4 w-4 text-teal-600" /> Register a medicine batch
          </span>
          <span className="text-sm text-slate-400">{open ? "Hide" : "Show"}</span>
        </button>

        {open && (
          <div className="mt-4 space-y-3">
            {error && <Alert><span>{error}</span></Alert>}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Medicine
                </span>
                <select
                  value={medicineId}
                  onChange={(e) => setMedicineId(e.target.value === "" ? "" : Number(e.target.value))}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {medicines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {m.salt}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                label="Units in this batch"
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
              />
              <Input
                label="Expiry date"
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
              <Input
                label="Manufactured on"
                type="date"
                value={manufactured}
                onChange={(e) => setManufactured(e.target.value)}
              />
            </div>
            <Input
              label="Supplier reference (opaque, e.g. SUP-ACME-2291)"
              value={supplierRef}
              onChange={(e) => setSupplierRef(e.target.value)}
              placeholder="No invoices or document numbers"
            />
            <p className="text-xs text-slate-500">
              Only non-sensitive catalogue data is hashed on-chain. Customer details, invoices and prescriptions
              never leave this server.
            </p>
            <Button loading={busy} onClick={submit}>Register batch</Button>
          </div>
        )}
      </Card>

      <Card className="divide-y divide-slate-100">
        {batches.length === 0 && <p className="p-6 text-center text-sm text-slate-400">No batches registered yet.</p>}
        {batches.map((b) => (
          <div key={b.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-slate-800">{b.batch_ref}</span>
                <Badge tone={STATUS_TONE[b.status] ?? "slate"}>{b.status}</Badge>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                {b.medicine_name} · {b.quantity_units} units · exp {b.expiry_date}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <TransactionRef txHash={b.tx_hash} blockNumber={b.block_number} />
                <a
                  href={`/verify/${encodeURIComponent(b.batch_ref)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-semibold text-teal-700 hover:underline"
                >
                  Public verification page
                </a>
                <QrCode batchRef={b.batch_ref} />
              </div>
              {b.error && (
                <p className="mt-1 flex items-start gap-1.5 text-xs text-rose-600">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {b.error}
                </p>
              )}
            </div>
            {b.status === "Registered" && (
              <Button variant="danger" onClick={() => revoke(b)}>Revoke</Button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}

function QrCode({ batchRef }: { batchRef: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    // Signed fetch: the endpoint requires an authenticated pharmacy session.
    fetch(`/api/blockchain/batches/qr?batchRef=${encodeURIComponent(batchRef)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [batchRef]);

  if (!src) return null;
  return (
    /*
     * A signed, blob-backed SVG fetched from an authenticated endpoint.
     * next/image cannot optimise an object URL, and this must never be
     * publicly cacheable, so <img> is the correct choice here.
     */
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={`QR code to verify batch ${batchRef}`} className="h-12 w-12 rounded border border-slate-200" />
  );
}
