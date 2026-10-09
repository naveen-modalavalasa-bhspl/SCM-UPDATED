import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Input, PageHeader, ResponsiveList,
  Select, StatusPill, type Column,
} from "@/shared/components";
import { returnsApi } from "../api";
import { STATUS_FILTER_OPTIONS } from "../constants";
import { originState } from "../origin";
import type { StockReturn } from "../types";

const qty = (value: string | number) => Number(value ?? 0).toLocaleString();

/**
 * The returns grid. One component serves three tabs — all returns, the ones waiting on
 * this person's signature, and their own — because they differ only in the filter sent
 * to the same endpoint, and three near-identical files drift apart on the first change.
 */
export default function ReturnsListPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const scope: "all" | "approvals" | "mine" = pathname.endsWith("/approvals")
    ? "approvals"
    : pathname.endsWith("/mine")
      ? "mine"
      : "all";

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["returns", "list", { page, status, search, scope }],
    queryFn: () =>
      returnsApi.list({
        page,
        size: 20,
        // The "To approve" tab is a status filter, not a separate feed: the backend
        // already flags who may act, and `can_act` is what gates the buttons.
        status: scope === "approvals" ? "PENDING_APPROVAL" : status,
        search,
        mine_only: scope === "mine",
      }),
  });

  const rows = (data?.items ?? []).filter(
    (row) => (scope === "approvals" ? row.can_act : true),
  );
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.size || 20)));

  const columns: Column<StockReturn>[] = [
    {
      key: "return_no",
      header: "Return",
      render: (row) => (
        <div>
          <div className="font-semibold text-ink">{row.return_no}</div>
          <div className="text-xs text-muted">{row.reason_label ?? row.reason ?? "—"}</div>
          {/* ADDED 2026-09-07: the indent the return answers. It is what decided who is
            * signing this row, so the approval queue has to say it — an approver seeing
            * a return in their queue can otherwise not tell why it reached them. */}
          {row.indent_no && (
            <div className="text-xs text-muted">against {row.indent_no}</div>
          )}
        </div>
      ),
    },
    {
      key: "route",
      header: "From → To",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.from_warehouse_name ?? "—"}</div>
          <div className="text-xs text-muted">to {row.to_warehouse_name ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "raised_by",
      header: "Raised by",
      hideOnNarrow: true,
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{row.raised_by_name ?? "—"}</div>
          {/* FIX 2026-09-05: the office label repeated the From column's warehouse.
            * The employee id is what identifies the raiser here. */}
          <div className="text-xs text-muted">{row.raised_by_code ?? ""}</div>
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
      key: "status",
      header: "Status",
      render: (row) => (
        <div className="space-y-1">
          <StatusPill status={row.status} />
          {row.current_approver_name && (
            <div className="text-xs text-muted">with {row.current_approver_name}</div>
          )}
        </div>
      ),
    },
  ];

  const title =
    scope === "approvals" ? "To approve" : scope === "mine" ? "My returns" : "All returns";

  return (
    <div>
      <PageHeader
        eyebrow="RETURN"
        title={title}
        actions={
          // ONE FRONT DOOR PER KIND OF SCREEN (2026-09-12). This component serves three
          // tabs and drew the button on all three, so "New return" also sat on top of
          // To approve and My returns — two READING screens. An approver's queue is
          // somebody else's work to sign, and My returns is a record of what has already
          // been raised; a create button at the top of either invites the reader to
          // start a document instead of finishing the one in front of them, and on To
          // approve it is the wrong verb entirely for the person standing there.
          //
          // It stays on ALL RETURNS and on Overview — the two screens the module is
          // entered through — and nowhere else. The route is untouched: `/returns/new`
          // is still reachable, still linked from Overview, and a bookmark still works.
          //
          // Deliberately not wrapped in <Can do="stock.transfer"> where it IS drawn:
          // raising a return is the whole point of that screen, and hiding the only way
          // in left storekeepers on an empty page with nothing to do. The endpoint is
          // still permission-gated — a login without the code is refused at submit,
          // which is the real check.
          scope === "all" ? (
            <Button onClick={() => navigate("/returns/new")}>
              <Plus className="h-4 w-4" /> New return
            </Button>
          ) : undefined
        }
      />

      {/* No KPI tiles here on purpose — the counts live on Overview alone, so the grid
       * screens are the grid and nothing else. */}
      <Card className="mb-4 p-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            placeholder="Search by return no., person, office or status…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            aria-label="Search returns"
          />
          {scope !== "approvals" && (
            <Select
              value={status}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              options={STATUS_FILTER_OPTIONS}
              placeholder="All statuses"
              ariaLabel="Filter by status"
            />
          )}
        </div>
      </Card>

      {error && <ErrorBanner error="Returns could not be loaded." />}

      <ResponsiveList
        data={rows}
        columns={columns}
        keyOf={(row) => row.id}
        loading={isLoading}
        onRowClick={(row) => navigate(`/returns/${row.id}`, { state: originState(pathname) })}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        empty={
          <EmptyState
            title={
              scope === "approvals"
                ? "Nothing waiting on you"
                : scope === "mine"
                  ? "You have not raised a return yet"
                  : "No returns yet"
            }
            hint={
              scope === "approvals"
                ? "Returns raised by your reportees appear here when it is your turn to sign."
                : scope === "mine"
                  // "Raise it here" was true while this tab carried the button. It does
                  // not any more, so the hint says where the button actually is rather
                  // than pointing at a corner of the screen with nothing in it.
                  ? "When stock has to go back up the chain — expired, damaged or not "
                    + "needed — raise it from All returns or Dashboard. It will appear here."
                  : "When stock has to go back up the chain — expired, damaged or not needed — raise it here."
            }
          />
        }
        renderCard={(row) => (
          <Link to={`/returns/${row.id}`} state={originState(pathname)} className="block p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-ink">{row.return_no}</span>
              <StatusPill status={row.status} />
            </div>
            <div className="mt-1 text-sm text-body">
              {row.from_warehouse_name ?? "—"} → {row.to_warehouse_name ?? "—"}
            </div>
            <div className="mt-1 text-xs text-muted">
              {row.reason_label ?? row.reason ?? "—"} · {qty(row.total_qty)} across{" "}
              {row.total_items} {row.total_items === 1 ? "item" : "items"}
              {row.indent_no ? ` · against ${row.indent_no}` : ""}
            </div>
            {row.current_approver_name && (
              <div className="mt-1 text-xs text-muted">
                with {row.current_approver_name}
              </div>
            )}
          </Link>
        )}
      />
    </div>
  );
}
