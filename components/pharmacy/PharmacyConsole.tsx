"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Banknote, Boxes, ClipboardList, Link2, Plus, RefreshCw, Trash2, Truck, Wallet } from "lucide-react";
import { Badge, Button, Card, StatusPill, toast } from "@/components/ui";
import { api, formatRupees, timeAgo } from "@/lib/client";
import BatchPanel from "@/components/blockchain/BatchPanel";
import TransferPanel from "@/components/blockchain/TransferPanel";
import DeliveryAuditTimeline from "@/components/blockchain/DeliveryAuditTimeline";
import PayoutPanel from "@/components/pharmacy/PayoutPanel";

interface RequestRow {
  id: number;
  customer_name: string;
  medicine_name: string;
  qty: number;
  secured_qty: number;
  status: string;
  fulfilment_type: string;
  rx_verified: number;
  created_at: string;
}
interface InventoryRow {
  medicine_id: number;
  medicine_name: string;
  salt: string;
  price_paise: number;
  rx_required: number;
  qty_total: number;
  qty_locked: number;
  free: number;
  expiry_date: string | null;
}
interface CatalogItem {
  medicine_id: number;
  medicine_name: string;
  salt: string;
  price_paise: number;
  rx_required: number;
}
interface LedgerRow {
  id: number;
  medicine_name: string;
  from_name: string;
  to_name: string;
  qty: number;
  wholesale_amount: number;
  platform_fee: number;
  created_at: string;
}
interface DeliveryRow {
  id: number;
  request_id: number;
  status: string;
  partner_name: string | null;
  vehicle_number: string | null;
  destination_address: string;
}

const TABS = [
  { key: "requests", label: "Incoming requests", icon: <ClipboardList className="h-4 w-4" /> },
  { key: "inventory", label: "Inventory", icon: <Boxes className="h-4 w-4" /> },
  { key: "batches", label: "Batches", icon: <Link2 className="h-4 w-4" /> },
  { key: "transfers", label: "Transfers", icon: <ArrowRightLeft className="h-4 w-4" /> },
  { key: "ledger", label: "Ledger", icon: <Wallet className="h-4 w-4" /> },
  { key: "payouts", label: "Payouts", icon: <Banknote className="h-4 w-4" /> },
  { key: "deliveries", label: "Deliveries", icon: <Truck className="h-4 w-4" /> },
] as const;

