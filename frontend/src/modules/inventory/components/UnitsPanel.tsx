import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { Check, Copy, Download } from "lucide-react";
import { getUnits } from "../api";
import type { UnitRow } from "../types";

/**
 * The units standing in one lot, by name.
 *
 * A stock row is a LOT — "88 cables at MALLAVALLI" — and the one thing it cannot tell
 * you is WHICH 88. That lives one table away, in the warehouse module's per-unit rows,
 * and until now the screens showed at most the first code and no way to get the rest.
 * A store keeper counting a shelf needs the whole list, and needs it out of the browser
 * — into a mail, a sheet, a handover note — so every group here copies and downloads.
 *
 * Three groups because a unit carries up to three identities and people search by
 * whichever is printed in front of them: the SERIAL and the IMEI recorded at goods-in,
 * and the asset-or-consumable CODE minted at putaway. They are not interchangeable and
 * are never collapsed into one column here.
 */

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Copy and Download, side by side. Copy confirms itself for a moment — a clipboard
 *  write is invisible otherwise, and people press it twice to be sure. */
function CopyDownload({ values, filename, disabled }: {
  values: string[]; filename: string; disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(values.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is blocked outside a secure context (plain http on the LAN, which
      // is how this is demoed). Fall back to the download, which always works.
      download(filename, values.map(csvCell).join("\n"));
    }
  };
  const cls = "inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 "
    + "text-[11px] font-medium text-body transition-colors hover:bg-content2 "
    + "disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex gap-1">
      <button type="button" className={cls} disabled={disabled} onClick={copy}>
        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        className={cls}
        disabled={disabled}
        onClick={() => download(filename, values.map(csvCell).join("\n"))}
      >
        <Download size={12} /> Download
      </button>
    </div>
  );
}

function Group({ title, values, filename }: {
  title: string; values: string[]; filename: string;
}) {
  if (!values.length) return null;
  return (
    <div className="rounded-lg border border-line/70 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          {title} · {values.length}
        </span>
        <CopyDownload values={values} filename={filename} />
      </div>
      {/* Scrolls at about eight rows: long enough to read the lot, short enough that
          the panel does not swallow the screen when a lot holds a hundred units. */}
      <div className="max-h-44 overflow-y-auto">
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <span
              key={v}
              className="select-all rounded bg-content2 px-2 py-0.5 font-mono text-[11px] text-body"
            >
              {v}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** One identity cell on a stock or ledger row: the first value, how many more there
 *  are, and the whole list a click away.
 *
 *  Serial/IMEI and the asset/consumable code get a column each rather than sharing
 *  one. They answer different questions — "which unit is this" versus "what is it
 *  labelled" — and a single column had to pick a winner, which meant the IMEI of a
 *  coded unit was never visible anywhere on the screen. */
export function UnitCell({ text, extra, lot, title }: {
  text?: string | null;
  extra?: number;
  /** Omitted when the value came off the stock row itself: there are no per-unit rows
   *  behind it to open. */
  lot?: UnitsPanelProps & { label?: string };
  title?: string;
}) {
  if (!text) return <span className="text-xs text-muted">—</span>;
  const body = (
    <div className="min-w-0 text-left">
      <div className="truncate font-mono text-xs text-body">{text}</div>
      {/* The WHOLE count, not "+18 more". A lot of 19 units sat beside an Available of
          12 and a Reserved of 7, and "+18 more" left the reader to work out that the
          three numbers agree. "19 units in lot" reconciles on sight: 12 free, 7 spoken
          for, 19 things on the shelf. */}
      {!!extra && extra > 0 && (
        <div className="text-[11px] text-brand">{extra + 1} units in lot</div>
      )}
    </div>
  );
  if (!lot) return body;
  const { label, ...panel } = lot;
  return (
    <Popover placement="bottom-start" showArrow>
      <PopoverTrigger>
        {/* stopPropagation: the row itself opens the detail sheet, and asking "which
            units are these" should not also do that. */}
        <button
          type="button"
          className="w-full rounded-md px-1 py-0.5 text-left transition-colors hover:bg-content2"
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] max-w-[90vw] p-3">
        <div className="w-full">
          {(title || label) && (
            <div className="mb-2 text-xs font-semibold text-ink">
              {title}
              {label && <span className="ml-1 font-normal text-muted">· {label}</span>}
            </div>
          )}
          <UnitsPanel {...panel} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export interface UnitsPanelProps {
  itemId: number;
  warehouseId?: number | null;
  binId?: number | null;
  batchId?: number | null;
  /** Names the downloaded files, so three lots do not all land as units.csv. */
  itemCode?: string | null;
  /** How many the summary said are here, shown while the full list is in flight. */
  expected?: number;
}

export function UnitsPanel({
  itemId, warehouseId, binId, batchId, itemCode, expected,
}: UnitsPanelProps) {
  const { data: units = [], isLoading, isError } = useQuery({
    queryKey: ["units", itemId, warehouseId ?? null, binId ?? null, batchId ?? null],
    queryFn: () => getUnits({ item_id: itemId, warehouse_id: warehouseId,
                              bin_id: binId, batch_id: batchId }),
  });

  const stem = (itemCode || `item-${itemId}`).replace(/[^\w.-]+/g, "_");
  const serials = units.map((u) => u.serial_number).filter(Boolean) as string[];
  const imeis = units.map((u) => u.imei).filter(Boolean) as string[];
  const codes = units
    .map((u) => u.asset_code || u.consumable_code)
    .filter(Boolean) as string[];

  const everything = [
    ["Serial", "IMEI", "Asset code", "Consumable code", "Batch", "Bin", "Status"],
    ...units.map((u: UnitRow) => [
      u.serial_number, u.imei, u.asset_code, u.consumable_code,
      u.batch_no, u.bin_code, u.status,
    ]),
  ].map((line) => line.map(csvCell).join(",")).join("\n");

  if (isLoading) {
    return (
      <p className="text-sm text-muted">
        Loading {expected ? `${expected} ` : ""}units…
      </p>
    );
  }
  if (isError) return <p className="text-sm text-danger">Could not load the units here.</p>;
  if (!units.length) {
    return (
      <p className="text-sm text-muted">
        No unit is registered against this lot. Serials and IMEIs are captured at
        goods-in; the asset or consumable code is minted at putaway.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{units.length} units here</span>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[11px] font-medium text-body transition-colors hover:bg-content2"
          onClick={() => download(`${stem}-units.csv`, everything)}
        >
          <Download size={12} /> Download all (CSV)
        </button>
      </div>
      <Group title="Serial numbers" values={serials} filename={`${stem}-serials.csv`} />
      <Group title="IMEI numbers" values={imeis} filename={`${stem}-imei.csv`} />
      <Group title="Asset / consumable codes" values={codes} filename={`${stem}-codes.csv`} />
    </div>
  );
}
