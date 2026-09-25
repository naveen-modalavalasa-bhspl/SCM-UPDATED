import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, ErrorBanner, PageHeader, ResponsiveList, SubNav, useToast, type Column,
  Select,
} from "@/shared/components";
import {
  exportLedger, getFilters, getLedgers, getRows, reportKeys, saveFile,
} from "../api";
import { LedgerToolbar } from "../components/LedgerToolbar";
import { SavedViews } from "../components/SavedViews";
import { LedgerCard, renderValue } from "../components/cells";
import type { LedgerQuery, ReportRow } from "../types";

/** One page serves all four ledgers — the ledger key comes from the route and every
 *  column, filter and dropdown option comes from the backend, so a new ledger needs
 *  a `LedgerSpec` and a route, not a new screen.
 *
 *  Filter state lives in the URL, not in component state: an audit finding is only
 *  useful if the view that produced it can be sent to somebody else. */

// `cols` rides in the URL with the filters so a saved view keeps its layout and a
// shared link arrives looking the way the sender left it. It is listed here so the
// filter sweep below does not mistake it for a filter and send it to the backend.
const CONTROLS = new Set([
  "page", "size", "search", "date_from", "date_to", "sort", "dir", "cols", "sub",
  // The host screen's own tab, when this ledger is embedded in one.
  "tab",
]);
const SIZES = [20, 50, 100, 200];

// Several ledgers are different cuts of the SAME documents a rail row already
// covers — Stock and Assets are the inventory ledger sliced by balance and by asset
// tag, the Monthly Tracker is the indent ledger by cycle. They are sub-tabs of the
// ledger they cut rather than six more rows on the rail, which is how a menu meant
// to serve "every ledger, one screen" ends up with thirteen entries.
//
// `?sub=` carries the choice, so a sub-tab is as shareable as a filter is. The first
// entry is the route's own ledger and writes no parameter — a bare /reports/inventory
// and /reports/inventory?sub=inventory must not be two different-looking URLs.
//
// Every key here has to be a real `LedgerSpec` (backend reports/ledgers.py); this map
// only decides which route groups them, never that they exist. A key the catalogue
// does not return for THIS login — it drops the ledgers whose source permission the
// login lacks — is dropped from the strip below, so the tab and the endpoint agree.
const SUBLEDGERS: Record<string, { key: string; label: string }[]> = {
  indents: [
    { key: "indents", label: "Ledger" },
    { key: "indent_tracker", label: "Monthly tracker" },
    { key: "acknowledgements", label: "Acknowledgements pending" },
  ],
  approvals: [
    { key: "approvals", label: "Ledger" },
    { key: "approval_sla", label: "SLA" },
  ],
  inventory: [
    { key: "inventory", label: "Ledger" },
    { key: "stock", label: "Balance & ageing" },
    { key: "assets", label: "Assets" },
    { key: "consumption", label: "Consumption" },
  ],
};

/** `ledgerKey` pins the ledger instead of reading the route, and `embedded` drops
 *  the page chrome — Inventory > Stock Transfer mounts its History tab this way. */
