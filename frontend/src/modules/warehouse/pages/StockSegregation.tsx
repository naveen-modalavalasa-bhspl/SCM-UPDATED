import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import { Card, ErrorBanner, PageHeader, ResponsiveList, StatCard, StatusPill, SubNav, type Column } from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { LabelSheet, type LabelSpec } from "../components/LabelPrint";
import { listBatches, listSerials } from "../api";
import { daysUntil, fmtDate, fmtQty, normaliseStatus } from "../format";
import type { Batch, SerialNumber } from "../types";

/**
 * Stock segregation — which individual units and batches you are holding, and which
 * of them you should stop selling.
 *
 * Two views over the same question. Batches are what expires; serials are what is
 * individually tracked, and carry the asset or consumable code generated during
 * putaway. Both are read-only here: neither is created by hand, and the screen that
 * let you type a serial in was how duplicates got into `whs_serial_numbers`.
 *
 * Expiry is bucketed rather than shown as a raw date, because "expires in 12 days"
 * is a decision and "2026-08-10" is arithmetic homework.
 */

const TABS = [
  { key: "batches", label: "Batches" },
  { key: "serials", label: "Serial numbers" },
];

const EXPIRY_BUCKETS = [
  { value: "expired", label: "Expired" },
  { value: "30", label: "Within 30 days" },
  { value: "90", label: "Within 90 days" },
];

const SERIAL_STATUSES = [
  { value: "available", label: "Available" },
  { value: "issued", label: "Issued" },
  { value: "consumed", label: "Consumed" },
  { value: "returned", label: "Returned" },
  { value: "maintenance", label: "Maintenance" },
  { value: "scrapped", label: "Scrapped" },
];

function lifeDateLabel(row: Pick<Batch, "is_asset">) {
  return row.is_asset ? "Warranty" : "Expiry";
}

function expiryTone(days: number | null, label = "Expiry") {
  const lower = label.toLowerCase();
  if (days === null) return { label: `No ${lower}`, color: "default" as const };
  if (days < 0) return { label: `${label} ended ${-days}d ago`, color: "danger" as const };
  if (days <= 30) return { label: `${days}d left`, color: "danger" as const };
  if (days <= 90) return { label: `${days}d left`, color: "warning" as const };
  return { label: `${days}d left`, color: "success" as const };
}

