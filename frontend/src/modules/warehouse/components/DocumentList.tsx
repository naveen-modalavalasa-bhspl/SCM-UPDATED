import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import {
  Button, Can, PageHeader, ResponsiveList, StatCard, type Column,
} from "@/shared/components";
import { ConfirmModal, ErrorBanner, useToast } from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { FilterBar, FilterSelect } from "./FilterBar";
import { warehouseOptions } from "../api";
import type { ListParams, Page } from "../types";
import { usePointLabel } from "../usePointLabel";

/** What each warehouse type is called on screen. LIP and MDP are rungs on the
 *  distribution chain, not warehouses, and the people holding them do not call them
 *  warehouses. Anything else is left unlabelled — it is just a warehouse. */
const POINT_LABEL: Record<string, string> = {
  MDP: "MDP",
  LIP: "LIP",
};

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
 * Search, status and warehouse all filter server-side, and the list is paged by the
 * server too — the earlier version pulled 200 rows and did all three in the browser,
 * so the search box could only find what had already been fetched and anything past
 * row 200 was unreachable. The box is debounced so typing is still one round trip.
 */

/** How many rows the KPI strip scans. The tiles are aggregates over the filtered
 *  queue, and no warehouse list endpoint offers a summary route yet; 500 is the
 *  server's own MAX_PAGE_SIZE, so this asks for the most it will ever give. */
const KPI_SCAN_SIZE = 500;

export interface DocumentListProps<T> {
  eyebrow?: string;
  title: string;
  /** Cache key root — must be unique per list. */
  queryKey: string;
  fetch: (params: ListParams) => Promise<Page<T>>;
  columns: Column<T>[];
  renderCard: (row: T) => ReactNode;
  keyOf: (row: T) => string | number;
  /** Which fields the free-text box looked at while it filtered in the browser.
   *  The server owns `?search=` now; the prop stays so the eight list pages keep
   *  documenting what their box is expected to match. */
  searchIn?: (row: T) => (string | null | undefined)[];
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
  /**
   * Clearing abandoned drafts.
   *
   * Every one of these lists collects half-started documents that nothing could
   * remove, so the queue that matters ends up behind rows nobody will ever finish.
   * Supply all three and a trash column appears on the rows `canDelete` accepts —
   * and only for someone holding `deletePermission`. The backend re-checks both the
   * permission and the draft status, so hiding the button is convenience, not the
   * control (rule 6).
   */
  onDelete?: (row: T) => Promise<unknown>;
  /** Which rows are drafts. Must agree with the statuses the server will accept. */
  canDelete?: (row: T) => boolean;
  deletePermission?: string;
  /** What the confirm dialog calls the thing, e.g. "GRN". */
  deleteLabel?: string;
  /** Names the row in the dialog, e.g. its document number. */
  labelOf?: (row: T) => string;
}

