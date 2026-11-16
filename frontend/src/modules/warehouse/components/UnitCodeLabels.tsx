import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReactToPrint } from "react-to-print";
import { QRCodeSVG } from "qrcode.react";
import Barcode from "react-barcode";
import {
  AlertTriangle, Check, ChevronLeft, ChevronRight, Download, FileSpreadsheet,
  Image as ImageIcon, Info, Printer, QrCode, Search, Shapes,
} from "lucide-react";
import { Button, Card, ErrorBanner } from "@/shared/components";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import { putawayCodeUnits, putawayCodes } from "../api";
import { fmtDate } from "../format";
import {
  PX_PER_MM, barcodeFit, barcodeModulePx, buildCodeSheetSvg, codesToCsv, downloadBlob,
  safeFileName, svgSize, svgToPngBlob,
} from "../codeLabels";
import type { PutawayCodes, PutawayUnitCode } from "../types";
import { guardNumberKeys } from "@/shared/quantity";

/**
 * The label sheet for the codes a putaway minted.
 *
 * A unit only becomes an asset once it is physically somewhere, so the asset /
 * consumable code is generated at putaway (CLAUDE.md, masters overhaul) — and until
 * this panel existed it was generated and never seen. The code is the identity the unit
 * carries for the rest of its life: it is quoted on every issue, every transfer and
 * every document the far end signs, and none of that works if it is not on the goods.
 * This is where it gets onto them.
 *
 * What a label says is decided HERE and nowhere else, because a sticker on a shelf is
 * read by eye at least as often as it is scanned: the item, the batch, the lot, the
 * storage path and the warranty or expiry, all written out and labelled, with the code
 * itself under the symbol.
 *
 * Three things the panel has to get right, in the order they bite:
 *
 * 1. **It pages.** A putaway mints up to 1000 codes, so the codes are a paginated list
 *    like every other (rule 11) and the header is a COUNT. Opening the panel must not
 *    depend on how big the lorry was.
 * 2. **Selection survives paging.** It is held as a default plus the ids that differ
 *    from it, not as a list of rows — so "all 500 selected" is one boolean and an empty
 *    set, and paging around cannot quietly change what will print.
 * 3. **The full set is fetched only when it is needed** — at the press of Print or
 *    Download, never on open. That is the whole reason paging is worth having.
 *
 * Printing goes through react-to-print, the same way `inventory/LabelsPage` does and
 * for the same reason: hiding the app with CSS and positioning a sheet absolutely does
 * not paginate, so anything past page one is clipped and labels tear across the break.
 */

/** Label stock, in millimetres. Sizes are physical — a preview at anything else is a
 *  lie about what comes out of the printer. */
const SIZES = [
  { key: "38x25", w: 38, h: 25, label: "38 × 25" },
  { key: "50x30", w: 50, h: 30, label: "50 × 30" },
  { key: "70x40", w: 70, h: 40, label: "70 × 40" },
  { key: "100x50", w: 100, h: 50, label: "100 × 50" },
] as const;

const DEFAULT_SIZE = "70x40";
const PAGE_SIZES = [12, 24, 48, 96];
/** The server's own ceiling (`core/pagination.MAX_PAGE_SIZE`). Fetching everything for
 *  a print run walks pages of this size — two requests at the 1000-unit mint cap. */
const MAX_FETCH = 500;

type Symbology = "QR" | "BARCODE";
type Job = "print" | "png" | "svg" | "csv";

/** A label is a fixed physical size and must never be split across a page. */
const pageStyle = `
  @page { size: A4; margin: 8mm; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .unit-label {
      break-inside: avoid;
      page-break-inside: avoid;
      border: 1px solid #000;
      color: #000;
      background: #fff;
    }
  }
`;

export function UnitCodeLabels({ taskId }: { taskId: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-putaway-codes", taskId],
    queryFn: () => putawayCodes(taskId),
  });

  if (isLoading) {
    return (
      <Card className="mt-4 p-6 text-center text-sm text-muted">
        Looking up the codes this putaway minted…
      </Card>
    );
  }
  if (error) return <ErrorBanner error={error} />;
  if (!data) return null;
  if (!data.total_codes) return <NothingToPrint codes={data} />;
  return <LabelPanel head={data} />;
}

