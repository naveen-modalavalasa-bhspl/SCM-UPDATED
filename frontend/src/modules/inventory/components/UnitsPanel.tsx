import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { Check, Copy, Download } from "lucide-react";
import { getUnits } from "../api";
import type { UnitRow } from "../types";
import { TONE_BLUE } from "@/shared/components/tones";
import { writeToClipboard } from "@/shared/clipboard";

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
      if (!await writeToClipboard(values.join("\n"))) throw new Error("copy failed");
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

/** How many chips are DRAWN. Copy and Download still carry every value.
 *
 *  One `<span>` per unit was fine at the 108 units this panel was written for and is
 *  not at 10,000: the popover mounts ten thousand nodes into a box that shows eight
 *  rows of them, which locks the tab for seconds after the data has already arrived.
 *  The list is scanned by eye or taken away as a file; nobody scrolls to unit 7,000. */
const CHIPS_DRAWN = 300;

/** The codes of a lot under the PACKAGE each sits in (2026-10-26): one card per
 *  package — its code, what it holds — with its units' codes inside, and the units no
 *  package holds listed as loose. */
function PackageGroups({ units, stem }: { units: UnitRow[]; stem: string }) {
  const byPack = new Map<string, { name: string; holds: number | null; codes: string[] }>();
  const loose: string[] = [];
  for (const u of units) {
    const code = u.asset_code || u.consumable_code || u.serial_number;
    if (!code) continue;
    if (!u.package_code) { loose.push(code); continue; }
    const group = byPack.get(u.package_code)
      ?? { name: u.package_name ?? "Package", holds: u.package_holds ?? null, codes: [] };
    group.codes.push(code);
    byPack.set(u.package_code, group);
  }
  const [open, setOpen] = useState<string | null>(null);
  if (!byPack.size) return null;
  const all = [...byPack.entries()].flatMap(([pack, g]) => g.codes.map((c) => `${pack},${c}`));
  return (
    <div className="rounded-lg border border-line/70 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Packages · {byPack.size}{loose.length ? ` · ${loose.length} loose` : ""}
        </span>
        <CopyDownload values={["Package,Code", ...all]} filename={`${stem}-packages.csv`} />
      </div>
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {[...byPack.entries()].map(([pack, g]) => {
          const on = open === pack;
          return (
            <li key={pack} className="rounded-md border border-line/60 bg-content1">
              <button type="button" onClick={() => setOpen(on ? null : pack)}
                      className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px] font-semibold text-ink" title={pack}>{pack}</span>
                  <span className="text-[10px] text-muted">
                    {g.name}{g.holds != null ? ` · holds ${g.holds}` : ""} · {g.codes.length} code{g.codes.length === 1 ? "" : "s"}
                  </span>
                </span>
                <span className="text-[10px] font-semibold text-brand">{on ? "Hide" : "Show codes"}</span>
              </button>
              {on && (
                <div className="flex flex-wrap gap-1 border-t border-line/60 px-2 py-1.5">
                  {g.codes.map((c) => (
                    <span key={c} className="select-all rounded bg-content2 px-2 py-0.5 font-mono text-[11px] text-body">{c}</span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {loose.length > 0 && (
        <div className="mt-1.5">
          <Group title="Loose (in no package)" values={loose} filename={`${stem}-loose.csv`} />
        </div>
      )}
    </div>
  );
}

function Group({ title, values, filename }: {
  title: string; values: string[]; filename: string;
}) {
  if (!values.length) return null;
  const drawn = values.slice(0, CHIPS_DRAWN);
  const hidden = values.length - drawn.length;
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
          {drawn.map((v) => (
            <span
              key={v}
              className="select-all rounded bg-content2 px-2 py-0.5 font-mono text-[11px] text-body"
            >
              {v}
            </span>
          ))}
        </div>
        {hidden > 0 && (
          <p className="mt-1.5 text-[11px] text-muted">
            {hidden.toLocaleString("en-IN")} more not shown — Copy and Download carry
            all {values.length.toLocaleString("en-IN")}.
          </p>
        )}
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
export function UnitCell({
  text, extra, lot, title, units, caption = "units in lot", listTitle = "Units",
}: {
  text?: string | null;
  extra?: number;
  /** Omitted when the value came off the stock row itself: there are no per-unit rows
   *  behind it to open. */
  lot?: UnitsPanelProps & { label?: string };
  title?: string;
  /** The exact values behind this cell, when the caller already knows them.
   *
   *  NEW 2026-08-22, for the stock ledger. A `lot` popover asks the server which units
   *  are standing there NOW, which is the right answer for a stock row and the wrong
   *  one for a MOVEMENT: a ledger line for 2 units issued opened a panel listing the
   *  198 left on the shelf. A movement knows exactly what it carried, so it hands the
   *  list over instead of asking. Takes precedence over `lot`. */
  units?: string[];
  /** What the count line calls them — "units in lot" on a stock row, "units in this
   *  movement" on a ledger row. The two are not the same set and must not read alike. */
  caption?: string;
  /** Heading over the list in the popover. */
  listTitle?: string;
}) {
  const list = (units ?? []).filter(Boolean);
  const shown = text ?? list[0];
  const more = extra ?? (list.length ? list.length - 1 : 0);
  if (!shown) return <span className="text-xs text-muted">—</span>;
  const body = (
    // max-w: the table lays out auto, so a cell holding every serial in the lot on one
    // nowrap line widened the column until the page scrolled sideways. Cap it and let
    // truncate do its job; the whole list is in the popover.
    <div className="min-w-0 max-w-[12rem] text-left">
      <div className="truncate font-mono text-xs text-body">{shown}</div>
      {/* The WHOLE count, not "+18 more". A lot of 19 units sat beside an Available of
          12 and a Reserved of 7, and "+18 more" left the reader to work out that the
          three numbers agree. "19 units in lot" reconciles on sight: 12 free, 7 spoken
          for, 19 things on the shelf. */}
      {!!more && more > 0 && (
        <div className="text-[11px] text-brand">{more + 1} {caption}</div>
      )}
    </div>
  );
  // A known list wins: there is nothing to fetch, and fetching would answer a
  // different question from the one this cell is asking.
  if (list.length > 1) {
    return (
      <Popover placement="bottom-start" showArrow>
        <PopoverTrigger>
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
            {title && <div className="mb-2 text-xs font-semibold text-ink">{title}</div>}
            <Group
              title={listTitle}
              values={list}
              filename={`${(title || "units").replace(/[^\w.-]+/g, "_")}.csv`}
            />
          </div>
        </PopoverContent>
      </Popover>
    );
  }
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
  /** The serial a unit ACTUALLY carries, or nothing.
   *
   *  FIXED 2026-08-21 — an unserialised unit is given its asset or consumable code as
   *  its `serial_number` too (`warehouse._place_unit_codes` writes the one string into
   *  both columns, because `whs_serial_numbers.serial_number` is UNIQUE and NOT NULL
   *  and there is nothing else to put there). This panel read the column raw, so a unit
   *  with no serial tracking at all listed its asset code under "Serial" — the same
   *  code then appeared again in the Asset code column beside it, and one unit read as
   *  two identities.
   *
   *  The SUMMARY endpoint already suppresses this (`warehouse.serial_summary` keeps a
   *  serial only for an item the master says is serial tracked), which is why the Stock
   *  Ledger column was right and this panel was not: the panel reads the raw `/serials`
   *  rows instead, and nothing filtered them.
   *
   *  Compared against the codes rather than re-fetching the item's flags: the row that
   *  proves it is the row in hand, and the panel is opened per lot with no item master
   *  on the wire. The same string in both columns means it was never a serial. */
  const realSerial = (u: UnitRow) =>
    u.serial_number && u.serial_number !== u.asset_code
      && u.serial_number !== u.consumable_code
      ? u.serial_number : undefined;

  const serials = units.map(realSerial).filter(Boolean) as string[];
  const imeis = units.map((u) => u.imei).filter(Boolean) as string[];
  const codes = units
    .map((u) => u.asset_code || u.consumable_code)
    .filter(Boolean) as string[];

  /** Built on the press, not on every render: a lot of 10,000 units is 10,000 rows of
   *  CSV, and rebuilding that string on each re-render of the popover cost more than
   *  the download it exists for. */
  const everything = () => [
    ["Serial", "IMEI", "Asset code", "Consumable code", "Batch", "Bin", "Status"],
    ...units.map((u: UnitRow) => [
      // Blank, not the code: the export has an Asset code column of its own, and
      // repeating the value made a spreadsheet read as two identities per unit.
      realSerial(u), u.imei, u.asset_code, u.consumable_code,
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
        {/* "of N" only when the two disagree. `getUnits` walks the whole lot now, so
            they normally match; a lot past its page ceiling is the one case where the
            panel must say it is showing a subset rather than let Copy and Download
            hand over part of a lot as if it were all of it. */}
        <span className="text-xs text-muted">
          {expected && expected > units.length
            ? `${units.length} of ${expected} units here`
            : `${units.length} units here`}
        </span>
        <button
          type="button"
          className={`inline-flex h-7 items-center gap-1 rounded-md border border-line px-2 text-[11px] font-medium text-body transition-colors hover:bg-content2 ${TONE_BLUE}`}
          onClick={() => download(`${stem}-units.csv`, everything())}
        >
          <Download size={12} /> Download all (CSV)
        </button>
      </div>
      <Group title="Serial numbers" values={serials} filename={`${stem}-serials.csv`} />
      <Group title="IMEI numbers" values={imeis} filename={`${stem}-imei.csv`} />
      {units.some((u) => u.package_code) ? (
        <PackageGroups units={units} stem={stem} />
      ) : (
        <Group title="Asset / consumable codes" values={codes} filename={`${stem}-codes.csv`} />
      )}
    </div>
  );
}
