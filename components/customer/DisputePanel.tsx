"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Alert, Button, Card, toast } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";

/**
 * Lets a customer report a problem with an order they have already paid for.
 *
 * Shown once money has moved, which is exactly when a refund can no longer be
 * automatic — so the copy says what actually happens next rather than implying
 * a button here will return the money.
 */

interface Dispute {
  id: number;
  category: string;
  categoryLabel: string;
  reason: string;
  status: string;
  response: string | null;
  resolution: string | null;
  recoverable_paise: number;
  created_at: string;
}

const STATUS_TONE: Record<string, string> = {
  Open: "bg-amber-100 text-amber-800",
  Responded: "bg-sky-100 text-sky-800",
  RefundApproved: "bg-emerald-100 text-emerald-800",
  Rejected: "bg-slate-100 text-slate-700",
  Withdrawn: "bg-slate-100 text-slate-700",
};

const STATUS_TEXT: Record<string, string> = {
  Open: "Waiting for the pharmacy to reply",
  Responded: "Pharmacy replied — an admin will decide",
  RefundApproved: "Resolved in your favour",
  Rejected: "Not upheld",
};

export default function DisputePanel({ requestId }: { requestId: number }) {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [categories, setCategories] = useState<{ value: string; label: string }[]>([]);
  const [canRaise, setCanRaise] = useState(false);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{
        disputes: Dispute[];
        categories: { value: string; label: string }[];
        canRaise: boolean;
      }>(`/api/requests/${requestId}/disputes`);
      setDisputes(res.disputes);
      setCategories(res.categories);
      setCanRaise(res.canRaise);
      if (!category && res.categories[0]) setCategory(res.categories[0].value);
    } catch {
      /* a dispute panel must never be the thing that breaks the page */
    }
  }, [requestId, category]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/api/requests/${requestId}/disputes`, { category, reason });
      toast("Reported. The pharmacy will get back to you.", "success");
      setReason("");
      setOpen(false);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not raise this", "error");
    } finally {
      setBusy(false);
    }
  }

  if (disputes.length === 0 && !canRaise) return null;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-semibold text-slate-900">
          <AlertTriangle className="h-4 w-4 text-slate-400" /> Something wrong?
        </h2>
        {canRaise ? (
          <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {open ? "Cancel" : "Report a problem"}
          </Button>
        ) : null}
      </div>

      {open && canRaise ? (
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            {categories.map((c) => (
              <label key={c.value} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="radio"
                  name={`dispute-category-${requestId}`}
                  value={c.value}
                  checked={category === c.value}
                  onChange={() => setCategory(c.value)}
                />
                {c.label}
              </label>
            ))}
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Tell us what happened"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
          />
          <Alert kind="info">
            <span>
              If your order is paid but not yet delivered, the pharmacy can simply refund it. Once a
              pharmacy has been paid, an admin decides and any recovery is handled offline.
            </span>
          </Alert>
          <Button onClick={submit} loading={busy} disabled={reason.trim().length < 5}>
            Send report
          </Button>
        </div>
      ) : null}

      {disputes.length > 0 ? (
        <div className="mt-4 space-y-3">
          {disputes.map((d) => (
            <div key={d.id} className="rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-800">{d.categoryLabel}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[d.status]}`}>
                  {d.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">{d.reason}</p>
              <p className="mt-1 text-xs text-slate-400">{STATUS_TEXT[d.status] ?? d.status}</p>
              {d.response ? (
                <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-medium text-slate-700">Pharmacy replied:</span> {d.response}
                </p>
              ) : null}
              {d.resolution ? (
                <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-medium text-slate-700">Decision:</span> {d.resolution}
                  {d.recoverable_paise > 0 ? (
                    <span className="mt-1 block text-slate-500">
                      {formatRupees(d.recoverable_paise)} is being recovered from the pharmacy by an
                      admin.
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}