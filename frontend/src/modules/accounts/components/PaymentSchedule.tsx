import { Paperclip } from "lucide-react";
import { StatusPill, errorMessage, useToast } from "@/shared/components";
import { downloadFile } from "../api";
import { fmtDate } from "@/shared/datetime";
import { STATE_META, type Milestone, type PoPayments, type VendorPayment } from "../types";

export const money = (value: number | null | undefined) =>
  `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(value ?? 0)}`;

/** The three numbers anyone asks first: what the order is worth, what has gone out,
 *  and what is still owed. */
export function PaymentTotals({ data }: { data: PoPayments }) {
  const tiles = [
    ["Order value", data.total_amount, "text-ink"],
    ["Paid", data.paid, "text-emerald-700"],
    ["Awaiting approval", data.pending, "text-amber-700"],
    ["Outstanding", data.outstanding, data.outstanding > 0 ? "text-red-700" : "text-emerald-700"],
  ] as const;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map(([label, value, tone]) => (
        <div key={label} className="rounded-xl border border-line/70 bg-content1 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
          <div className={`mt-1 text-base font-bold tabular-nums ${tone}`}>{money(value)}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The order's payment terms, milestone by milestone: share, amount, when it falls due,
 * what is paid and what is left. `onPay` adds a "Record payment" press per milestone
 * (accounts desk only); without it the table is a read — which is what the PO desk sees.
 */
export function MilestoneTable({
  milestones, onPay,
}: { milestones: Milestone[]; onPay?: (m: Milestone) => void }) {
  if (!milestones.length) {
    return <p className="text-sm text-muted">This order has no payment term picked.</p>;
  }
  return (
    <div className="space-y-2">
      {milestones.map((m) => (
        <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line/70 bg-content1 p-3">
          <div className="min-w-[12rem] flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-ink">{m.label}</span>
              <span className="text-xs text-muted">{m.percent}%</span>
            </div>
            <div className="text-xs text-muted">
              {m.trigger}{m.due_days ? `, within ${m.due_days} days` : ""}
              {m.due_date ? ` · due ${fmtDate(m.due_date)}` : ""}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-right text-sm tabular-nums">
            <div><div className="text-[11px] uppercase text-muted">Amount</div>{money(m.amount)}</div>
            <div>
              <div className="text-[11px] uppercase text-muted">Paid</div>{money(m.paid)}
              {m.pending > 0 && (
                <div className="text-[11px] font-semibold text-amber-700">+{money(m.pending)} awaiting approval</div>
              )}
            </div>
            <div><div className="text-[11px] uppercase text-muted">Left</div>{money(m.balance)}</div>
          </div>
          <StatusPill status={STATE_META[m.state].pill} label={STATE_META[m.state].label} />
          {onPay && m.balance > 0 && (
            <button type="button" onClick={() => onPay(m)}
              className="inline-flex min-h-11 items-center rounded-xl bg-brand px-4 text-sm font-semibold text-white hover:opacity-90">
              Record payment
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Every payment recorded against the order, newest first. `onAct` adds Approve /
 *  Reject on the rows this login may sign (`can_act`, served by the server). */
export function PaymentList({
  payments, onAct, proofUrl = (p, id) => `/api/accounts/payments/${p.id}/proofs/${id}/download`,
}: {
  payments: VendorPayment[];
  onAct?: (p: VendorPayment, action: "APPROVE" | "REJECT") => void;
  /** Where a proof downloads from — the accounts route by default, the PO desk's own
   *  route (behind po.view) from the PO screen. */
  proofUrl?: (p: VendorPayment, attachmentId: number) => string;
}) {
  const toast = useToast();
  if (!payments.length) return <p className="text-sm text-muted">No payments recorded yet.</p>;
  return (
    <ul className="divide-y divide-line/70 rounded-xl border border-line/70">
      {payments.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          <div className="min-w-[12rem] flex-1">
            <div className="text-sm font-semibold text-ink">
              {money(p.amount)} · {p.stage_label ?? p.stage}
            </div>
            <div className="text-xs text-muted">
              {p.payment_no} · {fmtDate(p.paid_on)} · {p.mode}
              {p.reference_no ? ` · ${p.reference_no}` : ""}
              {p.created_by_name ? ` · by ${p.created_by_name}` : ""}
              {p.status === "PENDING_APPROVAL" && p.current_approver_name
                ? ` · with ${p.current_approver_name}` : ""}
            </div>
            {p.remarks && <div className="mt-0.5 whitespace-pre-line text-xs text-body">{p.remarks}</div>}
            {p.proofs.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {p.proofs.map((d) => (
                  <button key={d.id} type="button"
                    onClick={() => downloadFile(proofUrl(p, d.id), d.file_name)
                      .catch((e) => toast.error(errorMessage(e)))}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-line/70 px-2.5 text-xs font-semibold text-brand hover:bg-brand-050">
                    <Paperclip className="h-3.5 w-3.5" />{d.file_name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-0.5 text-xs text-muted">No payment proof attached</div>
            )}
          </div>
          <StatusPill status={p.status === "PAID" ? "APPROVED" : p.status}
            label={p.status === "PAID" ? "Paid" : undefined} />
          {onAct && p.can_act && (
            <div className="flex gap-2">
              <button type="button" onClick={() => onAct(p, "APPROVE")}
                className="min-h-11 rounded-xl bg-emerald-600 px-4 text-sm font-semibold text-white hover:opacity-90">
                Approve
              </button>
              <button type="button" onClick={() => onAct(p, "REJECT")}
                className="min-h-11 rounded-xl border border-red-300 px-4 text-sm font-semibold text-red-700 hover:bg-red-50">
                Reject
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
