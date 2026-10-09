import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { StatusPill } from "@/shared/components";
import { getMRItemClaims } from "../api";

const fmt = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

const when = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString() : "—";

/**
 * "Also wanted by 3 other requests", opened up.
 *
 * The sibling of `ClaimsPanel` on the allocation screens, asking the question that
 * matters HERE. An allocator competes for the shelf, so that panel counts claims
 * against stock. A material request competes for a purchase order: what an approver
 * needs to know before signing is how much of this item the company is already about
 * to buy, and for whom — otherwise the same shortage is ordered twice, once per indent.
 *
 * Fetched only when opened. Most lines are never questioned, and a request per line on
 * load would make the screen pay for a detail nobody asked for.
 */
export function MRClaimsPanel(
  { mrId, itemId, uom }: { mrId: number; itemId: number; uom?: string | null },
) {
  const [open, setOpen] = useState(false);
  const claims = useQuery({
    queryKey: ["inventory", "mr-item-claims", mrId, itemId],
    queryFn: () => getMRItemClaims(mrId, itemId),
    enabled: open,
  });
  const data = claims.data;

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex min-h-11 items-center gap-1 rounded-lg text-sm text-warning underline decoration-dotted underline-offset-4 hover:text-warning/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        Who else wants this item
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-line bg-content2/40 p-3">
          {claims.isLoading && <p className="text-sm text-muted">Loading…</p>}
          {claims.error && (
            <p className="text-sm text-danger">{(claims.error as Error).message}</p>
          )}

          {data && (
            <>
              {/* Why buying is even on the table, then what else is queued to be
                  bought: on the shelf, spoken for, free, and asked for elsewhere. */}
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["On hand", data.total_qty],
                  ["Reserved", data.reserved_qty],
                  ["Free now", data.available_qty],
                  ["Also requested", data.claimed_total],
                ].map(([label, value]) => (
                  <div key={label as string} className="rounded-lg border border-line bg-content1 p-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                      {label}
                    </div>
                    <div className="tabular text-lg font-bold text-ink">
                      {fmt(value as number)}{" "}
                      <span className="text-xs font-normal text-muted">{uom}</span>
                    </div>
                  </div>
                ))}
              </div>

              <p className="mb-2 text-xs text-muted">
                {data.claims.length} other request{data.claims.length === 1 ? "" : "s"}
                {data.indent_count > 0 && (
                  <>
                    {" "}across {data.indent_count} indent
                    {data.indent_count === 1 ? "" : "s"}
                  </>
                )}{" "}
                {data.claims.length === 1 ? "is" : "are"} already asking to buy this
                item. Approving all of them buys the total — check whether one order
                should cover them. This request is not counted.
              </p>

              {data.claims.length === 0 ? (
                <p className="text-sm text-muted">
                  Nothing else is asking for this item right now.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-line bg-content1">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-content2 text-xs text-muted">
                      <tr>
                        <th className="p-2 font-semibold">Request</th>
                        <th className="p-2 font-semibold">For indent</th>
                        <th className="p-2 font-semibold">Raised by</th>
                        <th className="p-2 text-right font-semibold">Wants</th>
                        <th className="p-2 text-right font-semibold">Ordered</th>
                        <th className="p-2 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.claims.map((claim) => (
                        <tr key={claim.mr_id}>
                          <td className="p-2">
                            <div className="mono text-xs font-semibold text-ink">
                              {claim.mr_no}
                            </div>
                            <div className="text-[11px] text-muted">
                              {when(claim.created_at)}
                            </div>
                          </td>
                          <td className="p-2">
                            <div className="mono text-xs text-ink">
                              {claim.indent_no ?? "—"}
                            </div>
                            <div className="text-[11px] text-muted">
                              {claim.project_name ?? claim.department_name ?? "—"}
                              {claim.priority === "URGENT" && (
                                <span className="ml-1 text-danger">· Urgent</span>
                              )}
                            </div>
                          </td>
                          <td className="p-2 text-sm text-ink">
                            {claim.requested_by_name ?? "—"}
                          </td>
                          <td className="tabular p-2 text-right font-semibold text-warning">
                            {fmt(claim.quantity)}
                          </td>
                          <td className="tabular p-2 text-right text-muted">
                            {fmt(claim.ordered_quantity)}
                          </td>
                          <td className="p-2">
                            <StatusPill status={claim.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
