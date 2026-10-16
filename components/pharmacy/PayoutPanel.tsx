"use client";

import { useCallback, useEffect, useState } from "react";
import { Banknote, ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Alert, Button, Card, Spinner, toast } from "@/components/ui";
import { api, formatRupees } from "@/lib/client";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Payout view for a pharmacy owner: what was sold, what has been credited to
 * their own account, and the on-chain receipt for each payout.
 */
interface Row {
  id: number;
  requestId: number;
  medicine: string | null;
  status: string;
  amountLabel: string;
  pharmacyAmountLabel: string;
  platformFeeLabel: string;
  payoutAccountReady: boolean;
  transferId: string | null;
  capturedAt: string | null;
  paidOutAt: string | null;
  failureReason: string | null;
  refundedAt: string | null;
  /** Opaque settlement reference; null until the payout has been anchored. */
  settlementRef: string | null;
  blockNumber: number | null;
}

export default function PayoutPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [totals, setTotals] = useState<{
    paidOutLabel: string;
    pendingLabel: string;
    count: number;
  } | null>(null);
  const [account, setAccount] = useState<{
    razorpayAccountId: string | null;
    payoutAccountStatus: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);

  const load = useCallback(async () => {
    try {
      const [res, acct] = await Promise.all([
        api.get<{ payments: Row[]; totals: typeof totals }>("/api/pharmacy/payments"),
        api.get<{ razorpayAccountId: string | null; payoutAccountStatus: string | null }>(
          "/api/pharmacy/payout-account"
        ),
      ]);
      setRows(res.payments);
      setTotals(res.totals);
      setAccount({
        razorpayAccountId: acct.razorpayAccountId,
        payoutAccountStatus: acct.payoutAccountStatus,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load payouts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A payout moves when an order is fulfilled, which usually happens on another
  // screen. Refetching on the pharmacy event stream keeps these totals honest
  // without anyone pressing Refresh.
  useEventStream("/api/pharmacy/stream", (e: unknown) => {
    const ev = e as { type?: string };
    if (ev.type === "payment" || ev.type === "request" || ev.type === "delivery") void load();
  });

  async function refund(r: Row) {
    const reason = window.prompt(
      `Refund ${r.amountLabel} to the customer for order #${r.requestId}?\n\nGive a reason — it is recorded in the audit log.`
    );
    if (reason === null) return;
    setBusy(r.id);
    try {
      await api.post(`/api/requests/${r.requestId}/refund`, { reason: reason || "Refunded by pharmacy" });
      toast(`${r.amountLabel} refunded to the customer`, "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Refund failed", "error");
    } finally {
      setBusy(null);
    }
  }

  async function linkAccount() {
    setLinking(true);
    try {
      const res = await api.post<{ onboardingUrl: string | null }>("/api/pharmacy/payout-account");
      // The gateway hosts onboarding; we never see the owner's bank details.
      if (res.onboardingUrl) window.open(res.onboardingUrl, "_blank", "noopener,noreferrer");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start payout onboarding");
    } finally {
      setLinking(false);
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
      <h2 className="flex items-center gap-2 font-semibold text-slate-900">
        <Banknote className="h-4 w-4 text-slate-400" /> Payouts
      </h2>
      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl bg-emerald-50 px-3 py-2">
          <p className="text-xs text-emerald-700">Credited to your account</p>
          <p className="text-lg font-semibold text-emerald-900">{totals?.paidOutLabel ?? "₹0"}</p>
        </div>
        <div className="rounded-xl bg-amber-50 px-3 py-2">
          <p className="text-xs text-amber-700">Awaiting fulfilment</p>
          <p className="text-lg font-semibold text-amber-900">{totals?.pendingLabel ?? "₹0"}</p>
        </div>
      </div>

      <DisputeInbox />

      <PayoutAccountBanner account={account} onLink={linkAccount} busy={linking} />

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No payments yet. A payment opens once you confirm an order.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="py-2">Order</th>
                <th className="py-2">Status</th>
                <th className="py-2 text-right">Order total</th>
                <th className="py-2 text-right">You receive</th>
                <th className="py-2 text-right">Fee</th>
                <th className="py-2 text-right">On-chain</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                // Only a PaidOut row means money has actually reached the
                // account. Printing a figure for a still-awaiting payment would
                // read as "you have been paid", which is the one thing this
                // screen must never imply.
                const paidOut = r.status === "PaidOut";
                return (
                  <tr key={r.id}>
                    <td className="py-2">
                      <p className="font-medium text-slate-800">#{r.requestId}</p>
                      <p className="text-xs text-slate-500">{r.medicine ?? "—"}</p>
                    </td>
                    <td className="py-2 text-xs">
                      <StatusChip status={r.status} />
                      {r.failureReason ? (
                        <p className="mt-1 text-rose-600">{r.failureReason}</p>
                      ) : null}
                      {/* Only a captured, not-yet-released payment can be
                          returned. Offering the button after the payout has gone
                          out would invite a click that cannot succeed. */}
                      {r.status === "Captured" ? (
                        <button
                          className="mt-1 text-xs font-medium text-rose-600 hover:underline"
                          onClick={() => refund(r)}
                          disabled={busy === r.id}
                        >
                          {busy === r.id ? "Refunding…" : "Refund customer"}
                        </button>
                      ) : null}
                    </td>
                    <td className="py-2 text-right text-slate-600">{r.amountLabel}</td>
                    <td className="py-2 text-right">
                      {paidOut ? (
                        <span className="font-medium text-slate-900">{r.pharmacyAmountLabel}</span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right text-xs text-slate-500">{r.platformFeeLabel}</td>
                    <td className="py-2 text-right text-xs">
                      {r.settlementRef ? (
                        <Link
                          href={`/verify/settlement/${r.settlementRef}`}
                          target="_blank"
                          className="inline-flex items-center gap-1 text-teal-700 hover:underline"
                        >
                          {r.blockNumber != null ? `block ${r.blockNumber}` : "verify"} <ExternalLink className="h-3 w-3" />
                        </Link>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-slate-400">
            &ldquo;You receive&rdquo; stays blank until the order is fulfilled and the payout has
            actually been routed to your account.
          </p>
        </div>
      )}
    </Card>
  );
}

function PayoutAccountBanner({
  account,
  onLink,
  busy,
}: {
  account: { razorpayAccountId: string | null; payoutAccountStatus: string | null } | null;
  onLink: () => void;
  busy: boolean;
}) {
  const status = account?.payoutAccountStatus;
  if (status === "activated") {
    return (
      <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald-700">
        <ShieldCheck className="h-3.5 w-3.5" /> Payout account linked. Payments are credited directly to
        you, and MediMesh retains only its fee.
      </p>
    );
  }
  return (
    <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
      <p>
        Payments cannot be routed until your bank account is linked. Until then no customer is charged.
      </p>
      <Button className="mt-2" onClick={onLink} disabled={busy}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {status === "submitted" ? "Check status" : "Link payout account"}
      </Button>
    </div>
  );
}

/**
 * Disputes raised against this pharmacy's orders.
 *
 * A pharmacy can answer but not decide — the operator rules. Saying so on the
 * card avoids a reply that promises a refund nobody has authorised.
 */
function DisputeInbox() {
  const [rows, setRows] = useState<
    {
      id: number;
      request_id: number;
      customer_name: string;
      categoryLabel: string;
      reason: string;
      status: string;
      response: string | null;
      resolution: string | null;
      recoverable_paise: number;
    }[]
  >([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ disputes: typeof rows }>("/api/pharmacy/disputes");
      setRows(res.disputes);
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function reply(disputeId: number) {
    const response = window.prompt("Reply to the customer");
    if (!response) return;
    setBusy(disputeId);
    try {
      await api.post("/api/pharmacy/disputes", { disputeId, response });
      toast("Reply sent", "success");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not send the reply", "error");
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return null;

  return (
    <Card className="p-5">
      <h2 className="font-semibold text-slate-900">Customer complaints ({rows.length})</h2>
      <div className="mt-3 space-y-3">
        {rows.map((d) => (
          <div key={d.id} className="rounded-xl border border-amber-200 bg-amber-50/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-slate-800">
                  Order #{d.request_id} · {d.categoryLabel}
                </p>
                <p className="text-xs text-slate-500">{d.customer_name}</p>
              </div>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs text-slate-600">{d.status}</span>
            </div>
            <p className="mt-2 text-sm text-slate-700">{d.reason}</p>
            {d.status === "Open" ? (
              <Button
                className="mt-2 text-xs"
                onClick={() => reply(d.id)}
                loading={busy === d.id}
              >
                Reply
              </Button>
            ) : d.resolution ? (
              <p className="mt-2 text-xs text-slate-600">
                <span className="font-medium">Decision:</span> {d.resolution}
                {d.recoverable_paise > 0 ? (
                  <span className="mt-1 block text-amber-800">
                    {formatRupees(d.recoverable_paise)} has been recorded as recoverable from you by
                    an admin.
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-slate-400">
        You can answer a complaint, but only an admin decides the outcome.
      </p>
    </Card>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone: Record<string, string> = {
    Awaiting: "bg-amber-100 text-amber-800",
    Captured: "bg-sky-100 text-sky-800",
    PaidOut: "bg-emerald-100 text-emerald-800",
    Refunded: "bg-slate-100 text-slate-700",
    Failed: "bg-rose-100 text-rose-800",
    Cancelled: "bg-slate-100 text-slate-700",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 ${tone[status] ?? tone.Awaiting}`}>{status}</span>
  );
}

/** Opens the gateway-hosted onboarding page in a new tab. */
export function PayoutOnboardingLink({ url }: { url: string }) {
  return (
    <a
      className="inline-flex items-center gap-1 text-xs text-teal-700 hover:underline"
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      Open secure onboarding <ExternalLink className="h-3 w-3" />
    </a>
  );
}