function NothingToPrint({ codes }: { codes: PutawayCodes }) {
  return (
    <Card className="mt-4 p-6">
      <div className="flex items-start gap-3">
        <QrCode className="mt-0.5 h-5 w-5 shrink-0 text-muted" />
        <div>
          <div className="text-sm font-semibold text-ink">No codes to print</div>
          {/* The server's own sentence for why. Three different things cause an empty
            * sheet and they have three different fixes, so composing one line here
            * would say the wrong one two times in three. */}
          <p className="mt-1 text-sm text-muted">
            {codes.reason ?? "This putaway minted no unit codes."}
          </p>
        </div>
      </div>
    </Card>
  );
}

function LabelPanel({ head }: { head: PutawayCodes }) {
  const total = head.total_codes;

  const [sizeKey, setSizeKey] = useState<string>(DEFAULT_SIZE);
  const [custom, setCustom] = useState({ w: 60, h: 40 });
  const [symbology, setSymbology] = useState<Symbology>("QR");
  const [copies, setCopies] = useState("1");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search, 300);

  /**
   * Selection, as a DEFAULT plus the ids that differ from it.
   *
   * Holding the chosen rows in a list would mean "all 500 selected" could only be true
   * once all 500 had been paged past, and a storekeeper who never leaves page 1 would
   * print 24 of 500 stickers while the button cheerfully said "all". A default of
   * everything plus a set of exceptions is exact from the first render, costs nothing,
   * and survives paging and searching untouched.
   */
  const [mode, setMode] = useState<"all" | "none">("all");
  const [flipped, setFlipped] = useState<Set<number>>(new Set());
  const isOn = useCallback(
    (id: number) => (mode === "all" ? !flipped.has(id) : flipped.has(id)),
    [mode, flipped],
  );
  const chosen = mode === "all" ? total - flipped.size : flipped.size;

  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const dim = sizeKey === "custom"
    ? { w: clamp(custom.w, 20, 200), h: clamp(custom.h, 15, 200) }
    : SIZES.find((s) => s.key === sizeKey) ?? SIZES[2];

  const pageQuery = useQuery({
    queryKey: ["wh-putaway-code-units", head.putaway_id, page, pageSize, query],
    queryFn: () => putawayCodeUnits(head.putaway_id, {
      page, size: pageSize, search: query || undefined,
    }),
    // The grid keeps the previous page on screen while the next one loads, so paging
    // does not blink the whole panel out and back.
    placeholderData: (previous) => previous,
  });
  const rows = pageQuery.data?.items ?? [];
  const matched = pageQuery.data?.total ?? total;
  const pages = Math.max(1, Math.ceil(matched / pageSize));

  /**
   * Every code, fetched only when one is actually being printed or downloaded.
   *
   * This is what paging buys: opening the panel reads one page, and the full set is
   * pulled once, on a press, by somebody who has decided they want all of it.
   */
  const allQuery = useQuery({
    queryKey: ["wh-putaway-code-units-all", head.putaway_id],
    enabled: job !== null,
    staleTime: 60_000,
    queryFn: async () => {
      const out: PutawayUnitCode[] = [];
      for (let p = 1; ; p += 1) {
        const got = await putawayCodeUnits(head.putaway_id, { page: p, size: MAX_FETCH });
        out.push(...got.items);
        if (out.length >= got.total || got.items.length === 0) return out;
      }
    },
  });

  /** What the press applies to: everything selected, in the order it was minted. */
  const outgoing = useMemo(
    () => (allQuery.data ?? []).filter((u) => isOn(u.id)),
    [allQuery.data, isOn],
  );
  /** One entry per sticker — a code asked for three copies becomes three entries. */
  const perLabel = Math.max(1, Math.min(20, Number(copies) || 1));
  const sheet = useMemo(
    () => outgoing.flatMap((u) => Array.from({ length: perLabel }, (_, i) => ({ u, i }))),
    [outgoing, perLabel],
  );

  const print = useReactToPrint({
    content: () => sheetRef.current,
    // The title becomes the filename under "Save as PDF", and a putaway number is
    // `BHS/NA/2026-27/PUT0029` — slashes and all.
    documentTitle: `${safeFileName(head.putaway_no ?? "putaway")}-labels`,
    pageStyle,
  });

  /**
   * Lifts the symbols out of the sheet that is about to print, one per code.
   *
   * Read from the DOM rather than rendered a second time on purpose: an exported file
   * and a printed sticker then cannot carry different symbols, whichever symbology is
   * selected. Copies are deduplicated — three stickers of one code are still one image.
   */
  const collectCells = useCallback(() => {
    const seen = new Set<string>();
    const cells: { code: string; svg: string; width: number; height: number }[] = [];
    sheetRef.current?.querySelectorAll<HTMLElement>("[data-symbol]").forEach((node) => {
      const code = node.dataset.code ?? "";
      const svg = node.querySelector("svg");
      if (!code || !svg || seen.has(code)) return;
      seen.add(code);
      const box = svg.getBoundingClientRect();
      cells.push({
        code,
        svg: svg.outerHTML,
        width: Math.round(box.width) || 96,
        height: Math.round(box.height) || 96,
      });
    });
    return cells;
  }, []);

  // The press lands here once the full set has arrived AND the sheet carrying it has
  // been committed to the DOM — `useEffect` runs after that commit, which is what makes
  // reading the symbols out of it safe.
  useEffect(() => {
    if (!job || !allQuery.isSuccess) return;
    const stem = safeFileName(head.putaway_no ?? "putaway");
    try {
      if (job === "print") {
        print?.();
      } else if (job === "csv") {
        downloadBlob(
          new Blob(["﻿" + codesToCsv(head, outgoing)],
                   { type: "text/csv;charset=utf-8" }),
          `${stem}-codes.csv`,
        );
      } else {
        const svg = buildCodeSheetSvg(collectCells(), {
          title: `${head.putaway_no ?? "Putaway"} · ${head.item_code ?? ""} · ${outgoing.length} codes`,
        });
        if (job === "svg") {
          downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `${stem}-codes.svg`);
        } else {
          const { width, height } = svgSize(svg);
          void svgToPngBlob(svg, width, height)
            .then((blob) => downloadBlob(blob, `${stem}-codes.png`))
            .catch((e) => setJobError(e instanceof Error ? e.message : String(e)));
        }
      }
    } catch (e) {
      setJobError(e instanceof Error ? e.message : String(e));
    }
    setJob(null);
    // `outgoing`/`sheet` are what the effect reads, but re-running on their identity
    // would fire the job twice; `job` is cleared above and gates every run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, allQuery.isSuccess, allQuery.data]);

  const start = (next: Job) => { setJobError(null); setJob(next); };
  const busy = job !== null && allQuery.isFetching;

  const kind = head.code_type === "ASSET" ? "Asset codes"
    : head.code_type === "CONSUMABLE" ? "Consumable codes"
      : "Unit codes";

  // Whether a Code 128 of these codes can physically be scanned off this label. Measured
  // on the LONGEST code on screen, because one unreadable sticker in a run is still a
  // unit nobody can scan. See `codeLabels.barcodeFit` for the history behind this.
  const longest = rows.reduce((a, u) => (u.code.length > a.length ? u.code : a), "");
  const fit = longest ? barcodeFit(longest, dim.w) : null;
  const barcodeTooTight = symbology === "BARCODE" && fit !== null && !fit.ok;

  return (
    <Card className="mt-4 overflow-hidden p-0">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 bg-content2/60 px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-display text-base font-bold text-ink">
            <QrCode className="h-4 w-4 text-brand" /> {kind}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            {total} code{total === 1 ? "" : "s"} minted for{" "}
            <span className="font-mono text-ink">{head.item_code}</span>
            {head.batch_no ? <> · batch <span className="font-mono text-ink">{head.batch_no}</span></> : null}
            {head.bin_code ? <> · <span className="font-mono text-ink">{head.bin_code}</span></> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">
            {chosen} of {total} selected
          </span>
          <Button onClick={() => start("print")} disabled={chosen === 0 || busy}>
            <Printer className="h-4 w-4" />
            {busy && job === "print" ? "Preparing…" : `Print ${chosen} label${chosen === 1 ? "" : "s"}`}
          </Button>
        </div>
      </header>

      <ErrorBanner error={jobError ?? pageQuery.error ?? allQuery.error} />

      <div className="border-b border-line/70 px-5 py-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <fieldset>
            <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Symbol
            </legend>
            <div className="flex items-center gap-1 rounded-xl border border-line bg-content2/60 p-1">
              {([["QR", "QR code", QrCode], ["BARCODE", "Barcode", Shapes]] as const)
                .map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSymbology(key)}
                    aria-pressed={symbology === key}
                    className={`flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors ${
                      symbology === key
                        ? "bg-content1 text-ink shadow-sm ring-1 ring-brand/30"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" /> {label}
                  </button>
                ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
              Label size (mm)
            </legend>
            <div className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-content2/60 p-1">
              {SIZES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSizeKey(s.key)}
                  aria-pressed={sizeKey === s.key}
                  className={`min-h-9 rounded-lg px-3 text-xs font-semibold tabular transition-colors ${
                    sizeKey === s.key
                      ? "bg-content1 text-ink shadow-sm ring-1 ring-brand/30"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {s.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setSizeKey("custom")}
                aria-pressed={sizeKey === "custom"}
                className={`min-h-9 rounded-lg px-3 text-xs font-semibold transition-colors ${
                  sizeKey === "custom"
                    ? "bg-content1 text-ink shadow-sm ring-1 ring-brand/30"
                    : "text-muted hover:text-ink"
                }`}
              >
                Custom
              </button>
            </div>
          </fieldset>

          {sizeKey === "custom" && (
            <div className="flex items-end gap-2">
              <MmInput label="Width" value={custom.w}
                       onChange={(w) => setCustom((c) => ({ ...c, w }))} />
              <span className="pb-2.5 text-xs text-muted">×</span>
              <MmInput label="Height" value={custom.h}
                       onChange={(h) => setCustom((c) => ({ ...c, h }))} />
            </div>
          )}

          <label className="block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
              Copies each
            </span>
            <input
              type="number" onKeyDown={guardNumberKeys}
              min={1}
              max={20}
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
              aria-label="Copies of each label"
              className="h-10 w-20 rounded-lg border border-line bg-content1 px-3 text-center text-sm tabular text-ink outline-none focus:border-brand"
            />
          </label>

          <div>
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
              Download
            </span>
            <div className="flex items-center gap-1.5">
              {/* Three files, three jobs. The images come out in whichever symbology is
                * selected above; the spreadsheet is the same codes as data, for the
                * asset register the sticker never reaches. */}
              <DownloadButton icon={ImageIcon} label="PNG" busy={busy && job === "png"}
                              disabled={chosen === 0 || busy} onClick={() => start("png")} />
              <DownloadButton icon={Download} label="SVG" busy={busy && job === "svg"}
                              disabled={chosen === 0 || busy} onClick={() => start("svg")} />
              <DownloadButton icon={FileSpreadsheet} label="CSV" busy={busy && job === "csv"}
                              disabled={chosen === 0 || busy} onClick={() => start("csv")} />
            </div>
          </div>

          <div className="ml-auto flex items-end gap-2">
            <label className="relative block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
                Find a code
              </span>
              <Search className="pointer-events-none absolute bottom-3 left-3 h-3.5 w-3.5 text-muted" />
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                placeholder="Code, serial or IMEI"
                aria-label="Find a code"
                className="h-10 w-56 rounded-lg border border-line bg-content1 pl-8 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setMode(chosen === total ? "none" : "all");
                setFlipped(new Set());
              }}
              className="h-10 rounded-lg px-3 text-xs font-semibold text-brand hover:underline"
            >
              {chosen === total ? "Clear all" : `Select all ${total}`}
            </button>
          </div>
        </div>

        {barcodeTooTight ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              A barcode of a {longest.length}-character code needs {fit!.modules} bars.
              At {dim.w} mm each bar is {fit!.moduleMm.toFixed(3)} mm wide — under the{" "}
              {MIN_MODULE_MM_LABEL} most scanners can read, so it will print and not
              scan. Use a label at least {fit!.neededMm} mm wide, or switch to the QR
              code, which carries the whole code at any size.
            </span>
          </p>
        ) : (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-line/70 bg-content2 px-3 py-2 text-xs text-body">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
            <span>
              Labels print at their true size — {dim.w} × {dim.h} mm on A4. For a file,
              choose <strong>Destination → Save as PDF</strong> in the print dialog.
              {chosen !== total && <> {total - chosen} deselected and will not print.</>}
            </span>
          </p>
        )}
      </div>

      {/* Hidden, and the only thing that goes to the printer — and the only place the
        * exported symbols are read from, so a downloaded image and a printed sticker
        * can never disagree. Empty until a press: the full set is not fetched on open,
        * which is the whole point of paging the list. */}
      <div className="hidden" aria-hidden>
        <div ref={sheetRef} className="flex flex-wrap gap-2 p-2">
          {sheet.map(({ u, i }) => (
            <CodeLabel key={`print-${u.id}-${i}`} unit={u} head={head} dim={dim}
                       symbology={symbology} />
          ))}
        </div>
      </div>

      <div className="px-5 py-4">
        {pageQuery.isLoading ? (
          <p className="py-10 text-center text-sm text-muted">Loading codes…</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line py-10 text-center text-sm text-muted">
            No code matches “{search}”.
          </p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {rows.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => setFlipped((f) => {
                  const next = new Set(f);
                  if (next.has(u.id)) next.delete(u.id); else next.add(u.id);
                  return next;
                })}
                aria-pressed={isOn(u.id)}
                aria-label={`${isOn(u.id) ? "Exclude" : "Include"} ${u.code}`}
                className={`group relative rounded-xl border p-1.5 text-left transition-all ${
                  isOn(u.id)
                    ? "border-brand/25 bg-content1 shadow-sm hover:border-brand/60 hover:shadow-md"
                    : "border-line bg-content2/40 opacity-45 hover:opacity-70"
                }`}
              >
                <span
                  className={`absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border text-white transition-colors ${
                    isOn(u.id) ? "border-brand bg-brand" : "border-line bg-content1"
                  }`}
                >
                  {isOn(u.id) && <Check size={12} strokeWidth={3} />}
                </span>
                <CodeLabel unit={u} head={head} dim={dim} symbology={symbology} />
              </button>
            ))}
          </div>
        )}

        <Pager
          page={page}
          pages={pages}
          size={pageSize}
          total={matched}
          filtered={!!query && matched !== total}
          onPage={setPage}
          onSize={(next) => { setPageSize(next); setPage(1); }}
        />
      </div>
    </Card>
  );
}

