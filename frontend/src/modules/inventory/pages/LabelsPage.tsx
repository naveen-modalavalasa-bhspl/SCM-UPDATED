import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReactToPrint } from "react-to-print";
import { QRCodeSVG } from "qrcode.react";
import { Printer, Check, Info, Box, Tag, Truck } from "lucide-react";
import { Button, Card, PageHeader } from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { LoadingRows } from "../components/PageStates";
import { BoxLabelsPanel } from "../components/BoxLabelsPanel";
import { IssueLabelsPanel } from "../components/IssueLabelsPanel";
import { getStockBalances, getWarehouses, listBoxLabels } from "../api";
import type { StockBalanceItem } from "../types";

/**
 * Label printing for shelf/bin stickers.
 *
 * Split out of Stock Balance on purpose: that screen answers "what do we have", this
 * one is a batch job — pick rows, print a sheet, walk away and stick them. QR codes
 * encode the item code (or mst_items.barcode_value when the item has one), so a
 * scanner reading a sticker finds the row through the same search box.
 *
 * Printing goes through react-to-print rather than window.print(). Hiding the app with
 * CSS and absolutely positioning the sheet does not paginate: anything past the first
 * page gets clipped and labels tear across the page break. react-to-print copies the
 * sheet into its own document, so @page and break-inside actually apply.
 */

const SIZES = [
  { value: "50x25", label: "Small — 50 × 25 mm" },
  { value: "70x40", label: "Medium — 70 × 40 mm" },
  { value: "100x50", label: "Large — 100 × 50 mm" },
];

const DIMENSIONS: Record<string, { w: number; h: number; bar: number }> = {
  "50x25": { w: 50, h: 25, bar: 22 },
  "70x40": { w: 70, h: 40, bar: 34 },
  "100x50": { w: 100, h: 50, bar: 44 },
};

/**
 * BUG_SCM_INV_042 / BUG_SCM_INV_058 history: items with no mst_items.barcode_value
 * fall back to the item code (e.g. "151010-GAUZESWAB-HINDUSTAN-HINDUSTAN-0001", 30-41
 * chars), and a Code128 barcode of that length could not be printed on a fixed-width
 * thermal roll at a scannable module width. Two fixes tried to shrink it to fit.
 *
 * The barcode option is gone (2026-08-20, business request): labels carry a QR code
 * only. A QR encodes a 41-character code at any label size without the width problem
 * the two earlier fixes were fighting, so the whole module-width calculation and
 * react-barcode went with it. The code is printed underneath as text so a human — and
 * a scanner that only reads text — still has it.
 */
/** A label is a fixed physical size and must never be split across a page. */
const pageStyle = `
  @page { size: A4; margin: 8mm; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .label {
      break-inside: avoid;
      page-break-inside: avoid;
      border: 1px solid #000;
      color: #000;
      background: #fff;
    }
  }
`;

