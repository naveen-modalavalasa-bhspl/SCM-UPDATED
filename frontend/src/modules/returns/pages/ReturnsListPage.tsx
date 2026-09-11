import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Input, PageHeader, ResponsiveList,
  Select, StatusPill, type Column,
} from "@/shared/components";
import { returnsApi } from "../api";
import { ReturnsNav } from "../components/ReturnsNav";
import { STATUS_FILTER_OPTIONS } from "../constants";
import type { StockReturn } from "../types";
import { TONE_MINT } from "@/shared/components/tones";

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
          <div className="text-xs text-muted">
            {row.raised_by_code ?? ""}
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
      <ReturnsNav />

      <PageHeader
        eyebrow="RETURN"
        title={title}
        actions={
          // Deliberately not wrapped in <Can do="stock.transfer">: raising a return is
          // the whole point of the screen, and hiding the only way in left storekeepers
          // on an empty page with nothing to do. The endpoint is still permission-gated
          // — a login without the code is refused at submit, which is the real check.
          <Button className={TONE_MINT} onClick={() => navigate("/returns/new")}>
            <Plus className="h-4 w-4" /> New return
          </Button>
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
        onRowClick={(row) => navigate(`/returns/${row.id}`)}
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
                : "When stock has to go back up the chain — expired, damaged or not needed — raise it here."
            }
          />
        }
        renderCard={(row) => (
          <Link to={`/returns/${row.id}`} className="block p-4">
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
