import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Field, Input, PageHeader, ResponsiveList, SubNav, type Column } from "@/shared/components";
import { EmptyState, ErrorBanner } from "../components/Feedback";
import { Lookup } from "../components/Lookup";
import { runReport, warehouseOptions, type ReportKey } from "../api";
import { fmtDate, fmtMoney, fmtQty, today } from "../format";

/**
 * Warehouse reports.
 *
 * The backend sends the columns with the rows, so adding a report is a backend
 * change alone — the version this replaces hardcoded seven column layouts in the
 * frontend, which is why two of them still showed headings for columns the query had
 * stopped returning.
 *
 * A cell is formatted from its column flag, not by sniffing the value: a quantity
 * that happens to be a whole number is still a quantity.
 */

const REPORTS: { key: ReportKey; label: string; hint: string }[] = [
  { key: "inward-register", label: "Inward register", hint: "Every receipt in the period, with accepted and rejected quantity." },
  { key: "qc-summary", label: "QC summary", hint: "Pass and fail rates by item and vendor." },
  { key: "putaway-ageing", label: "Putaway ageing", hint: "Received stock still not in a bin, by age." },
  { key: "issue-register", label: "Issue register", hint: "What left the store, to whom, and against which indent." },
  { key: "dispatch-register", label: "Dispatch register", hint: "Consignments out, with delivery status." },
  { key: "bin-utilisation", label: "Bin utilisation", hint: "How full each bin is against its capacity." },
  { key: "batch-expiry", label: "Batch expiry", hint: "Batches by remaining shelf life." },
];

interface Row {
  [key: string]: unknown;
  /** Report rows have no id of their own, so the position in the result is the key. */
  __row: number;
}

export default function WarehouseReports() {
  const [report, setReport] = useState<ReportKey>("inward-register");
  const [warehouse, setWarehouse] = useState<number | "">("");
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-report", report, warehouse, from, to],
    queryFn: () =>
      runReport(report, {
        warehouse_id: warehouse === "" ? undefined : warehouse,
        date_from: from,
        date_to: to,
      }),
  });

  const spec = REPORTS.find((r) => r.key === report)!;

  /** One cell, formatted by what its column says it is. */
  const cell = (value: unknown, numeric?: boolean) => {
    if (value == null || value === "") return "—";
    if (numeric) return <span className="tabular">{fmtQty(value as number)}</span>;
    if (typeof value === "number") return <span className="tabular">{fmtMoney(value)}</span>;
    const text = String(value);
    // ISO dates come back as `2026-07-29`; anything else renders as written.
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? fmtDate(text) : text;
  };

  const columns: Column<Row>[] =
    data?.columns.map((c, i) => ({
      key: c.key,
      header: c.header,
      className: c.numeric ? "text-right" : undefined,
      hideOnNarrow: i > 3,
      render: (row) => cell(row[c.key], c.numeric),
    })) ?? [];

  return (
    <div>
      <PageHeader eyebrow="Warehouse" title="Reports" />

      <SubNav
        label="Reports"
        items={REPORTS.map((r) => ({ key: r.key, label: r.label }))}
        value={report}
        onChange={(k) => setReport(k as ReportKey)}
      />

      <Card className="mb-4 p-4">
        <p className="mb-4 text-sm text-muted">{spec.hint}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Warehouse">
            <Lookup
              name="warehouses"
              load={warehouseOptions}
              value={warehouse}
              onChange={setWarehouse}
              placeholder="All warehouses"
            />
          </Field>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <span className="text-sm text-muted">
              {isLoading ? "Running…" : `${data?.total ?? 0} rows`}
            </span>
          </div>
        </div>
      </Card>

      <ErrorBanner error={error} />

      {!isLoading && (data?.rows.length ?? 0) === 0 ? (
        <EmptyState title="Nothing in this period" hint="Widen the dates, or clear the warehouse filter." />
      ) : (
        <ResponsiveList
          data={(data?.rows ?? []).map((r, i) => ({ ...r, __row: i })) as Row[]}
          columns={columns}
          keyOf={(row) => row.__row}
          loading={isLoading}
          empty="No rows."
          renderCard={(row) => (
            <div className="space-y-1">
              {data?.columns.slice(0, 5).map((c) => (
                <div key={c.key} className="flex justify-between gap-3 text-xs">
                  <span className="text-muted">{c.header}</span>
                  <span className="truncate text-ink">{cell(row[c.key], c.numeric)}</span>
                </div>
              ))}
            </div>
          )}
        />
      )}
    </div>
  );
}
