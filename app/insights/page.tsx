"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Boxes, TrendingDown, Wallet } from "lucide-react";
import { Card, Spinner } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";

interface Insights {
  lowStock: { pharmacy_name: string; medicine_name: string; free: number; qty_total: number }[];
  expiry: { pharmacy_name: string; medicine_name: string; expiry_date: string; qty_total: number }[];
  lostSales: { total_value: number; byMedicine: { medicine_name: string; qty: number; value: number }[] };
  ledger: { wholesale: number; fee: number };
  perPharmacy: { id: number; name: string; fulfilment_count: number; response_score: number; free_stock: number }[];
  demandByArea: { area: string; demand: number; events: number }[];
}

export default function InsightsPage() {
  const [data, setData] = useState<Insights | null>(null);

  useEffect(() => {
    api.get<Insights>("/api/insights").then(setData).catch(() => {});
  }, []);

  if (!data) {
    return <div className="grid place-items-center py-20"><Spinner className="h-8 w-8 text-teal-600" /></div>;
  }

  const maxDemand = Math.max(1, ...data.demandByArea.map((d) => d.demand));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Network insights</h1>
        <p className="text-sm text-slate-500">Live availability, demand and inter-pharmacy movement across Bengaluru.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400"><Wallet className="h-4 w-4" /> Wholesale moved</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{formatRupees(data.ledger.wholesale)}</div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400"><Activity className="h-4 w-4" /> Platform fees</div>
          <div className="mt-1 text-2xl font-bold text-slate-900">{formatRupees(data.ledger.fee)}</div>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400"><TrendingDown className="h-4 w-4" /> Lost sales value</div>
          <div className="mt-1 text-2xl font-bold text-rose-600">{formatRupees(data.lostSales.total_value)}</div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900"><Boxes className="h-4 w-4 text-teal-500" /> Demand by area</h2>
          <div className="mt-4 space-y-3">
            {data.demandByArea.map((d) => (
              <div key={d.area}>
                <div className="flex justify-between text-sm text-slate-600"><span>{d.area}</span><span>{d.demand} units</span></div>
                <div className="mt-1 h-2 rounded-full bg-slate-100">
                  <div className="h-2 rounded-full bg-teal-500" style={{ width: `${(d.demand / maxDemand) * 100}%` }} />
                </div>
              </div>
            ))}
            {data.demandByArea.length === 0 && <p className="text-sm text-slate-400">No demand recorded yet.</p>}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900"><AlertTriangle className="h-4 w-4 text-amber-500" /> Low stock</h2>
          <div className="mt-4 space-y-2">
            {data.lowStock.map((l, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-slate-700">{l.medicine_name} <span className="text-xs text-slate-400">· {l.pharmacy_name}</span></span>
                <span className={l.free <= 1 ? "font-semibold text-rose-600" : "text-slate-500"}>{l.free}/{l.qty_total}</span>
              </div>
            ))}
            {data.lowStock.length === 0 && <p className="text-sm text-slate-400">All stock healthy.</p>}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold text-slate-900">Expiring within 90 days</h2>
          <div className="mt-4 space-y-2">
            {data.expiry.map((l, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-slate-700">{l.medicine_name} <span className="text-xs text-slate-400">· {l.pharmacy_name}</span></span>
                <span className="text-slate-500">{l.expiry_date} · {l.qty_total} units</span>
              </div>
            ))}
            {data.expiry.length === 0 && <p className="text-sm text-slate-400">Nothing expiring soon.</p>}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="font-semibold text-slate-900">Pharmacy performance</h2>
          <div className="mt-4 space-y-2">
            {data.perPharmacy.map((p) => (
              <div key={p.id} className="flex justify-between text-sm">
                <span className="text-slate-700">{p.name}</span>
                <span className="text-slate-500">{p.fulfilment_count} fulfilled · score {p.response_score.toFixed(2)} · {p.free_stock} free</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