const MIN_MODULE_MM_LABEL = "0.19 mm";

function DownloadButton({ icon: Icon, label, onClick, disabled, busy }: {
  icon: typeof Download; label: string; onClick: () => void;
  disabled: boolean; busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-10 items-center gap-1.5 rounded-lg border border-line bg-content1 px-3 text-xs font-semibold text-ink transition-colors hover:border-brand/50 hover:bg-content2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5 text-muted" /> {busy ? "…" : label}
    </button>
  );
}

/**
 * The pager.
 *
 * Always drawn, even on a single page, because it is also where "24 per page" lives and
 * a control that appears only once a list is long enough is a control nobody finds.
 */
function Pager({ page, pages, size, total, filtered, onPage, onSize }: {
  page: number; pages: number; size: number; total: number; filtered: boolean;
  onPage: (p: number) => void; onSize: (s: number) => void;
}) {
  const first = total === 0 ? 0 : (page - 1) * size + 1;
  const last = Math.min(page * size, total);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-3">
      <span className="text-xs text-muted">
        Showing <span className="tabular text-ink">{first}–{last}</span> of{" "}
        <span className="tabular text-ink">{total}</span>
        {filtered ? " matching codes" : " codes"}
      </span>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted">
          Per page
          <select
            value={String(size)}
            onChange={(e) => onSize(Number(e.target.value))}
            aria-label="Codes per page"
            className="h-9 rounded-lg border border-line bg-content1 px-2 text-xs tabular text-ink outline-none focus:border-brand"
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <PagerStep label="Previous page" disabled={page <= 1}
                     onClick={() => onPage(page - 1)} icon={ChevronLeft} />
          <span className="min-w-24 text-center text-xs tabular text-ink">
            Page {page} of {pages}
          </span>
          <PagerStep label="Next page" disabled={page >= pages}
                     onClick={() => onPage(page + 1)} icon={ChevronRight} />
        </div>
      </div>
    </div>
  );
}

