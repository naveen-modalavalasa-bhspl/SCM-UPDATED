import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Button, ErrorBanner, PageHeader, ResponsiveList, useToast, type Column,
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
  "page", "size", "search", "date_from", "date_to", "sort", "dir", "cols",
]);
const SIZES = [20, 50, 100, 200];

export function ReportLedgerPage() {
  const { ledger = "indents" } = useParams();
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
  const info = catalog.data?.find((l) => l.key === ledger);

  const filters = useQuery({
    queryKey: reportKeys.filters(ledger),
    queryFn: () => getFilters(ledger),
    staleTime: 5 * 60 * 1000,
  });

  const query: LedgerQuery = {
    search, date_from: dateFrom, date_to: dateTo, page, size, dir,
    sort: params.get("sort") ?? undefined, filters: filterValues,
  };

  const rows = useQuery({
    queryKey: reportKeys.rows(ledger, query),
    queryFn: () => getRows(ledger, query),
    placeholderData: (previous) => previous,
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

  const onExport = async (format: "xlsx" | "csv") => {
    setExporting(true);
    try {
      const { blob, filename } = await exportLedger(
        ledger, { ...query, page: 1, cols: chosen }, format,
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

  const keyOf = (row: ReportRow) => `${row.doc_type ?? ledger}-${row.id}`;
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);

  return (
    <div className="p-4 sm:p-6">
      {/* Title is just "Ledger": the eyebrow says Reports and the rail tab says
          which ledger, so naming the module here says it a third time. */}
      <PageHeader
        eyebrow="Reports"
        title="Ledger"
        actions={
          <div className="flex items-center gap-2 text-sm text-muted">
            <label htmlFor="rows-per-page">Rows</label>
            <select
              id="rows-per-page"
              value={size}
              onChange={(e) => update({ size: e.target.value })}
              className="min-h-11 rounded-lg border border-line bg-content1 px-2 text-sm"
            >
              {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        }
      />
      {info?.subtitle && <p className="mb-5 text-sm text-muted">{info.subtitle}</p>}

      <ErrorBanner error={rows.error ?? filters.error ?? catalog.error} />

      <SavedViews
        ledger={ledger}
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
