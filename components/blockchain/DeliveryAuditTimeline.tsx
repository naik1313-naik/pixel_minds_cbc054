"use client";

import { useCallback, useEffect, useState } from "react";
import { PackageCheck } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { api } from "@/lib/client";
import { TransactionRef } from "./BlockchainStatus";

interface Milestone {
  id: number;
  milestone: string;
  milestone_code: number;
  actor_role: string;
  actor_wallet: string | null;
  tx_hash: string | null;
  block_number: number | null;
  status: string;
  error: string | null;
  created_at: string;
}

interface Payload {
  deliveryId: number;
  orderRef: string;
  deliveryStatus: string;
  milestones: Milestone[];
}

const ORDER = ["Packed", "PickedUp", "OutForDelivery", "Delivered"];

/**
 * On-chain delivery audit timeline.
 *
 * Read-only and honest: a milestone shows a transaction reference only after
 * one was actually submitted and confirmed. Nothing here asserts that a parcel
 * physically arrived — it records that an authorized actor reported the step.
 */
export default function DeliveryAuditTimeline({ deliveryId }: { deliveryId: number }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api.get<Payload>(`/api/blockchain/deliveries/${deliveryId}/events`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the audit trail");
    }
  }, [deliveryId]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <Card className="p-4 text-sm text-slate-500">
        <p className="font-medium text-slate-700">Delivery audit trail</p>
        <p className="mt-1 text-xs">{error}</p>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="p-4 text-sm text-slate-400">
        <PackageCheck className="mb-1 h-4 w-4" /> Loading audit trail…
      </Card>
    );
  }

  const byMilestone = new Map(data.milestones.map((m) => [m.milestone, m]));
  const reached = data.milestones.filter((m) => m.status === "Recorded").length;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-slate-900">
          <PackageCheck className="h-4 w-4 text-teal-600" /> On-chain delivery audit
        </h3>
        <span className="font-mono text-xs text-slate-400">{data.orderRef}</span>
      </div>

      <p className="mt-1 text-xs text-slate-500">
        {reached} of 4 milestones recorded on the local chain
        {data.deliveryStatus ? ` · app status: ${data.deliveryStatus.replace(/([a-z])([A-Z])/g, "$1 $2")}` : ""}
      </p>

      <ol className="mt-4 space-y-3">
        {ORDER.map((name, idx) => {
          const row = byMilestone.get(name);
          const recorded = row?.status === "Recorded";
          const failed = row?.status === "Failed";
          return (
            <li key={name} className="flex gap-3">
              <div className="flex flex-col items-center">
                <span
                  aria-hidden
                  className={`mt-1 h-2.5 w-2.5 rounded-full ${
                    recorded ? "bg-teal-500" : failed ? "bg-rose-500" : "bg-slate-200"
                  }`}
                />
                {idx < ORDER.length - 1 && <span className="mt-1 w-px flex-1 bg-slate-200" />}
              </div>
              <div className="min-w-0 flex-1 pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-sm font-medium ${
                      recorded ? "text-slate-800" : "text-slate-400"
                    }`}
                  >
                    {name.replace(/([a-z])([A-Z])/g, "$1 $2")}
                  </span>
                  {recorded && <Badge tone="emerald">Recorded</Badge>}
                  {failed && <Badge tone="rose">Failed</Badge>}
                  {row?.status === "Pending" && <Badge tone="amber">Pending</Badge>}
                </div>
                {recorded && (
                  <div className="mt-0.5 flex flex-wrap items-center gap-3">
                    <TransactionRef txHash={row!.tx_hash} blockNumber={row!.block_number} />
                    {row!.actor_wallet && (
                      <span className="font-mono text-xs text-slate-400">
                        {row!.actor_wallet.slice(0, 8)}…
                      </span>
                    )}
                  </div>
                )}
                {!recorded && row?.error && <p className="mt-0.5 text-xs text-rose-600">{row.error}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        This is an audit trail of milestones reported by authorized actors. It does not by itself prove a parcel
        physically arrived, and it never contains customer names, addresses or GPS traces.
      </p>
    </Card>
  );
}
