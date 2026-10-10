import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ListFilter, Package } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  Button, Card, EmptyState, ErrorBanner, Input, ResponsiveList,
  StatusPill, type Column,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { indentApi } from "../api";
import type { DirectIssueAck } from "../types";
import { FILTER_PILL_ON } from "../buttonTones";

/**
 * Material issues raised DIRECT — against no indent — and handed to this person.
 *
 * An issue against an indent is confirmed on that indent's acknowledgement. A direct
 * issue has no indent, so it is signed by its RECEIVER: the point it was dispatched
 * to (once out of the gate), or the employee it was issued TO (SCM_0013).
 */
export function DirectIssueAcknowledgements() {
  const [search, setSearch] = useState("");
  // Off by default, as on the indent tab: an acknowledged issue must stay findable.
  const [onlyActionable, setOnlyActionable] = useState(false);
  const nav = useNavigate();
  // The same receipt journey an indent gets: consignment, packages, codes, photos.
  const open = (row: DirectIssueAck) => nav(`/indents/acknowledgements/issue/${row.issue_id}`);
  // Same pair the endpoint accepts; the server decides whose issue it is.
  const { can } = useAuth();
  const mayAck = can("indent.acknowledge") || can("stock.transfer.receive");

  const params = { search: search.trim() || undefined, only_actionable: onlyActionable || undefined };
  const issues = useQuery({
    queryKey: ["direct-issue-acknowledgements", params],
    queryFn: () => indentApi.myDirectIssues(params),
  });

  const rows = issues.data ?? [];

  /** The consignment(s) the issue travels on, each with its package count beneath. */
  const consignment = (row: DirectIssueAck) => {
    const list = row.consignments ?? [];
    if (list.length === 0) return <span className="text-[11px] text-muted">Not yet consigned</span>;
    return (
      <div className="space-y-1.5">
        {list.map((c) => (
          <div key={c.dispatch_id} className="min-w-0">
            <div className="truncate font-mono text-xs font-semibold text-ink">{c.dispatch_no}</div>
            <div className="inline-flex items-center gap-1 text-[11px] text-muted">
              <Package className="h-3 w-3" aria-hidden />
              {c.package_count} package{c.package_count === 1 ? "" : "s"}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const columns: Column<DirectIssueAck>[] = [
    {
      key: "issue",
      header: "Issue",
      render: (row) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{row.issue_no}</div>
          <div className="text-[11px] text-muted">{row.issue_date ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "from",
      header: "From",
      hideOnNarrow: true,
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-body">{row.warehouse_name ?? "—"}</div>
          {row.issued_by_name && <div className="text-[11px] text-muted">by {row.issued_by_name}</div>}
        </div>
      ),
    },
    {
      key: "consignment",
      header: "Consignment",
      render: consignment,
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <StatusPill status={row.status} />,
    },
    {
      key: "action",
      header: "",
      render: (row) => (row.can_acknowledge && mayAck ? (
        <>
          <Button onClick={() => open(row)}>
            <CheckCircle2 className="h-4 w-4" /> Acknowledge
          </Button>
        </>
      ) : row.acknowledged_at ? (
        <span className="text-[11px] text-muted">
          {row.acknowledged_by_name ?? "Acknowledged"} · {row.acknowledged_at.slice(0, 10)}
        </span>
      ) : null),
    },
  ];

  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Search direct issues"
            placeholder="Search issue no., warehouse or item…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <button
          type="button"
          aria-pressed={onlyActionable}
          onClick={() => setOnlyActionable((current) => !current)}
          className={`inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition ${
            onlyActionable
              ? FILTER_PILL_ON
              : "border-line bg-content1 text-body hover:border-brand/40 hover:bg-content2"
          }`}
        >
          <ListFilter className="h-4 w-4" />
          Ready to acknowledge
        </button>
      </Card>

      <ErrorBanner error={issues.error} />

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.issue_id}
        loading={issues.isLoading}
        onRowClick={open}
        empty={
          <EmptyState
            title={search || onlyActionable ? "Nothing waiting" : "No direct issues"}
            hint="Material issued to you directly from a store — not against an indent — appears here for you to confirm."
          />
        }
        renderCard={(row) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-xs font-semibold text-ink">{row.issue_no}</div>
                <div className="text-[11px] text-muted">{row.warehouse_name ?? "—"} · {row.issue_date ?? "—"}</div>
              </div>
              <StatusPill status={row.status} />
            </div>
            {consignment(row)}
            {row.can_acknowledge && mayAck && (
              <>
                <Button onClick={() => open(row)}>
                  <CheckCircle2 className="h-4 w-4" /> Acknowledge receipt
                </Button>
              </>
            )}
          </div>
        )}
      />

    </div>
  );
}
