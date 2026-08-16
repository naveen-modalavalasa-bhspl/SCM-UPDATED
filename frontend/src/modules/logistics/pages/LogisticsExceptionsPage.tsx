import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Can, Card, ConfirmModal, ErrorBanner, Field, Input, PageHeader,
  ResponsiveList, StatCard, useAction, type Column,
} from "@/shared/components";
import { fmtDateTime } from "@/shared/datetime";
import { transportApi } from "../api";
import { money } from "../components/modeCopy";
import type { ShipmentEvent } from "../transportTypes";

const SIZE = 20;

const TONE: Record<string, string> = {
  DAMAGED: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  MISSING: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  DELAYED: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

/**
 * Open claims against carriers — damage, shortage, delay.
 *
 * Only unresolved ones: a claim that has been settled is history and lives on the
 * consignment's own timeline. This screen exists to be emptied.
 */
export function LogisticsExceptionsPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [resolving, setResolving] = useState<ShipmentEvent | null>(null);
  const [note, setNote] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["transport-exceptions", page],
    queryFn: () => transportApi.exceptions({ page, size: SIZE }),
  });

  const resolve = useAction({
    run: () => transportApi.resolveException(resolving!.id, note),
    success: "Claim settled",
    invalidates: [["transport-exceptions"], ["transport"]],
    onDone: () => { setResolving(null); setNote(""); },
  });

  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / SIZE));
  const claimed = rows.reduce((sum, row) => sum + Number(row.claim_amount ?? 0), 0);

  const columns: Column<ShipmentEvent>[] = [
    {
      key: "type",
      header: "Claim",
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
          TONE[r.event_type] ?? "bg-slate-100 text-slate-700"}`}>
          {r.event_type.toLowerCase()}
        </span>
      ),
    },
    {
      key: "what",
      header: "What",
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">
            {r.affected_item_name ?? r.description ?? "—"}
          </div>
          {r.affected_qty != null && (
            <div className="text-[11px] text-muted">
              {Number(r.affected_qty)} affected
            </div>
          )}
        </div>
      ),
    },
    { key: "where", header: "Where", hideOnNarrow: true, render: (r) => r.location_name ?? "—" },
    {
      key: "when",
      header: "Raised",
      render: (r) => (
        <span className="text-sm text-muted">{fmtDateTime(r.event_at)}</span>
      ),
    },
    {
      key: "value",
      header: "Claim value",
      className: "text-right",
      render: (r) => (
        <span className="font-semibold text-ink">{money(r.claim_amount)}</span>
      ),
    },
    {
      key: "act",
      header: "",
      render: (r) => (
        <Can do="transport.exception">
          <Button variant="ghost" onClick={() => setResolving(r)}>Settle</Button>
        </Can>
      ),
    },
  ];

  return (
    <div>
      <PageHeader eyebrow="Logistics" title="Exceptions" />

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <StatCard label="Open claims" value={data?.total ?? 0} />
        <StatCard label="Value on this page" value={money(claimed)} />
      </div>

      <ErrorBanner error={error ?? resolve.error} />

      <Card className="p-2">
        <ResponsiveList
          data={rows}
          columns={columns}
          keyOf={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => r.tr_id && nav(`/logistics/transport/${r.tr_id}`)}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          empty="No open claims. Nothing has gone missing or arrived damaged."
          renderCard={(r) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  TONE[r.event_type] ?? "bg-slate-100 text-slate-700"}`}>
                  {r.event_type.toLowerCase()}
                </span>
                <span className="text-sm font-semibold text-ink">
                  {money(r.claim_amount)}
                </span>
              </div>
              <div className="text-sm text-body">
                {r.affected_item_name ?? r.description ?? "—"}
              </div>
              <div className="text-[11px] text-muted">{fmtDateTime(r.event_at)}</div>
            </div>
          )}
        />
      </Card>

      <ConfirmModal
        isOpen={Boolean(resolving)}
        title="Settle this claim"
        message="Say what was agreed with the provider. The claim closes and the consignment can be closed."
        confirmLabel="Settle"
        busy={resolve.isPending}
        confirmDisabled={!note.trim()}
        onConfirm={() => resolve.mutate()}
        onClose={() => { setResolving(null); setNote(""); }}
      >
        <Field label="Settlement">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmModal>
    </div>
  );
}