export function ReportLedgerPage({ ledgerKey, embedded = false }: {
  ledgerKey?: string; embedded?: boolean;
} = {}) {
  const { ledger: routeLedger = "indents" } = useParams();
  const ledger = ledgerKey ?? routeLedger;
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const page = Number(params.get("page") ?? 1);
  const size = Number(params.get("size") ?? 50);
  const search = params.get("search") ?? "";
  const dateFrom = params.get("date_from") ?? "";
  const dateTo = params.get("date_to") ?? "";
  const dir = params.get("dir") === "asc" ? "asc" : "desc";

  // Anything in the URL that is not a control is a filter for this ledger. The
  // backend ignores keys the ledger does not declare, so a stale link degrades to a
  // wider view rather than to an error.
  const filterValues = useMemo(() => {
    const out: Record<string, string> = {};
    params.forEach((value, key) => {
      if (!CONTROLS.has(key) && value) out[key] = value;
    });
    return out;
  }, [params]);

  const catalog = useQuery({ queryKey: reportKeys.ledgers, queryFn: getLedgers });

  // The catalogue is already filtered by the backend to the ledgers this login may
  // read, so a sub-tab it does not list is one the rows endpoint would refuse. Drop
  // it rather than draw a tab whose first press is an error. While the catalogue is
  // still loading nothing is dropped: an empty strip that fills in a moment later
  // reads as the page rearranging itself under the pointer.
  const allowed = catalog.data;
  const subOptions = useMemo(() => {
    const group = SUBLEDGERS[ledger];
    if (!group) return undefined;
    const visible = allowed
      ? group.filter((option) => allowed.some((l) => l.key === option.key))
      : group;
    // One tab is not a choice — it is the ledger's own row wearing a strip.
    return visible.length > 1 ? visible : undefined;
  }, [ledger, allowed]);

  // A `sub` naming a ledger this strip does not offer falls back to the route's own
  // ledger, so a link shared with somebody who may not read that cut still opens.
  const activeLedger =
    subOptions?.find((o) => o.key === params.get("sub"))?.key ?? ledger;

  const info = catalog.data?.find((l) => l.key === activeLedger);

  const filters = useQuery({
    queryKey: reportKeys.filters(activeLedger),
    queryFn: () => getFilters(activeLedger),
    staleTime: 5 * 60 * 1000,
  });

  const query: LedgerQuery = {
    search, date_from: dateFrom, date_to: dateTo, page, size, dir,
    sort: params.get("sort") ?? undefined, filters: filterValues,
  };

  const rows = useQuery({
    queryKey: reportKeys.rows(activeLedger, query),
    queryFn: () => getRows(activeLedger, query),
    // Hold the previous PAGE while the next page of the SAME ledger loads, so paging
    // does not flash. Switching ledger — a sub-tab switch is a different ledger — must
    // NOT hold it: the columns come from the new ledger and the rows from the old one
    // for as long as the fetch takes, which reads as corrupted data rather than as a
    // loading state.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === activeLedger ? previous : undefined,
  });

  const columns = rows.data?.columns ?? info?.columns ?? [];
  const sort = params.get("sort") ?? info?.default_sort ?? columns[0]?.key ?? "";
  const total = rows.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));

  // A `cols` value naming a column this ledger does not have is dropped rather than
  // rendered blank: a link saved before a ledger changed should degrade to the
  // columns that still exist. If nothing survives, fall back to the full set.
  const picked = (params.get("cols") ?? "").split(",").filter(Boolean);
  const chosen = picked.filter((key) => columns.some((c) => c.key === key));
  const shownColumns = chosen.length ? columns.filter((c) => chosen.includes(c.key))
                                     : columns;

  /** Every control change resets to page 1 — staying on page 7 of a narrower result
   *  set is how a filter looks like it returned nothing. */
  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!("page" in changes)) next.delete("page");
    setParams(next, { replace: true });
  };

  const reset = () => setParams(new URLSearchParams(), { replace: true });

  /** Switching sub-tab is switching LEDGER, so the layout controls have to go with
   *  it: `sort` names a column, and a column the next cut does not have is a 400
   *  from the rows endpoint, not a wider view. `cols` would survive the client-side
   *  drop below, but a column set chosen for Balance & ageing means nothing on
   *  Assets. Filters are left alone on purpose — warehouse and project mean the same
   *  thing on every cut, and the backend ignores a key the ledger does not declare. */
  const switchSub = (key: string) => {
    const next = new URLSearchParams(params);
    for (const control of ["sort", "dir", "cols", "page"]) next.delete(control);
    if (subOptions && key !== subOptions[0].key) next.set("sub", key);
    else next.delete("sub");
    setParams(next, { replace: true });
  };

  const onExport = async (format: "xlsx" | "csv") => {
    setExporting(true);
    try {
      const { blob, filename } = await exportLedger(
        activeLedger, { ...query, page: 1, cols: chosen }, format,
      );
      saveFile(blob, filename);
      toast.success(`Downloaded ${filename}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const tableColumns: Column<ReportRow>[] = shownColumns.map((col) => ({
    key: col.key,
    header: col.label,
    hideOnNarrow: col.narrow,
    render: (row) => renderValue(row[col.key], col.kind),
  }));

  const keyOf = (row: ReportRow) => `${row.doc_type ?? activeLedger}-${row.id}`;
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);

  return (
    <div className={embedded ? "" : "p-4 sm:p-6"}>
      {/* Title is just "Ledger": the eyebrow says Reports and the rail tab says
          which ledger, so naming the module here says it a third time. */}
      {!embedded && <PageHeader
        eyebrow="Reports"
        title="Ledger"
        actions={
          <div className="flex items-center gap-2 text-sm text-muted">
            <span>Rows</span>
            <div className="w-24">
              <Select
                ariaLabel="Rows per page"
                value={String(size)}
                onChange={(next) => update({ size: next })}
                options={SIZES.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </div>
          </div>
        }
      />}
      {info?.subtitle && <p className="mb-5 text-sm text-muted">{info.subtitle}</p>}

      {subOptions && (
        <SubNav
          label="View"
          items={subOptions}
          value={activeLedger}
          onChange={switchSub}
        />
      )}

      <ErrorBanner error={rows.error ?? filters.error ?? catalog.error} />

      <SavedViews
        ledger={activeLedger}
        query={params.toString()}
        onApply={(saved) => setParams(new URLSearchParams(saved), { replace: true })}
        columns={columns}
        visible={chosen}
        onColumns={(keys) => update({ cols: keys.join(",") })}
      />

      <LedgerToolbar
        search={search}
        onSearch={(value) => update({ search: value })}
        dateFrom={dateFrom}
        dateTo={dateTo}
        onDate={(which, value) => update({ [which]: value })}
        dateField={info?.date_field ?? "created_at"}
        filters={filters.data ?? info?.filters ?? []}
        values={filterValues}
        onFilter={(key, value) => update({ [key]: value })}
        columns={columns}
        sort={sort}
        dir={dir}
        onSort={(nextSort, nextDir) => update({ sort: nextSort, dir: nextDir })}
        onReset={reset}
        onExport={onExport}
        exporting={exporting}
        total={total}
      />

      <ResponsiveList
        data={rows.data?.items ?? []}
        columns={tableColumns}
        keyOf={keyOf}
        loading={rows.isLoading}
        empty="No entries match these filters."
        renderCard={(row) => <LedgerCard row={row} columns={shownColumns} />}
      />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
        <span>
          {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="subtle" disabled={page <= 1}
                  onClick={() => update({ page: String(page - 1) })}>
            Previous
          </Button>
          <span>Page {page} of {pages}</span>
          <Button variant="subtle" disabled={page >= pages}
                  onClick={() => update({ page: String(page + 1) })}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
