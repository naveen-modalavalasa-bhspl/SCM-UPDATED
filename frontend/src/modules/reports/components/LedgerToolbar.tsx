import { Download, RotateCcw } from "lucide-react";
import { Button, Can, Card, Field, Input, Select } from "@/shared/components";
import type { ReportColumn, ReportFilter } from "../types";

/** The filter strip. Every control writes to the URL (the page owns that), so an
 *  auditor can send somebody the exact view they are looking at, and the export
 *  downloads exactly those rows. */

interface Props {
  search: string;
  onSearch: (value: string) => void;
  dateFrom: string;
  dateTo: string;
  onDate: (which: "date_from" | "date_to", value: string) => void;
  dateField: string;
  filters: ReportFilter[];
  values: Record<string, string>;
  onFilter: (key: string, value: string) => void;
  columns: ReportColumn[];
  sort: string;
  dir: "asc" | "desc";
  onSort: (sort: string, dir: "asc" | "desc") => void;
  onReset: () => void;
  onExport: (format: "xlsx" | "csv") => void;
  exporting: boolean;
  total: number;
}

const ALL = { value: "", label: "All" };

export function LedgerToolbar({
  search, onSearch, dateFrom, dateTo, onDate, dateField, filters, values, onFilter,
  columns, sort, dir, onSort, onReset, onExport, exporting, total,
}: Props) {
  return (
    <Card className="mb-5 p-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <Field label="Search">
            <Input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Document no, person, item, reference, remarks…"
              aria-label="Search this ledger"
            />
          </Field>
        </div>
        <Field label={`From (${dateField.replace(/_/g, " ")})`}>
          <Input type="date" value={dateFrom} aria-label="From date"
                 onChange={(e) => onDate("date_from", e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={dateTo} aria-label="To date"
                 onChange={(e) => onDate("date_to", e.target.value)} />
        </Field>

        {filters.map((filter) => (
          <Field key={filter.key} label={filter.label}>
            {filter.kind === "text" ? (
              <Input
                value={values[filter.key] ?? ""}
                aria-label={filter.label}
                placeholder="Contains…"
                onChange={(e) => onFilter(filter.key, e.target.value)}
              />
            ) : (
              <Select
                value={values[filter.key] ?? ""}
                ariaLabel={filter.label}
                placeholder="All"
                onChange={(value) => onFilter(filter.key, value)}
                options={[ALL, ...filter.options.map((o) => ({
                  value: o, label: o.replace(/_/g, " "),
                }))]}
              />
            )}
          </Field>
        ))}

        <Field label="Sort by">
          <Select
            value={sort}
            ariaLabel="Sort column"
            onChange={(value) => onSort(value || columns[0]?.key, dir)}
            options={columns.map((c) => ({ value: c.key, label: c.label }))}
          />
        </Field>
        <Field label="Order">
          <Select
            value={dir}
            ariaLabel="Sort direction"
            onChange={(value) => onSort(sort, value === "asc" ? "asc" : "desc")}
            options={[
              { value: "desc", label: "Newest / highest first" },
              { value: "asc", label: "Oldest / lowest first" },
            ]}
          />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-muted">
          {total.toLocaleString()} {total === 1 ? "row" : "rows"} match
        </span>
        <div className="flex flex-wrap gap-2">
          <Button variant="subtle" onClick={onReset}>
            <RotateCcw className="mr-1.5 h-4 w-4" /> Reset filters
          </Button>
          <Can do="report.export">
            <Button variant="subtle" onClick={() => onExport("csv")}
                    disabled={exporting || total === 0}>
              <Download className="mr-1.5 h-4 w-4" /> CSV
            </Button>
            <Button onClick={() => onExport("xlsx")} disabled={exporting || total === 0}>
              <Download className="mr-1.5 h-4 w-4" />
              {exporting ? "Preparing…" : "Export Excel"}
            </Button>
          </Can>
        </div>
      </div>
    </Card>
  );
}