export default function PharmacyConsole({
  pharmacyName,
  verification,
  pharmacyId,
}: {
  pharmacyName: string;
  verification: string;
  pharmacyId: number | null;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("requests");
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [r, i, l, d] = await Promise.all([
      api.get<{ requests: RequestRow[] }>("/api/pharmacy/requests"),
      api.get<{ inventory: InventoryRow[]; catalog: CatalogItem[] }>("/api/pharmacy/inventory"),
      api.get<{ ledger: LedgerRow[] }>("/api/pharmacy/ledger"),
      api.get<{ deliveries: DeliveryRow[] }>("/api/pharmacy/deliveries"),
    ]);
    setRequests(r.requests);
    setInventory(i.inventory);
    setCatalog(i.catalog ?? []);
    setLedger(l.ledger);
    setDeliveries(d.deliveries);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function action(id: number, path: string, label: string) {
    setBusy(id);
    try {
      await api.post(`/api/requests/${id}/${path}`);
      toast(label, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function saveInventory(row: InventoryRow, qtyTotal: number, expiry: string) {
    setBusy(row.medicine_id);
    try {
      await api.put("/api/pharmacy/inventory", {
        medicineId: row.medicine_id,
        qtyTotal,
        expiryDate: expiry || undefined,
      });
      toast("Inventory updated", "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Update failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function addStock(medicineId: number, qtyTotal: number, expiryDate: string) {
    if (!medicineId) return toast("Pick a medicine first", "error");
    if (qtyTotal < 1) return toast("Quantity must be at least 1", "error");
    setBusy(medicineId);
    try {
      await api.put("/api/pharmacy/inventory", {
        medicineId,
        qtyTotal,
        expiryDate: expiryDate || undefined,
      });
      toast("Stock added", "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add stock", "error");
    } finally {
      setBusy(null);
    }
  }

  async function removeStock(row: InventoryRow) {
    if (!window.confirm(`Remove ${row.medicine_name} from your stock list?`)) return;
    setBusy(row.medicine_id);
    try {
      await api.del("/api/pharmacy/inventory", { medicineId: row.medicine_id });
      toast(`${row.medicine_name} removed`, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove stock", "error");
    } finally {
      setBusy(null);
    }
  }

  async function deliveryAction(id: number, path: "approve" | "reject", label: string) {
    setBusy(id);
    try {
      await api.post(`/api/pharmacy/deliveries/${id}/${path}`);
      toast(label, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Action failed", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{pharmacyName}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
            Pharmacy console
            <Badge tone={verification === "verified" ? "emerald" : "amber"}>{verification}</Badge>
          </div>
        </div>
        <Button variant="ghost" onClick={load}><RefreshCw className="h-4 w-4" /> Refresh</Button>
      </div>

      <div className="flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === "requests" && (
        <Card className="divide-y divide-slate-100">
          {requests.length === 0 && <p className="p-6 text-center text-sm text-slate-400">No requests yet.</p>}
          {requests.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <div className="font-medium text-slate-800">
                  {r.qty} × {r.medicine_name} {r.rx_verified ? <Badge tone="rose">Rx ✓</Badge> : null}
                </div>
                <div className="text-xs text-slate-500">
                  {r.customer_name} · {r.fulfilment_type} · {timeAgo(r.created_at)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={r.status} />
                {r.status === "NeedsVerification" && (
                  <Button variant="ghost" loading={busy === r.id} onClick={() => action(r.id, "verify", "Prescription verified")}>
                    Verify Rx
                  </Button>
                )}
                {["Sourcing", "NeedsVerification", "PartialOffer"].includes(r.status) && (
                  <>
                    <Button loading={busy === r.id} onClick={() => action(r.id, "confirm", "Request confirmed")}>Confirm</Button>
                    <Button variant="danger" loading={busy === r.id} onClick={() => action(r.id, "reject", "Request rejected")}>Reject</Button>
                  </>
                )}
                {r.status === "Confirmed" && (
                  <Button loading={busy === r.id} onClick={() => action(r.id, "ready", "Marked ready")}>
                    {r.fulfilment_type === "delivery" ? "Ready for pickup" : "Mark ready"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}

      {tab === "inventory" && (
        <div className="space-y-4">
          <AddStockForm catalog={catalog} listed={inventory} busy={busy} onAdd={addStock} />

          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
                <tr>
                  <th className="p-3">Medicine</th>
                  <th className="p-3">Stock</th>
                  <th className="p-3">Locked</th>
                  <th className="p-3">Expiry</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {inventory.length === 0 && (
                  <tr>
                    <td className="p-6 text-center text-slate-400" colSpan={5}>
                      No stock listed yet. Use “Add stock” above to list your first medicine.
                    </td>
                  </tr>
                )}
                {inventory.map((row) => (
                  <InventoryRowEditor
                    key={row.medicine_id}
                    row={row}
                    busy={busy === row.medicine_id}
                    onSave={saveInventory}
                    onDelete={removeStock}
                  />
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {tab === "batches" && <BatchPanel />}

      {tab === "transfers" && <TransferPanel myPharmacyId={pharmacyId} />}

      {tab === "ledger" && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400">
              <tr>
                <th className="p-3">Medicine</th>
                <th className="p-3">From → To</th>
                <th className="p-3">Qty</th>
                <th className="p-3">Wholesale</th>
                <th className="p-3">Fee</th>
                <th className="p-3">When</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ledger.length === 0 && <tr><td className="p-6 text-center text-slate-400" colSpan={6}>No borrows recorded.</td></tr>}
              {ledger.map((l) => (
                <tr key={l.id}>
                  <td className="p-3">{l.medicine_name}</td>
                  <td className="p-3 text-xs text-slate-500">{l.from_name} → {l.to_name}</td>
                  <td className="p-3">{l.qty}</td>
                  <td className="p-3">{formatRupees(l.wholesale_amount)}</td>
                  <td className="p-3">{formatRupees(l.platform_fee)}</td>
                  <td className="p-3 text-xs text-slate-500">{timeAgo(l.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === "payouts" && <PayoutPanel />}

      {tab === "deliveries" && (
        <Card className="divide-y divide-slate-100">
          {deliveries.length === 0 && <p className="p-6 text-center text-sm text-slate-400">No active deliveries.</p>}
          {deliveries.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <div className="font-medium text-slate-800">Delivery #{d.id} · request #{d.request_id}</div>
                <div className="text-xs text-slate-500">{d.destination_address}</div>
                <div className="text-xs text-slate-500">{d.partner_name ?? "Unassigned"}{d.vehicle_number ? ` · ${d.vehicle_number}` : ""}</div>
              </div>
              <div className="flex items-center gap-3">
                {d.status === "AwaitingPharmacyApproval" && (
                  <>
                    <Button loading={busy === d.id} onClick={() => deliveryAction(d.id, "approve", "Rider assignment approved")}>Approve rider</Button>
                    <Button variant="danger" loading={busy === d.id} onClick={() => deliveryAction(d.id, "reject", "Rider assignment rejected")}>Reject</Button>
                  </>
                )}
                <StatusPill status={d.status} />
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* On-chain audit trail for each delivery this pharmacy is fulfilling. */}
      {tab === "deliveries" && deliveries.length > 0 && (
        <div className="space-y-4">
          {deliveries.map((d) => (
            <DeliveryAuditTimeline key={`audit-${d.id}`} deliveryId={d.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function AddStockForm({
  catalog,
  listed,
  busy,
  onAdd,
}: {
  catalog: CatalogItem[];
  listed: InventoryRow[];
  busy: number | null;
  onAdd: (medicineId: number, qty: number, expiry: string) => void;
}) {
  const listedIds = useMemo(() => new Set(listed.map((r) => r.medicine_id)), [listed]);
  const available = useMemo(
    () => catalog.filter((c) => !listedIds.has(c.medicine_id)),
    [catalog, listedIds]
  );
  const [medicineId, setMedicineId] = useState<number | "">(available[0]?.medicine_id ?? "");
  const [qty, setQty] = useState(10);
  const [expiry, setExpiry] = useState("");
  const [open, setOpen] = useState(false);

  // Keep the selection valid as the catalog/list change.
  const selectedId = listedIds.has(Number(medicineId)) ? "" : medicineId;
  const adding = busy != null && busy === Number(selectedId);

  function submit() {
    const id = Number(selectedId);
    onAdd(id, qty, expiry);
    setExpiry("");
  }

  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="flex items-center gap-2 font-semibold text-slate-900">
          <Plus className="h-4 w-4 text-teal-600" /> Add stock
        </span>
        <span className="text-sm text-slate-400">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-4 grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Medicine</span>
            <select
              value={selectedId}
              onChange={(e) => setMedicineId(e.target.value === "" ? "" : Number(e.target.value))}
              className="w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
            >
              <option value="">Select a medicine…</option>
              {available.map((c) => (
                <option key={c.medicine_id} value={c.medicine_id}>
                  {c.medicine_name} · {c.salt}
                  {c.rx_required ? " · Rx" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Quantity</span>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value)))}
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Expiry</span>
            <input
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <Button loading={adding} disabled={!selectedId} onClick={submit}>Add</Button>
          {available.length === 0 && (
            <p className="text-xs text-slate-400 sm:col-span-4">
              Every medicine in the network is already in your stock list.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function InventoryRowEditor({
  row,
  busy,
  onSave,
  onDelete,
}: {
  row: InventoryRow;
  busy: boolean;
  onSave: (row: InventoryRow, qty: number, expiry: string) => void;
  onDelete: (row: InventoryRow) => void;
}) {
  const [qty, setQty] = useState(row.qty_total);
  const [expiry, setExpiry] = useState(row.expiry_date ?? "");
  return (
    <tr>
      <td className="p-3">
        <div className="font-medium text-slate-800">{row.medicine_name}</div>
        <div className="text-xs text-slate-400">{row.salt} · {formatRupees(row.price_paise)}{row.rx_required ? " · Rx" : ""}</div>
      </td>
      <td className="p-3">
        <input
          type="number"
          min={row.qty_locked}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
          className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm"
        />
      </td>
      <td className="p-3 text-slate-500">{row.qty_locked} <span className="text-xs">({row.free} free)</span></td>
      <td className="p-3">
        <input
          type="date"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
        />
      </td>
      <td className="p-3">
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" loading={busy} onClick={() => onSave(row, qty, expiry)}>Save</Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={row.qty_locked > 0}
            title={row.qty_locked > 0 ? "Units are locked against live requests" : "Remove from stock list"}
            onClick={() => onDelete(row)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