export default function StockSegregation() {
  const [tab, setTab] = useState("batches");
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState("");
  const [serialStatus, setSerialStatus] = useState("");
  const [printing, setPrinting] = useState(false);

  const batches = useQuery({
    queryKey: ["wh-batches"],
    queryFn: () => listBatches({ size: 300 }),
    enabled: tab === "batches",
  });

  const serials = useQuery({
    queryKey: ["wh-serials", serialStatus],
    queryFn: () => listSerials({ size: 300, status: serialStatus || undefined }),
    enabled: tab === "serials",
  });

  const batchRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (batches.data?.items ?? []).filter((b) => {
      const days = daysUntil(b.expiry_date);
      if (bucket === "expired" && !(days !== null && days < 0)) return false;
      if (bucket === "30" && !(days !== null && days >= 0 && days <= 30)) return false;
      if (bucket === "90" && !(days !== null && days >= 0 && days <= 90)) return false;
      if (!q) return true;
      return [b.batch_no, b.item_code, b.item_name, b.vendor_name, b.grn_no].some((v) =>
        (v ?? "").toLowerCase().includes(q),
      );
    });
  }, [batches.data, search, bucket]);

  const serialRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (serials.data?.items ?? []).filter((s) => {
      if (!q) return true;
      return [s.serial_number, s.item_code, s.item_name, s.asset_code, s.consumable_code, s.bin_code].some(
        (v) => (v ?? "").toLowerCase().includes(q),
      );
    });
  }, [serials.data, search]);

  const batchColumns: Column<Batch>[] = [
    {
      key: "batch",
      header: "Batch",
      render: (b) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{b.batch_no}</div>
          <div className="text-[11px] text-muted">{b.grn_no ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "item",
      header: "Item",
      render: (b) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{b.item_code ?? "—"}</div>
          <div className="truncate text-xs text-muted">{b.item_name ?? "—"}</div>
        </div>
      ),
    },
    { key: "vendor", header: "Vendor", hideOnNarrow: true, render: (b) => b.vendor_name ?? "—" },
    {
      key: "qty",
      header: "Received",
      className: "text-right",
      render: (b) => <span className="tabular text-sm text-ink">{fmtQty(b.initial_qty)}</span>,
    },
    {
      key: "expiry",
      header: "Expiry / Warranty",
      render: (b) => {
        const label = lifeDateLabel(b);
        const tone = expiryTone(daysUntil(b.expiry_date), label);
        return (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
            <div className="text-sm text-ink">{fmtDate(b.expiry_date)}</div>
            <Chip size="sm" variant="flat" color={tone.color}>{tone.label}</Chip>
          </div>
        );
      },
    },
    { key: "status", header: "Status", render: (b) => <StatusPill status={normaliseStatus(b.status)} /> },
  ];

  const serialColumns: Column<SerialNumber>[] = [
    {
      key: "serial",
      header: "Serial",
      render: (s) => (
        <div>
          <div className="font-mono text-xs font-semibold text-ink">{s.serial_number}</div>
          <div className="text-[11px] text-muted">{s.asset_code ?? s.consumable_code ?? "—"}</div>
        </div>
      ),
    },
    {
      key: "item",
      header: "Item",
      render: (s) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-ink">{s.item_code ?? "—"}</div>
          <div className="truncate text-xs text-muted">{s.item_name ?? "—"}</div>
        </div>
      ),
    },
    { key: "batch", header: "Batch", hideOnNarrow: true, render: (s) => s.batch_no ?? "—" },
    {
      key: "where",
      header: "Where",
      render: (s) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-ink">{s.warehouse_name ?? "—"}</div>
          <div className="truncate text-[11px] text-muted">{s.bin_code ?? "bulk"}</div>
        </div>
      ),
    },
    { key: "status", header: "Status", render: (s) => <StatusPill status={normaliseStatus(s.status)} /> },
  ];

  const labels: LabelSpec[] = serialRows.slice(0, 200).map((s) => ({
    code: s.serial_number,
    title: s.asset_code ?? s.consumable_code ?? s.serial_number,
    subtitle: s.item_name ?? s.item_code ?? "",
    kind: "qr",
    meta: [
      { label: "Serial", value: s.serial_number },
      { label: "Batch", value: s.batch_no ?? "—" },
      { label: "Bin", value: s.bin_code ?? "bulk" },
    ],
  }));

  const expiring = (batches.data?.items ?? []).filter((b) => {
    const d = daysUntil(b.expiry_date);
    return d !== null && d >= 0 && d <= 90;
  }).length;
  const expired = (batches.data?.items ?? []).filter((b) => (daysUntil(b.expiry_date) ?? 1) < 0).length;

  return (
    <div>
      <PageHeader eyebrow="Warehouse" title="Stock segregation" />

      <SubNav label="Stock segregation" items={TABS} value={tab} onChange={setTab} />

      {tab === "batches" ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Batches held" value={batches.data?.items.length ?? 0} />
            <StatCard label="Expiring in 90 days" value={expiring} tone="text-warn" />
            <StatCard label="Expired" value={expired} tone="text-bad" />
            <StatCard
              label="Quantity"
              value={fmtQty((batches.data?.items ?? []).reduce((s, b) => s + Number(b.initial_qty ?? 0), 0))}
            />
          </div>

          <FilterBar
            search={search}
            onSearch={setSearch}
            placeholder="Search batch, item, vendor or GRN…"
            onReset={() => { setSearch(""); setBucket(""); }}
          >
            <FilterSelect label="Expiry / Warranty" allLabel="Any date" value={bucket} onChange={setBucket}
                          options={EXPIRY_BUCKETS} />
          </FilterBar>

          <ErrorBanner error={batches.error} />

          <ResponsiveList
            data={batchRows}
            columns={batchColumns}
            keyOf={(b) => b.id}
            loading={batches.isLoading}
            empty="No batches match these filters."
            renderCard={(b) => {
              const label = lifeDateLabel(b);
              const tone = expiryTone(daysUntil(b.expiry_date), label);
              return (
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold text-ink">{b.batch_no}</span>
                    <Chip size="sm" variant="flat" color={tone.color}>{tone.label}</Chip>
                  </div>
                  <div className="truncate text-sm text-body">{b.item_name ?? b.item_code ?? "—"}</div>
                  <div className="text-[11px] text-muted">
                    {fmtQty(b.initial_qty)} · {b.vendor_name ?? "—"} · {label}: {fmtDate(b.expiry_date)}
                  </div>
                </div>
              );
            }}
          />
        </>
      ) : (
        <>
          <FilterBar
            search={search}
            onSearch={setSearch}
            placeholder="Search serial, asset code, item or bin…"
            onReset={() => { setSearch(""); setSerialStatus(""); }}
          >
            <FilterSelect label="Status" value={serialStatus} onChange={setSerialStatus}
                          options={SERIAL_STATUSES} />
            <button
              type="button"
              onClick={() => setPrinting((p) => !p)}
              className="min-h-11 rounded-lg border border-line px-3 text-sm font-semibold text-body hover:bg-content2"
            >
              {printing ? "Hide labels" : "Print labels"}
            </button>
          </FilterBar>

          <ErrorBanner error={serials.error} />

          {printing && (
            <Card className="mb-4 p-4">
              <LabelSheet labels={labels} title="serial labels" emptyHint="Nothing to label." />
            </Card>
          )}

          <ResponsiveList
            data={serialRows}
            columns={serialColumns}
            keyOf={(s) => s.id}
            loading={serials.isLoading}
            empty="No serial numbers match these filters."
            renderCard={(s) => (
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-ink">{s.serial_number}</span>
                  <StatusPill status={normaliseStatus(s.status)} />
                </div>
                <div className="truncate text-sm text-body">{s.item_name ?? s.item_code ?? "—"}</div>
                <div className="text-[11px] text-muted">
                  {s.warehouse_name ?? "—"} · {s.bin_code ?? "bulk"} · {s.asset_code ?? s.consumable_code ?? "—"}
                </div>
              </div>
            )}
          />
        </>
      )}
    </div>
  );
}
