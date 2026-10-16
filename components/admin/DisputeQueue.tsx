"use client";

import { useCallback, useEffect, useState } from "react";
import { Scale, RefreshCw } from "lucide-react";
import { Alert, Button, Card, Spinner, toast } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";

/**
 * The operator's dispute queue.
 *
 * The decision that matters is the one the code cannot make: when a payout has
 * already reached the pharmacy, approving a refund does not move money — it
 * records that the pharmacy owes it. The UI says so rather than showing a
 * green success that did not happen.
 */

interface DisputeRow {
  id: number;
  request_id: number;
  customer_name: string;
  pharmacy_name: string | null;
  categoryLabel: string;
  reason: string;
  status: string;
  response: string | null;
  resolution: string | null;
  recoverable_paise: number;
  amount_paise: number | null;
  created_at: string;
}

export default function DisputeQueue() {
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ disputes: DisputeRow[] }>("/api/admin/disputes");
      setRows(res.disputes);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load disputes", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(id: number, outcome: "refund" | "reject") {
    const note = window.prompt(
      outcome === "refund"
        ? "Note for the record (why the customer is owed this):"
        : "Note for the record (why this is not upheld):"
    );
    if (note === null) return;
    setBusy(id);
    try {
      const res = await api.post<{ refundedPaise: number | null; offline: boolean }>(
        "/api/admin/disputes",
        { action: "resolve", disputeId: id, outcome, note }
      );
      toast(
        res.offline
          ? "Recorded as an amount recoverable from the pharmacy — the payout had already gone out, so no gateway refund was attempted."
          : res.refundedPaise
            ? `Refunded ${formatRupees(res.refundedPaise)} through the gateway`
            : "Resolved",
        res.offline ? "error" : "success"
      );
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not resolve", "error");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <Card className="p-5">
        <Spinner className="h-6 w-6 text-teal-600" />
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <Scale className="h-4 w-4 text-slate-400" /> Disputes ({rows.length})
        </h2>
        <Button variant="ghost" onClick={load}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">Nothing waiting on a decision.</p>
      ) : (
        <div className="mt-4 space-y-3">
          {rows.map((d) => (
            <div key={d.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-medium text-slate-800">
                    Order #{d.request_id} · {d.categoryLabel}
                  </p>
                  <p className="text-xs text-slate-500">
                    {d.customer_name} → {d.pharmacy_name ?? "unassigned"}
                    {d.amount_paise ? ` · ${formatRupees(d.amount_paise)}` : ""}
                  </p>
                </div>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                  {d.status}
                </span>
              </div>

              <p className="mt-2 text-sm text-slate-700">{d.reason}</p>
              {d.response ? (
                <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-medium text-slate-700">Pharmacy:</span> {d.response}
                </p>
              ) : (
                <p className="mt-2 text-xs text-amber-700">The pharmacy has not replied yet.</p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button className="text-xs" onClick={() => resolve(d.id, "refund")} loading={busy === d.id}>
                  Uphold — refund
                </Button>
                <Button
                  className="text-xs"
                  variant="ghost"
                  onClick={() => resolve(d.id, "reject")}
                  loading={busy === d.id}
                >
                  Not upheld
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Alert kind="info">
        <span>
          Refunds are only automatic while the payment is still captured. Once a pharmacy has been
          paid, upholding a dispute records an amount the pharmacy owes MediMesh — recovery happens
          offline, and this screen will not claim otherwise.
        </span>
      </Alert>
    </Card>
  );
}