import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReactToPrint } from "react-to-print";
import Barcode from "react-barcode";
import { QRCodeSVG } from "qrcode.react";
import { Printer, Check, Info } from "lucide-react";
import { Button, Card, PageHeader } from "@/shared/components";
import { FilterBar, FilterSelect } from "../components/FilterBar";
import { getStockBalances, getWarehouses } from "../api";
import type { StockBalanceItem } from "../types";

/**
 * Label printing for shelf/bin stickers.
 *
 * Split out of Stock Balance on purpose: that screen answers "what do we have", this
 * one is a batch job — pick rows, print a sheet, walk away and stick them. Barcodes
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

export function LabelsPage() {
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [size, setSize] = useState("70x40");
  const [kind, setKind] = useState("barcode");
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

  const dim = DIMENSIONS[size];

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
        actions={
          <Button disabled={sheet.length === 0} onClick={() => print?.()}>
            <Printer size={14} /> Print {sheet.length || ""} label{sheet.length === 1 ? "" : "s"}
          </Button>
        }
      />

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
        <FilterSelect value={size} onChange={setSize} placeholder="Label size" options={SIZES} />
        <FilterSelect
          value={kind}
          onChange={setKind}
          placeholder="Code type"
          options={[{ value: "barcode", label: "Barcode (Code 128)" }, { value: "qr", label: "QR code" }]}
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
            <p className="p-4 text-sm text-muted">Loading stock…</p>
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
              {sheet.map(({ row: r, i }) => (
                <div
                  key={`${r.id}-${i}`}
                  className="label flex flex-col items-center justify-between overflow-hidden rounded border border-line bg-white p-1.5 text-black"
                  style={{ width: `${dim.w}mm`, height: `${dim.h}mm` }}
                >
                  <div className="w-full text-center leading-tight">
                    <div className="truncate text-[8px] font-bold">{r.item_name}</div>
                    <div className="truncate text-[7px]">
                      {r.batch_number ? `B:${r.batch_number}` : r.bin_code || ""}
                      {r.expiry_date ? ` · Exp ${r.expiry_date}` : ""}
                    </div>
                  </div>
                  <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
                    {kind === "qr" ? (
                      <QRCodeSVG
                        value={codeFor(r)}
                        size={dim.bar * 2.2}
                        className="block h-auto max-h-full w-auto max-w-full"
                      />
                    ) : (
                      <Barcode
                        value={codeFor(r)}
                        format="CODE128"
                        height={dim.bar * 1.6}
                        width={1}
                        fontSize={8}
                        margin={0}
                        displayValue
                        className="block h-auto max-h-full w-auto max-w-full"
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