function PagerStep({ label, disabled, onClick, icon: Icon }: {
  label: string; disabled: boolean; onClick: () => void; icon: typeof ChevronLeft;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-content1 text-muted transition-colors hover:border-brand/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function MmInput({ label, value, onChange }: {
  label: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </span>
      <input
        type="number" onKeyDown={guardNumberKeys}
        min={20}
        max={200}
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${label} in millimetres`}
        className="h-10 w-20 rounded-lg border border-line bg-content1 px-3 text-center text-sm tabular text-ink outline-none focus:border-brand"
      />
    </label>
  );
}

/**
 * One sticker, at its true physical size.
 *
 * Type scales with the label rather than being fixed, because the same markup has to be
 * legible at 38mm and not look like a postage stamp lost on a 100mm one. Everything is
 * black on white with no design tokens: a sticker is printed, and a token that resolves
 * to a pale grey on screen resolves to an unreadable grey on paper.
 *
 * A row with no value is DROPPED rather than printed empty — a 38mm label has no room
 * for "Batch —", and a blank field reads as missing data rather than as not-applicable.
 */
function CodeLabel({ unit, head, dim, symbology }: {
  unit: PutawayUnitCode;
  head: PutawayCodes;
  dim: { w: number; h: number };
  symbology: Symbology;
}) {
  // One scale for the whole label, taken off the height: the symbol and the type have
  // to shrink together or a small label ends up as a QR with no room for words.
  const scale = clamp(dim.h / 40, 0.62, 1.9);
  const px = (v: number) => `${(v * scale).toFixed(2)}px`;
  const qr = Math.max(36, Math.min((dim.h - 9) * PX_PER_MM, dim.w * PX_PER_MM * 0.36));

  const rows: [string, string | null | undefined][] = [
    ["Batch", head.batch_no],
    ["Lot", head.lot_no],
    ["Bin", head.bin_path ?? head.bin_code],
    // Empty rather than the usual em-dash: a row with no value is dropped below, and
    // "—" is a value as far as that check is concerned.
    [head.is_asset ? "Warranty" : "Expiry", fmtDate(head.expiry_date, "") || null],
    // Only when it is something other than the code itself. `_place_unit_codes` writes
    // the code into `serial_number` for an unserialised unit — that IS its identity —
    // so printing both would be the same string twice on a 38mm label.
    ["Serial", unit.serial_number && unit.serial_number !== unit.code ? unit.serial_number : null],
    ["IMEI", unit.imei],
  ];

  // A barcode is a wide, short thing and a QR is a square one, so they cannot share a
  // layout: the barcode gets the full width under the meta rows, the QR sits beside
  // them. `displayValue` is off because the code is written out below either way, and
  // the barcode's own caption would print it twice at a size nobody chose.
  const barcode = symbology === "BARCODE";
  const symbol = barcode ? (
    <Barcode
      value={unit.code}
      format="CODE128"
      width={barcodeModulePx(unit.code, dim.w)}
      height={Math.max(18, (dim.h - 13) * PX_PER_MM * 0.5)}
      margin={0}
      displayValue={false}
      background="#ffffff"
      lineColor="#000000"
    />
  ) : (
    <QRCodeSVG value={unit.code} size={qr} level="M" className="block shrink-0" />
  );

  return (
    <div
      className="unit-label flex flex-col overflow-hidden rounded border border-line bg-white text-black"
      style={{ width: `${dim.w}mm`, height: `${dim.h}mm`, padding: px(4) }}
    >
      <div className="min-w-0 truncate font-bold leading-tight" style={{ fontSize: px(8) }}>
        {head.item_name ?? head.item_code}
      </div>

      <div
        className={`flex min-h-0 flex-1 ${barcode ? "flex-col justify-between" : "items-center"}`}
        style={{ gap: px(barcode ? 1 : 4) }}
      >
        <dl className="min-w-0 flex-1 overflow-hidden" style={{ fontSize: px(6) }}>
          {rows.map(([label, value]) => (value ? (
            <div key={label} className="flex leading-tight" style={{ gap: px(3) }}>
              <dt className="shrink-0 font-semibold uppercase opacity-70">{label}</dt>
              <dd className="min-w-0 flex-1 truncate font-mono">{value}</dd>
            </div>
          ) : null))}
        </dl>
        {/* `data-symbol` is how the exporters find this node — see `collectCells`. */}
        <span
          data-symbol
          data-code={unit.code}
          className={barcode
            ? "flex w-full justify-center overflow-hidden"
            : "flex shrink-0 items-center"}
        >
          {symbol}
        </span>
      </div>

      {/* The code, written out. Neither symbol prints a caption of its own here, and a
        * picker still has to be able to read the code off the sticker with the scanner
        * in a pocket. */}
      <div
        className="truncate border-t border-black/25 text-center font-mono font-bold leading-none"
        style={{ fontSize: px(7.5), paddingTop: px(2), marginTop: px(1) }}
      >
        {unit.code}
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