/** Item labels (stock rows) and Box labels (the print queue of box codes, 2026-10-26). */
export function LabelsPage() {
  const [tab, setTab] = useState<"items" | "boxes" | "issues">("items");
  const [boxSize, setBoxSize] = useState("50x25");
  const queued = useQuery({
    queryKey: ["box-labels", "QUEUED-count"],
    queryFn: () => listBoxLabels({ status: "QUEUED", size: 1 }),
    staleTime: 30_000,
  });
  const tabs = (
    <div role="tablist" aria-label="Label kind"
         className="mb-4 inline-flex rounded-xl border border-line bg-content2/60 p-1">
      {([["items", "Item labels", Tag], ["boxes", "Box labels", Box], ["issues", "Issue labels", Truck]] as const).map(([key, label, Icon]) => (
        <button key={key} role="tab" aria-selected={tab === key} type="button"
                onClick={() => setTab(key)}
                className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${
                  tab === key ? "bg-content1 text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
          <Icon className="h-4 w-4" aria-hidden /> {label}
          {key === "boxes" && (queued.data?.total ?? 0) > 0 && (
            <span className="rounded-full bg-brand px-1.5 text-[10px] font-bold leading-4 text-white">
              {queued.data?.total}
            </span>
          )}
        </button>
      ))}
    </div>
  );
  if (tab === "issues") {
    return (
      <div>
        <PageHeader eyebrow="Inventory" title="Labels & Printing" />
        {tabs}
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-line/70 bg-content2 p-3 text-sm text-body">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>
            Labels for everything a <strong>posted</strong> issue sent — whole issue or item by item,
            as a barcode, a QR or both, on a thermal roll or an A4 sheet.
          </span>
        </p>
        <IssueLabelsPanel />
      </div>
    );
  }
  if (tab === "boxes") {
    return (
      <div>
        <PageHeader eyebrow="Inventory" title="Labels & Printing" />
        {tabs}
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-line/70 bg-content2 p-3 text-sm text-body">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <span>
            Every new <strong>box code</strong> lands here — boxed at putaway, old stock grouped into
            boxes, a re-code after the issue container changed, and the part box cut at the issue desk.
            Print, stick, then <strong>Mark printed</strong>.
          </span>
        </p>
        <div className="mb-3 w-56">
          <FilterSelect value={boxSize} onChange={setBoxSize} placeholder="Label size"
                        options={SIZES} allowEmpty={false} />
        </div>
        <BoxLabelsPanel size={boxSize} dim={DIMENSIONS[boxSize] ?? DIMENSIONS["50x25"]}
                        pageStyle={pageStyle} />
      </div>
    );
  }
  return <ItemLabels tabs={tabs} />;
}

function ItemLabels({ tabs }: { tabs: React.ReactNode }) {
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [size, setSize] = useState("70x40");
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [copies, setCopies] = useState<Record<number, string>>({});
  const sheetRef = useRef<HTMLDivElement>(null);

  const { data: warehouses = [] } = useQuery({ queryKey: ["warehouses"], queryFn: getWarehouses });
  const { data, isLoading } = useQuery({
    queryKey: ["labels-stock", search, warehouseId],
    queryFn: () => getStockBalances({ search, warehouse_id: warehouseId, size: 200 }),
  });
  const rows = data?.items ?? [];

  const selected = useMemo(() => rows.filter((r) => picked[r.id]), [rows, picked]);

  /** One entry per sticker to print — a row asked for 12 copies becomes 12 entries. */
  const sheet = useMemo(
    () =>
      selected.flatMap((r) =>
        Array.from({ length: Math.max(1, Number(copies[r.id] || 1)) }, (_, i) => ({ row: r, i })),
      ),
    [selected, copies],
  );

  // Falls back rather than crashing the page if `size` is ever something other than
  // one of the three keys — this is what a blank dropdown option used to do.
  const dim = DIMENSIONS[size] ?? DIMENSIONS["70x40"];

  const print = useReactToPrint({
    content: () => sheetRef.current,
    documentTitle: `labels-${new Date().toISOString().slice(0, 10)}`,
    pageStyle,
  });

  const toggle = (id: number) => setPicked((p) => ({ ...p, [id]: !p[id] }));
  const allPicked = rows.length > 0 && rows.every((r) => picked[r.id]);
  const toggleAll = () =>
    setPicked(allPicked ? {} : Object.fromEntries(rows.map((r) => [r.id, true])));

  const codeFor = (r: StockBalanceItem) => r.barcode_value || r.item_code;

  return (
    <div>
      <PageHeader
        eyebrow="Inventory"
        title="Labels & Printing"
        // Stays the page's PRIMARY action, unlike Export elsewhere: printing is what
        // this screen exists to do, so it is the one solid button on it. Only the icon
        // is standardised, to the 16px every other header action uses.
        actions={
          <Button disabled={sheet.length === 0} onClick={() => print?.()}>
            <Printer className="h-4 w-4" /> Print {sheet.length || ""} label{sheet.length === 1 ? "" : "s"}
          </Button>
        }
      />
      {tabs}

      <p className="mb-4 flex items-start gap-2 rounded-lg border border-line/70 bg-content2 p-3 text-sm text-body">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
        <span>
          Printing opens your browser's print dialog. For a PDF file, choose
          <strong> Destination → Save as PDF</strong> there. Set <strong>Copies</strong> per row below
          when you need a sticker on every carton.
        </span>
      </p>

      <FilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search item / batch / bin to label…"
        onClear={() => { setSearch(""); setWarehouseId(""); }}
        active={[search, warehouseId].filter(Boolean).length}
      >
        <FilterSelect
          value={warehouseId}
          onChange={setWarehouseId}
          placeholder="All warehouses"
          options={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        />
        <FilterSelect
          value={size}
          onChange={setSize}
          placeholder="Label size"
          options={SIZES}
          allowEmpty={false}
        />
      </FilterBar>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,420px)_1fr]">
        <Card className="p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Pick stock rows</h2>
            {rows.length > 0 && (
              <button onClick={toggleAll} className="text-xs font-medium text-brand hover:underline">
                {allPicked ? "Clear all" : `Select all (${rows.length})`}
              </button>
            )}
          </div>

          {isLoading ? (
            <LoadingRows rows={5} className="p-0" />
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted">No stock rows match.</p>
          ) : (
            <ul className="max-h-[560px] space-y-1 overflow-y-auto">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <button
                    onClick={() => toggle(r.id)}
                    className={`flex min-h-11 flex-1 items-center gap-3 rounded-lg border px-3 py-2 text-left ${
                      picked[r.id] ? "border-brand bg-brand/5" : "border-line/70 hover:bg-content2"
                    }`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                        picked[r.id] ? "border-brand bg-brand text-white" : "border-line"
                      }`}
                    >
                      {picked[r.id] && <Check size={13} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-ink">{r.item_name}</span>
                      <span className="block font-mono text-[11px] text-muted">
                        {r.item_code} · {r.bin_code || "No bin"} · {r.available_qty} {r.uom_code}
                      </span>
                    </span>
                  </button>
                  {picked[r.id] && (
                    <input
                      type="number"
                      min={1}
                      value={copies[r.id] ?? "1"}
                      aria-label={`Copies for ${r.item_code}`}
                      onChange={(e) => setCopies((c) => ({ ...c, [r.id]: e.target.value }))}
                      className="h-11 w-16 rounded-lg border border-line bg-content1 px-2 text-center text-sm text-ink outline-none focus:border-brand"
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 text-sm font-semibold text-ink">
            Preview {sheet.length > 0 && <span className="text-muted">({sheet.length} stickers)</span>}
          </h2>

          {sheet.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-muted">
              Pick rows on the left to build a label sheet.
            </p>
          ) : (
            <div ref={sheetRef} className="flex flex-wrap gap-2">
              {sheet.map(({ row: r, i }) => {
                const code = codeFor(r);
                return (
                <div
                  key={`${r.id}-${i}`}
                  className="label flex flex-col items-center justify-between overflow-hidden rounded border border-line bg-white p-1.5 text-black"
                  style={{ width: `${dim.w}mm`, height: `${dim.h}mm` }}
                >
                  {/* FIXED 2026-08-21 — the label carried the item name, then EITHER a
                      batch or a bin, and nothing else in words. Scanning a sticker told
                      a storekeeper what it was only if the scanner worked; read by eye
                      it was a name over a QR square. The five things a picker actually
                      checks against the shelf — what it is, which item code, which
                      batch, where it sits, when it expires — are now written out and
                      LABELLED, so the sticker can be read without a device.

                      Every row is dropped when it has no value rather than printed
                      empty: a 38mm label has no room for "Batch —", and a blank field
                      reads as missing data rather than as not-applicable. Batch and bin
                      are both shown now; they were an either/or, which hid the bin on
                      every batch-tracked item. */}
                  <div className="w-full leading-tight">
                    <div className="truncate text-center text-[8px] font-bold">
                      {r.item_name}
                    </div>
                    <div className="mt-0.5 space-y-[1px] text-[6px]">
                      {[
                        ["Item", r.item_code],
                        ["Batch", r.batch_number],
                        ["Bin", r.bin_code],
                        ["Exp", r.expiry_date],
                      ].map(([label, value]) => (value ? (
                        <div key={label} className="flex gap-1 leading-none">
                          <span className="shrink-0 font-semibold uppercase">
                            {label}
                          </span>
                          <span className="truncate font-mono">{value}</span>
                        </div>
                      ) : null))}
                    </div>
                  </div>
                  <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
                    <QRCodeSVG
                      value={code}
                      size={dim.bar * 2.2}
                      className="block h-auto max-h-full w-auto max-w-full"
                    />
                  </div>
                  {/* The barcode used to print its own value underneath (displayValue).
                   *  A QR does not, so the code is written out here — a picker still
                   *  has to be able to read it off the sticker. */}
                  <div className="w-full truncate text-center font-mono text-[7px] leading-none">
                    {code}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
