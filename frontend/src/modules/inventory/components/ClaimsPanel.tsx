import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { StatusPill } from "@/shared/components";
import { getItemClaims } from "../api";

const fmt = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);

const when = (value: string | null) =>
  value ? new Date(value).toLocaleDateString() : "—";

/**
 * "12 claimed by other indents", opened up.
 *
 * The number alone tells an allocator that something is in the way and nothing about
 * what: the next question is always WHICH indents, how much each, from which point,
 * and whether those claims are signed or still waiting. Fetched only when the row is
 * opened — most lines are never questioned, and one request per line on load would
 * make the screen pay for a detail nobody asked for.
 */
export function ClaimsPanel(
  { itemId, indentId, demand, uom }: {
    itemId: number;
    indentId: number;
    demand: number;
    uom: string | null;
  },
) {
  const [open, setOpen] = useState(false);
  const claims = useQuery({
    queryKey: ["inventory", "item-claims", itemId, indentId],
    queryFn: () => getItemClaims(itemId, indentId),
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
        {fmt(demand)} claimed by other indents
      </button>

      {open && (
        <div className="mt-2 rounded-xl border border-line bg-content2/40 p-3">
          {claims.isLoading && <p className="text-sm text-muted">Loading claims…</p>}
          {claims.error && (
            <p className="text-sm text-danger">{(claims.error as Error).message}</p>
          )}

          {data && (
            <>
              {/* The four numbers behind the decision, in the order the question is
                  asked: what is on the shelf, what of it is already spoken for, what
                  is free, and what these other indents are holding on top. */}
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["On hand", data.total_qty],
                  ["Reserved", data.reserved_qty],
                  ["Free now", data.available_qty],
                  ["Claimed", data.claimed_total],
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
                {data.claims.length} allocation{data.claims.length === 1 ? "" : "s"} across{" "}
                {data.indent_count} indent{data.indent_count === 1 ? "" : "s"} are holding
                this item. A claim holds stock off the shelf from the moment it is raised
                until it is approved or cancelled — this indent is not counted.
              </p>

              {data.claims.length === 0 ? (
                <p className="text-sm text-muted">
                  Nothing else is claiming this item right now.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-line bg-content1">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-content2 text-xs text-muted">
                      <tr>
                        <th className="p-2 font-semibold">Indent</th>
                        <th className="p-2 font-semibold">Raised by</th>
                        <th className="p-2 text-right font-semibold">Claiming</th>
                        <th className="p-2 text-right font-semibold">Giving</th>
                        <th className="p-2 font-semibold">From point</th>
                        <th className="p-2 font-semibold">Allocation</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {data.claims.map((claim) => (
                        <tr key={`${claim.allocation_id}-${claim.warehouse_id ?? 0}`}>
                          <td className="p-2">
                            <div className="mono text-xs font-semibold text-ink">
                              {claim.indent_no ?? `Indent ${claim.indent_id}`}
                            </div>
                            <div className="text-[11px] text-muted">
                              {claim.office_name ?? "—"}
                              {claim.priority === "URGENT" && (
                                <span className="ml-1 text-danger">· Urgent</span>
                              )}
                            </div>
                          </td>
                          <td className="p-2">
                            <div className="text-sm text-ink">{claim.requested_by_name ?? "—"}</div>
                            <div className="text-[11px] text-muted">
                              decided by {claim.allocated_by_name ?? "—"}
                            </div>
                          </td>
                          <td className="tabular p-2 text-right font-semibold text-warning">
                            {fmt(claim.claimed_qty)}
                          </td>
                          <td className="tabular p-2 text-right text-ink">
                            {fmt(claim.giving_qty)}
                          </td>
                          <td className="p-2 text-sm text-body">
                            {claim.warehouse_name ?? "Not allocated"}
                          </td>
                          <td className="p-2">
                            <div className="mono text-xs text-ink">{claim.allocation_no}</div>
                            <div className="mt-1 flex items-center gap-2">
                              <StatusPill status={claim.status} />
                              <span className="text-[11px] text-muted">
                                {when(claim.created_at)}
                              </span>
                            </div>
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
