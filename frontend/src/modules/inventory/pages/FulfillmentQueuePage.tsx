import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tab, Tabs } from "@heroui/react";
import { PageHeader, ResponsiveList, StatusPill, type Column } from "@/shared/components";
import { getFulfillmentQueue } from "../api";

/**
 * What the availability check decided, per indent.
 *
 * Reads /api/indents filtered by status rather than a queue endpoint of its own: the
 * indent list already answers this question, and a second route would be a second
 * thing to keep in step.
 */
interface QueueRow {
  id: number;
  indent_no: string;
  department_name?: string | null;
  requested_by_name?: string | null;
  status: string;
  total_items: number;
  created_at: string;
}

const FILTERS = [
  // Default tab first: these are the ones actually waiting on a person.
  { key: "AWAITING_ALLOCATION", label: "To allocate" },
  { key: "ALLOCATED", label: "Ready to issue" },
  { key: "PARTIALLY_FULFILLED", label: "Part short" },
  { key: "PENDING_PROCUREMENT", label: "Nothing given" },
];

function fmtDate(s?: string | null) {
  return s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short" }) : "—";
}

export function FulfillmentQueuePage() {
  const [status, setStatus] = useState("AWAITING_ALLOCATION");
  const nav = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ["fulfillment-queue", status],
    queryFn: () => getFulfillmentQueue(status),
  });

  const rows = (data?.items ?? []) as unknown as QueueRow[];

  const columns: Column<QueueRow>[] = [
    {
      key: "no",
      header: "Indent",
      render: (r) => <span className="mono font-semibold text-ink">{r.indent_no}</span>,
    },
    { key: "req", header: "Requested by", render: (r) => r.requested_by_name ?? "—", hideOnNarrow: true },
    { key: "dept", header: "Department", render: (r) => r.department_name ?? "—" },
    {
      key: "items",
      header: "Lines",
      render: (r) => <span className="tabular text-muted">{r.total_items}</span>,
    },
    { key: "status", header: "Outcome", render: (r) => <StatusPill status={r.status} /> },
    {
      key: "date",
      header: "Approved",
      render: (r) => <span className="text-muted">{fmtDate(r.created_at)}</span>,
      hideOnNarrow: true,
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Fulfilment queue"
      />

      <p className="mb-4 text-sm text-muted">
        Approved indents after the stock check: what can be issued, and what went to
        procurement.
      </p>

      <Tabs
        aria-label="Filter by outcome"
        variant="solid"
        color="primary"
        radius="full"
        selectedKey={status}
        onSelectionChange={(k) => setStatus(String(k))}
        classNames={{ base: "mb-4", tabList: "bg-content2 p-1" }}
      >
        {FILTERS.map((f) => (
          <Tab key={f.key} title={f.label} />
        ))}
      </Tabs>

      {error ? (
        <p className="rounded-lg bg-danger-50 p-4 text-danger">{(error as Error).message}</p>
      ) : (
        <ResponsiveList
          data={rows}
          loading={isLoading}
          keyOf={(r) => r.id}
          // An indent waiting on a decision opens the allocation screen; one already
          // decided opens the indent itself. Clicking the row should do the thing the
          // row is actually asking for.
          onRowClick={(r) =>
            nav(
              r.status === "AWAITING_ALLOCATION"
                ? `/inventory/allocate/${r.id}`
                : `/indents/${r.id}`,
            )
          }
          columns={columns}
          empty="Nothing here. Indents appear once they clear approval and the stock check has run."
          renderCard={(r) => (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="mono font-semibold text-ink">{r.indent_no}</span>
                <StatusPill status={r.status} />
              </div>
              <p className="text-sm text-muted">
                {r.requested_by_name ?? "—"} · {r.department_name ?? "—"}
              </p>
              <p className="text-xs text-muted">{r.total_items} lines · {fmtDate(r.created_at)}</p>
            </div>
          )}
        />
      )}
    </>
  );
}
