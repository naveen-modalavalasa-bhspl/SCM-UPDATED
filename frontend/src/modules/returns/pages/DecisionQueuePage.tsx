import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  Card, EmptyState, ErrorBanner, PageHeader, ResponsiveList, StatusPill, type Column,
} from "@/shared/components";
import { returnsApi } from "../api";
import { ReturnsNav } from "../components/ReturnsNav";
import { QUEUE, money } from "../constants";
import type { StockReturn } from "../types";

const qty = (value: string | number) => Number(value ?? 0).toLocaleString();

/**
 * The two desks' work lists — the decision desk, and the floor that endorses it.
 *
 * One component for both, because they differ only in the `queue` sent to the same
 * endpoint. That parameter is not a status filter: a return waiting for a decision and a
 * return waiting for sign-off are both PENDING_APPROVAL, so nothing but the desk can tell
 * the two backlogs apart. The backend also drops its visibility rule for a queue — these
 * desks hold no stocking point of their own, and the filter written for storekeepers would
 * hand them an empty list.
 *
 * Oldest first, because a queue is a to-do list and the branch that has been waiting
 * longest goes at the top.
 */
export default function DecisionQueuePage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const queue = pathname.endsWith("/sign-off") ? QUEUE.ENDORSEMENT : QUEUE.DECISION;
  const deciding = queue === QUEUE.DECISION;

  const [page, setPage] = useState(1);

  const { data, isLoading, error } = useQuery({
    queryKey: ["returns", "queue", queue, page],
    queryFn: () => returnsApi.list({ page, size: 20, queue }),
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.size || 20)));

  const columns: Column<StockReturn>[] = [
    {
      key: "return_no",
      header: "Return",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.return_no}</div>
          <div className="text-xs text-muted">{row.reason_label ?? row.reason ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "from",
      header: "From",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.from_warehouse_name ?? "—"}</div>
          <div className="text-xs text-muted">
            {row.raised_by_name ?? "—"}
            {row.office_name ? ` · ${row.office_name}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "qty",
      header: "Quantity",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{qty(row.total_qty)}</div>
          <div className="text-xs text-muted">
            {row.total_items} {row.total_items === 1 ? "item" : "items"}
          </div>
        </div>
      ),
    },
    {
      key: "value",
      header: "Worth",
      hideOnNarrow: true,
      // An em dash where nothing has been costed. Printing ₹0 would be a lie, and this is
      // the number the freight-versus-value call is made against.
      render: (row) => <span className="text-sm text-body">{money(row.value)}</span>,
    },
    {
      key: "intent",
      header: "Wants",
      hideOnNarrow: true,
      render: (row) => (
        <span className="text-sm text-body">{row.intent_label ?? "—"}</span>
      ),
    },
    {
      key: "state",
      header: deciding ? "Waiting since" : "Decision",
      render: (row) =>
        deciding ? (
          <div className="space-y-1 text-sm">
            <div className="text-ink">
              {row.created_at ? new Date(row.created_at).toLocaleDateString() : "—"}
            </div>
            {row.hazard_features.length > 0 && (
              <div className="flex items-center gap-1 text-xs text-warn">
                <AlertTriangle className="h-3 w-3" />
                {row.hazard_features.join(", ")}
              </div>
            )}
            {(row.decision?.objections ?? 0) > 0 && (
              <div className="text-xs text-bad">
                sent back {row.decision?.objections}×
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="text-ink">
              {row.decision?.disposition_label ?? "—"}
            </div>
            <div className="text-xs text-muted">
              {row.decision?.decided_by_name ?? ""}
            </div>
          </div>
        ),
    },
  ];

  return (
    <div>
      <ReturnsNav />

      <PageHeader
        eyebrow="RETURN"
        title={deciding ? "Decision desk" : "Awaiting sign-off"}
      />

      <Card className="mb-4 p-3">
        <p className="text-sm text-muted">
          {deciding
            ? "Returns that have cleared their reporting line. Choose where the material goes — two of the six outcomes move nothing at all."
            : "Decisions waiting to be agreed. Accept it, or send it back with a reason and the desk decides again."}
        </p>
      </Card>

      {error && <ErrorBanner error="This queue could not be loaded." />}

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.id}
        loading={isLoading}
        onRowClick={(row) => navigate(`/returns/${row.id}`)}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        empty={
          <EmptyState
            title="Nothing waiting on you"
            hint={
              deciding
                ? "Returns appear here once their reporting line has signed. If nothing ever arrives, check that your post is the first step under Receiving approvers."
                : "Decisions appear here once the desk has recorded one."
            }
          />
        }
        renderCard={(row) => (
          <button
            type="button"
            onClick={() => navigate(`/returns/${row.id}`)}
            className="block w-full p-4 text-left"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.return_no}</span>
              <StatusPill status={row.status} />
            </div>
            <div className="mt-1 text-sm text-body">
              {row.from_warehouse_name ?? "—"} · {qty(row.total_qty)} across{" "}
              {row.total_items} {row.total_items === 1 ? "item" : "items"}
            </div>
            <div className="mt-1 text-xs text-muted">
              {row.reason_label ?? row.reason ?? "—"} · {money(row.value)}
            </div>
            {!deciding && row.decision && (
              <div className="mt-1 text-xs text-brand">
                {row.decision.disposition_label}
              </div>
            )}
          </button>
        )}
      />
    </div>
  );
}
