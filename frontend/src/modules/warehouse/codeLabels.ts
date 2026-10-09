import type { PutawayCodes, PutawayUnitCode } from "./types";

/**
 * The arithmetic and the file building behind the code label sheet.
 *
 * Pure functions, kept out of the component on purpose: the interesting part is not
 * the markup, it is whether a barcode of a 36-character asset code can physically be
 * scanned off a 38mm sticker. That is a number, and a number can be pinned by a test.
 */

/** CSS millimetres at the 96dpi the browser lays out in. */
export const PX_PER_MM = 96 / 25.4;

/**
 * Modules (narrow-bar widths) in a Code 128 symbol of `n` characters.
 *
 * Each character is 11 modules, plus a start character and a check character (11 each)
 * and a 13-module stop pattern. The quiet zone either side is 10 modules and is part of
 * the symbol as far as fitting it on a label goes — a barcode printed to the edge of
 * the stock does not scan.
 */
export function code128Modules(length: number): number {
  return 11 * (Math.max(1, length) + 2) + 13 + 20;
}

/**
 * The narrowest bar a scanner is expected to read, in millimetres.
 *
 * 0.19mm is the low end of the GS1 range for a general-distribution Code 128 printed
 * on a thermal label. Below it the symbol still LOOKS right on screen and on paper, and
 * simply does not scan — which is the worst way for a label to fail, because nobody
 * finds out until the goods are on a truck.
 */
export const MIN_MODULE_MM = 0.19;

/**
 * Can this code be printed as a barcode on this label, and how wide is a bar if so.
 *
 * BUG_SCM_INV_042 / BUG_SCM_INV_058 are what this exists for. Item and asset codes here
 * run to 30-41 characters (`ELCCBL01-GEN-SMS-MFR-0001-1-00042317`), a Code 128 of that
 * length needs over 400 modules, and two earlier fixes tried to shrink one onto a
 * thermal roll before the barcode option was dropped from Labels & Printing entirely.
 * A QR carries the same 41 characters at any size, which is why it is the default here.
 *
 * The barcode is offered anyway — plenty of sites run scanners that only read linear
 * symbols — but never silently: a code that cannot be printed scannably at the chosen
 * size says so, with the two ways out.
 */
export function barcodeFit(code: string, labelWidthMm: number, marginMm = 5) {
  const modules = code128Modules(code.length);
  const usableMm = Math.max(1, labelWidthMm - marginMm);
  const moduleMm = usableMm / modules;
  const neededMm = Math.ceil(modules * MIN_MODULE_MM + marginMm);
  return {
    modules,
    moduleMm,
    ok: moduleMm >= MIN_MODULE_MM,
    /** The label width this code would need to print a scannable Code 128. */
    neededMm,
  };
}

/** A barcode's module width in PIXELS, which is what react-barcode's `width` takes. */
export function barcodeModulePx(code: string, labelWidthMm: number): number {
  // Never below a hairline: a zero-width bar renders as nothing at all, and a label
  // with no symbol on it is worse than one carrying a symbol the warning calls out.
  return Math.max(0.5, barcodeFit(code, labelWidthMm).moduleMm * PX_PER_MM);
}

export interface SheetCell {
  code: string;
  /** The symbol's own markup, lifted from the sheet that is about to print, so an
   *  exported file and a printed sticker can never carry different symbols. */
  svg: string;
  width: number;
  height: number;
}

/**
 * The selected codes' symbols as ONE self-contained SVG document.
 *
 * One file rather than one per code on purpose: a browser refuses a burst of downloads,
 * and a folder of 500 files is not what anybody wanted anyway. Each symbol is embedded
 * as a nested `<svg>` with its own viewBox, which is how it keeps its geometry at any
 * scale — a barcode redrawn at the wrong aspect ratio stops scanning.
 */
