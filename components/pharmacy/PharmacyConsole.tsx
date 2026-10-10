"use client";

import { useCallback, useEffect, useState } from "react";
import { Boxes, ClipboardList, RefreshCw, Truck, Wallet } from "lucide-react";
import { Badge, Button, Card, StatusPill, toast } from "@/components/ui";
import { api, formatRupees, timeAgo } from "@/lib/client";

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
  { key: "ledger", label: "Ledger", icon: <Wallet className="h-4 w-4" /> },
  { key: "deliveries", label: "Deliveries", icon: <Truck className="h-4 w-4" /> },
] as const;

export default function PharmacyConsole({
  pharmacyName,
  verification,
}: {
  pharmacyName: string;
  verification: string;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("requests");
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [r, i, l, d] = await Promise.all([
      api.get<{ requests: RequestRow[] }>("/api/pharmacy/requests"),
      api.get<{ inventory: InventoryRow[] }>("/api/pharmacy/inventory"),
      api.get<{ ledger: LedgerRow[] }>("/api/pharmacy/ledger"),
      api.get<{ deliveries: DeliveryRow[] }>("/api/pharmacy/deliveries"),
    ]);
    setRequests(r.requests);
    setInventory(i.inventory);
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
              {inventory.map((row) => (
                <InventoryRowEditor key={row.medicine_id} row={row} busy={busy === row.medicine_id} onSave={saveInventory} />
              ))}
            </tbody>
          </table>
        </Card>
      )}

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
    </div>
  );
}

function InventoryRowEditor({
  row,
  busy,
  onSave,
}: {
  row: InventoryRow;
  busy: boolean;
  onSave: (row: InventoryRow, qty: number, expiry: string) => void;
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
      <td className="p-3 text-right">
        <Button variant="ghost" loading={busy} onClick={() => onSave(row, qty, expiry)}>Save</Button>
      </td>
    </tr>
  );
}