export function DocumentList<T>({
  eyebrow,
  title,
  queryKey,
  fetch,
  columns,
  renderCard,
  keyOf,
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
  onDelete,
  canDelete,
  deletePermission,
  deleteLabel = "draft",
  labelOf,
}: DocumentListProps<T>) {
  const nav = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [page, setPage] = useState(1);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const PAGE_SIZE = 20;

  // Now that the box searches the server, a request per keystroke would be a request
  // per keystroke. A quarter second is under the pause between words.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Narrowing the list while sitting on page 4 would otherwise show an empty page
  // with no hint that the rows exist a few pages back.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, warehouse]);

  const { data: houses = [] } = useQuery({
    queryKey: ["wh-lookup", "warehouses", ""],
    queryFn: () => warehouseOptions(),
    staleTime: 5 * 60_000,
    enabled: warehouseFilter,
  });

  const filters: ListParams = {
    search: debouncedSearch || undefined,
    status: status || undefined,
    warehouse_id: warehouse ? Number(warehouse) : undefined,
    ...extraParams,
  };

  // The table asks for one page. It used to ask for 200 rows and slice them in the
  // browser, which meant every warehouse list loaded the whole table on open, the
  // search box only ever searched what had already been fetched, and row 201 was
  // invisible with no way to reach it.
  const { data, isLoading, error } = useQuery({
    queryKey: [queryKey, "page", filters, page],
    queryFn: () => fetch({ ...filters, page, size: PAGE_SIZE }),
  });

  const pageRows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // The tiles describe the queue, not the page, so they read the filtered set rather
  // than the twenty rows on screen — the same mistake the stock screens made. Capped
  // at the server's own page ceiling, and skipped entirely when a list has no tiles.
  const { data: kpiPage } = useQuery({
    queryKey: [queryKey, "kpis", filters],
    queryFn: () => fetch({ ...filters, page: 1, size: KPI_SCAN_SIZE }),
    enabled: Boolean(kpis),
  });

  const tiles = kpis?.(kpiPage?.items ?? []) ?? [];

  // The heading says what the point IS, not what the module is called. A DM working
  // their MDP should read "MDP · Kadapa Store", not "Warehouse" — the picker already
  // told them the type, and the page they land on ought to agree with it.
  const myLabel = usePointLabel();
  const selectedPoint = warehouse
    ? houses.find((w) => String(w.id) === String(warehouse))
    : undefined;
  const selectedLabel = POINT_LABEL[
    (selectedPoint as { warehouse_type?: string } | undefined)?.warehouse_type ?? ""
  ];
  // A specific point is picked: say what THAT point is. Otherwise fall back to what
  // this person's own point is called — an MDP holder should never be told they are
  // looking at a "warehouse".
  const heading = selectedPoint
    ? [selectedLabel ?? "Warehouse", selectedPoint.name].filter(Boolean).join(" · ")
    : (eyebrow ?? myLabel);

  const openRow = onRowClick ?? ((row: T) => nav(String(keyOf(row))));

  // --- deleting a draft -----------------------------------------------------
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<T | null>(null);
  const mayDelete = Boolean(onDelete && canDelete && deletePermission
    && can(deletePermission));

  const remove = useMutation({
    mutationFn: (row: T) => onDelete!(row),
    onSuccess: () => {
      // Both the page and the KPI scan read this key root, so the tiles cannot go
      // on counting a row that is gone.
      qc.invalidateQueries({ queryKey: [queryKey] });
      toast.success(`${deleteLabel} deleted.`);
      setPendingDelete(null);
    },
  });

  const deleteButton = (row: T) => (mayDelete && canDelete!(row) ? (
    <button
      type="button"
      aria-label={`Delete ${labelOf?.(row) ?? deleteLabel}`}
      title="Delete this draft"
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg
                 text-muted transition-colors hover:bg-bad-bg hover:text-bad"
      onClick={(e) => {
        // The row itself opens the document; without this the confirm dialog would
        // appear on top of the detail screen it just navigated to.
        e.stopPropagation();
        setPendingDelete(row);
      }}
    >
      <Trash2 className="h-4 w-4" />
    </button>
  ) : null);

  // Appended, not inserted: a delete sitting between two data columns is a delete
  // somebody hits while reaching for the row.
  const listColumns: Column<T>[] = mayDelete
    ? [...columns, {
        key: "__delete",
        header: "",
        className: "w-12 text-right",
        render: deleteButton,
      } as Column<T>]
    : columns;

  // Under 768px `<ResponsiveList>` renders cards and ignores columns entirely, so
  // the trash icon has to be laid alongside the card or half the warehouse — who
  // work on phones — would have no way to clear a draft.
  const cardRenderer = mayDelete
    ? (row: T) => (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">{renderCard(row)}</div>
          {deleteButton(row)}
        </div>
      )
    : renderCard;

  const create = (onCreate || createTo) && (
    <Button onClick={onCreate ?? (() => nav(createTo!))}>
      <Plus className="h-4 w-4" /> {createLabel}
    </Button>
  );

  return (
    <div>
      <PageHeader
        eyebrow={heading}
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
            label="Stocking point"
            allLabel="All stocking points"
            value={warehouse}
            onChange={setWarehouse}
            // A stocking point is called what it IS: an MDP-holder should never be
            // asked to pick a "warehouse" when the thing they hold is an MDP. The
            // type comes from the warehouse row, so the label can never disagree
            // with the tier the classifier reads.
            options={houses.map((w) => ({
              value: w.id,
              label: [
                w.code ? `${w.code} — ${w.name}` : w.name,
                POINT_LABEL[(w as { warehouse_type?: string }).warehouse_type ?? ""],
              ].filter(Boolean).join(" · "),
            }))}
            className="min-w-[220px]"
          />
        )}
      </FilterBar>

      <ErrorBanner error={error} />
      {children}

      <ResponsiveList
        data={pageRows}
        columns={listColumns}
        keyOf={keyOf}
        loading={isLoading}
        onRowClick={openRow}
        empty={empty}
        renderCard={cardRenderer}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
      />

      <ConfirmModal
        isOpen={pendingDelete !== null}
        title={`Delete this ${deleteLabel}?`}
        message={
          <>
            {labelOf && pendingDelete
              ? <><strong>{labelOf(pendingDelete)}</strong> will be removed permanently. </>
              : `This ${deleteLabel} will be removed permanently. `}
            It is still a draft, so nothing depends on it — no stock has moved and no
            other document points at it. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
        onClose={() => {
          setPendingDelete(null);
          remove.reset();
        }}
      />
    </div>
  );
}
