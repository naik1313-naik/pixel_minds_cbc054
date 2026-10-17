"use client";

import { useCallback, useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { Card, Spinner } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";

/**
 * What the rider has actually been paid.
 *
 * Two figures, kept apart on purpose. `paid` is money in the rider's own linked
 * bank account. `owed` is money the customer has already paid but which the
 * platform holds until the handover completes — it is always the rider's, but it
 * is not yet in their account, and showing one combined "earnings" number would
 * quietly promise money that has not moved.
 */
export default function RiderEarnings() {
  const [data, setData] = useState<{
    paidPaise: number;
    owedPaise: number;
    deliveries: number;
    feePerDeliveryPaise: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{
        paidPaise: number;
        owedPaise: number;
        deliveries: number;
        feePerDeliveryPaise: number;
      }>("/api/rider/earnings");
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load earnings");
    }
  }, []);

  useEffect(() => {
    void load();
    // Re-read when a payment event lands on the rider channel, so a completed
    // delivery updates the figure without a manual refresh.
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error) {
    return (
      <Card className="p-4 text-sm text-amber-800">
        Earnings are unavailable right now: {error}
      </Card>
    );
  }
  if (!data) {
    return (
      <Card className="p-5">
        <Spinner className="h-5 w-5 text-teal-600" />
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <Wallet className="h-4 w-4 text-slate-400" /> Your earnings
        </h2>
        <span className="text-xs text-slate-500">
          {formatRupees(data.feePerDeliveryPaise)} per delivery
        </span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-emerald-50 p-3">
          <p className="text-xs text-emerald-700">Paid to your account</p>
          <p className="mt-1 text-lg font-semibold text-emerald-900">
            {formatRupees(data.paidPaise)}
          </p>
        </div>
        <div className="rounded-xl bg-amber-50 p-3">
          <p className="text-xs text-amber-700">Earned, not yet paid out</p>
          <p className="mt-1 text-lg font-semibold text-amber-900">
            {formatRupees(data.owedPaise)}
          </p>
        </div>
        <div className="rounded-xl bg-slate-50 p-3">
          <p className="text-xs text-slate-600">Deliveries paid for</p>
          <p className="mt-1 text-lg font-semibold text-slate-900">{data.deliveries}</p>
        </div>
      </div>

      {data.owedPaise > 0 ? (
        <p className="mt-3 text-xs text-slate-500">
          The delivery fee is transferred to your linked account the moment you complete a handover —
          it is yours from the moment the customer pays, and it is not MediMesh revenue.
        </p>
      ) : null}
    </Card>
  );
}