export function buildCodeSheetSvg(cells: SheetCell[], opts: {
  title: string;
  columns?: number;
  captionPx?: number;
  padPx?: number;
} ): string {
  const captionPx = opts.captionPx ?? 11;
  const pad = opts.padPx ?? 12;
  const cellW = Math.max(...cells.map((c) => c.width), 1);
  const cellH = Math.max(...cells.map((c) => c.height), 1);
  const columns = Math.max(1, opts.columns ?? Math.min(6, Math.ceil(Math.sqrt(cells.length))));
  const rows = Math.ceil(cells.length / columns);
  const stepX = cellW + pad * 2;
  const stepY = cellH + captionPx + 6 + pad * 2;
  const width = columns * stepX;
  const height = rows * stepY + 28;

  const body = cells.map((cell, i) => {
    const x = (i % columns) * stepX + pad + (cellW - cell.width) / 2;
    const y = Math.floor(i / columns) * stepY + 28 + pad;
    // The symbol keeps its intrinsic size; only its position is set here.
    const symbol = cell.svg
      .replace(/^<svg/, `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}"`);
    const cx = (i % columns) * stepX + stepX / 2;
    const cy = y + cell.height + captionPx + 2;
    return `${symbol}<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="${captionPx}" font-weight="700" text-anchor="middle" fill="#000">${escapeXml(cell.code)}</text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="#fff"/>`
    + `<text x="${pad}" y="19" font-family="system-ui,sans-serif" font-size="13" font-weight="700" fill="#000">${escapeXml(opts.title)}</text>`
    + `${body}</svg>`;
}

/**
 * The codes as a spreadsheet — the other thing people want them for.
 *
 * A sticker goes on the goods; this goes into the asset register, the insurance
 * schedule or whatever the finance team keeps. Every column the label carries, so the
 * two never say different things about the same unit.
 */
export function codesToCsv(head: PutawayCodes, units: PutawayUnitCode[]): string {
  const columns = [
    "Code", "Code type", "Scope", "Serial", "IMEI", "Status",
    "Item code", "Item name", "Batch", "Lot", "Warehouse", "Bin", "Bin path",
    head.is_asset ? "Warranty" : "Expiry", "Putaway", "Put away at",
  ];
  const rows = units.map((u) => [
    u.code, u.code_type, u.scope, u.serial_number ?? "", u.imei ?? "", u.status ?? "",
    head.item_code ?? "", head.item_name ?? "", head.batch_no ?? "", head.lot_no ?? "",
    head.warehouse_name ?? "", head.bin_code ?? "", head.bin_path ?? "",
    head.expiry_date ?? "", head.putaway_no ?? "", head.completed_at ?? "",
  ]);
  return [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Excel reads a leading `=`, `+`, `-` or `@` as a formula, so a cell starting with one
 *  is prefixed AND quoted — a code is text, never something to evaluate. Quoted as well
 *  as prefixed so the apostrophe is unambiguously part of the field rather than
 *  something a second parser has to guess about. */
function csvCell(value: string): string {
  const text = String(value ?? "");
  const injectable = /^[=+\-@]/.test(text);
  const safe = injectable ? `'${text}` : text;
  return injectable || /[",\r\n]/.test(safe)
    ? `"${safe.replace(/"/g, '""')}"`
    : safe;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] as string
  ));
}

/** A putaway number is `BHS/NA/2026-27/PUT0029` — slashes and all, and a filename is
 *  not allowed any of them. */
export function safeFileName(stem: string): string {
  return (stem || "codes").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "_");
}

/** Hands the browser a file. Revoked on the next tick: Safari never fires the click on
 *  a URL that has already been released. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Rasterises an SVG document to a PNG blob.
 *
 * `scale` is 3 by default — a code image dropped into a Word document or a label
 * designer at 1× is a blurred symbol that will not scan, and there is no way to get the
 * resolution back afterwards.
 *
 * The SVG is self-contained (no external fonts, images or stylesheets), which is what
 * keeps the canvas untainted and `toBlob` legal.
 */
export function svgToPngBlob(svg: string, width: number, height: number,
                             scale = 3): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("This browser cannot render the code images."));
        return;
      }
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (
        blob ? resolve(blob) : reject(new Error("Could not build the PNG."))
      ), "image/png");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read the code images."));
    };
    image.src = url;
  });
}

/** Width and height off an SVG document string, for the canvas it is drawn onto. */
export function svgSize(svg: string): { width: number; height: number } {
  const w = /width="(\d+(?:\.\d+)?)"/.exec(svg);
  const h = /height="(\d+(?:\.\d+)?)"/.exec(svg);
  return { width: Number(w?.[1] ?? 600), height: Number(h?.[1] ?? 400) };
}
