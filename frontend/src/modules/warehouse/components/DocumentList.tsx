import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  Button, Can, PageHeader, ResponsiveList, StatCard, type Column,
} from "@/shared/components";
import { ErrorBanner } from "@/shared/components";
import { FilterBar, FilterSelect } from "./FilterBar";
import { warehouseOptions } from "../api";
import type { ListParams, Page } from "../types";

/**
 * The scaffold behind every warehouse document list.
 *
 * Eight lists — gate entries, GRNs, inspections, putaways, picklists, issues,
 * dispatches, returns — are the same screen with different columns: header, KPI
 * strip, search + status + warehouse filters, then a `<ResponsiveList>` that opens a
 * row. Writing that eight times is how the old module ended up with eight different
 * filter layouts and three different empty states. Each list page now supplies only
 * what is actually different about it.
 *
 * Status and warehouse filter server-side (they change which rows exist); the free
 * text box filters what came back, because a storekeeper scanning a page of twenty
 * wants it to narrow as they type rather than on a round trip.
 */

export interface DocumentListProps<T> {
  eyebrow?: string;
  title: string;
  /** Cache key root — must be unique per list. */
  queryKey: string;
  fetch: (params: ListParams) => Promise<Page<T>>;
  columns: Column<T>[];
  renderCard: (row: T) => ReactNode;
  keyOf: (row: T) => string | number;
  /** Which fields the free-text box looks at. */
  searchIn: (row: T) => (string | null | undefined)[];
  searchPlaceholder?: string;
  statuses?: { value: string; label: string }[];
  /** Extra server-side filters merged into the request. */
  extraParams?: Record<string, unknown>;
  /** KPI tiles computed from the rows on screen. */
  kpis?: (rows: T[]) => { label: string; value: ReactNode; tone?: string }[];
  onRowClick?: (row: T) => void;
  /** Route to push for "new"; omit to hide the button. */
  createTo?: string;
  /** Opens a modal instead of a route. Takes precedence over `createTo`. */
  onCreate?: () => void;
  createLabel?: string;
  createPermission?: string;
  empty?: string;
  /** Rendered between the filter bar and the list, e.g. a bulk action strip. */
  children?: ReactNode;
  /** Hides the warehouse dropdown for lists that are not per-site. */
  warehouseFilter?: boolean;
}

export function DocumentList<T>({
  eyebrow = "Warehouse",
  title,
  queryKey,
  fetch,
  columns,
  renderCard,
  keyOf,
  searchIn,
  searchPlaceholder = "Search…",
  statuses = [],
  extraParams,
  kpis,
  onRowClick,
  createTo,
  onCreate,
  createLabel = "New",
  createPermission,
  empty = "Nothing here yet.",
  children,
  warehouseFilter = true,
}: DocumentListProps<T>) {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20;

  // Narrowing the list while sitting on page 4 would otherwise show an empty page
  // with no hint that the rows exist a few pages back.
  useEffect(() => {
    setPage(1);
  }, [search, status, warehouse]);

  const { data: houses = [] } = useQuery({
    queryKey: ["wh-lookup", "warehouses", ""],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60_000,
    enabled: warehouseFilter,
  });

  const params: ListParams = {
    size: 200,
    status: status || undefined,
    warehouse_id: warehouse ? Number(warehouse) : undefined,
    ...extraParams,
  };

  const { data, isLoading, error } = useQuery({
    queryKey: [queryKey, status, warehouse, extraParams],
    queryFn: () => fetch(params),
  });

  const all = data?.items ?? [];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      searchIn(r).some((v) => (v ?? "").toString().toLowerCase().includes(q)),
    );
  }, [all, search, searchIn]);

  // Paginate in the browser over the page the server already sent. The KPI tiles
  // stay on `all` so they read as the list-wide total and don't jump as you page.
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const tiles = kpis?.(all) ?? [];

  const openRow = onRowClick ?? ((row: T) => nav(String(keyOf(row))));

  const create = (onCreate || createTo) && (
    <Button onClick={onCreate ?? (() => nav(createTo!))}>
      <Plus className="h-4 w-4" /> {createLabel}
    </Button>
  );

  return (
    <div>
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        actions={createPermission && create ? <Can do={createPermission}>{create}</Can> : create}
      />

      {tiles.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((t) => (
            <StatCard key={t.label} label={t.label} value={t.value} tone={t.tone} />
          ))}
        </div>
      )}

      <FilterBar
        search={search}
        onSearch={setSearch}
        placeholder={searchPlaceholder}
        onReset={() => {
          setSearch("");
          setStatus("");
          setWarehouse("");
        }}
      >
        {statuses.length > 0 && (
          <FilterSelect label="Status" value={status} onChange={setStatus} options={statuses} />
        )}
        {warehouseFilter && (
          <FilterSelect
            label="Warehouse"
            allLabel="All warehouses"
            value={warehouse}
            onChange={setWarehouse}
            options={houses.map((w) => ({
              value: w.id,
              label: w.code ? `${w.code} — ${w.name}` : w.name,
            }))}
            className="min-w-[220px]"
          />
        )}
      </FilterBar>

      <ErrorBanner error={error} />
      {children}

      <ResponsiveList
        data={pageRows}
        columns={columns}
        keyOf={keyOf}
        loading={isLoading}
        onRowClick={openRow}
        empty={empty}
        renderCard={renderCard}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
      />
    </div>
  );
}
