import * as XLSX from "xlsx";
import type { WarrantyEntry } from "./warrantyDraft";

/**
 * Serials, IMEIs and their warranties from a spreadsheet (2026-11-21).
 *
 * The template is the popup's own table: one row per unit received, with the codes
 * already captured filled in. An upload is checked WHOLE before anything is applied —
 * a half-applied sheet leaves a storekeeper working out which half went in:
 * - exactly as many rows as units received on the line (the rule the codes already
 *   have);
 * - every row has the code(s) the item is tracked by; no code twice in the file, nor
 *   one already on another line of this item;
 * - dates are real dates, both or neither, and never end before they start.
 * A card file name that is not attached yet is a WARNING: the cards are matched once
 * they are added with "Card files".
 */
export interface SheetRow {
  serial: string;
  imei: string;
  entry: WarrantyEntry;
}

export interface SheetCheck {
  rows: SheetRow[];
  problems: string[];
  warnings: string[];
}

const HEAD = {
  unit: "Unit",
  serial: "Serial number",
  imei: "IMEI",
  start: "Warranty start (DD-MM-YYYY)",
  end: "Warranty end (DD-MM-YYYY)",
  card: "Warranty card no.",
  file: "Card file name",
};

const pad = (n: number) => String(n).padStart(2, "0");
const toDmy = (iso: string) => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : "");

/** A cell as a date: an Excel date, a serial day number, DD-MM-YYYY, DD/MM/YYYY or
 *  YYYY-MM-DD. "" for an empty cell; null for something that is not a date. */
export function readDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    return parsed ? `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)}` : null;
  }
  const text = String(value).trim();
  if (!text) return "";
  let y: number, m: number, d: number;
  let hit = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (hit) { [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])]; }
  else {
    hit = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
    if (!hit) return null;
    [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** The template workbook for one line, prefilled with what the popup holds. */
export function templateWorkbook(opts: {
  rows: { serial: string; imei: string; entry?: WarrantyEntry }[];
  qty: number; trackSerial: boolean; trackImei: boolean; itemName: string; batchNo?: string | null;
}): XLSX.WorkBook {
  const head = [HEAD.unit, ...(opts.trackSerial ? [HEAD.serial] : []), ...(opts.trackImei ? [HEAD.imei] : []),
                HEAD.start, HEAD.end, HEAD.card, HEAD.file];
  const body = Array.from({ length: Math.max(opts.qty, opts.rows.length) }, (_, i) => {
    const r = opts.rows[i] ?? { serial: "", imei: "" };
    const e = r.entry;
    return [i + 1, ...(opts.trackSerial ? [r.serial] : []), ...(opts.trackImei ? [r.imei] : []),
            toDmy(e?.start ?? ""), toDmy(e?.end ?? ""), e?.cardNo ?? "",
            e?.file?.name ?? e?.documentName ?? e?.fileHint ?? ""];
  });
  const sheet = XLSX.utils.aoa_to_sheet([head, ...body]);
  sheet["!cols"] = head.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const notes = XLSX.utils.aoa_to_sheet([
    ["How to fill this sheet"],
    [`Item: ${opts.itemName}${opts.batchNo ? ` · batch ${opts.batchNo}` : ""}`],
    [`One row per unit received — exactly ${opts.qty} rows.`],
    ["Dates as DD-MM-YYYY. Leave both blank for a unit with no warranty."],
    ["Card file name: the PDF or photo of that unit's card, e.g. SN0001.pdf — attach the files with 'Card files' after uploading this sheet."],
  ]);
  notes["!cols"] = [{ wch: 110 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Units");
  XLSX.utils.book_append_sheet(book, notes, "How to fill");
  return book;
}

export function downloadTemplate(book: XLSX.WorkBook, fileName: string) {
  XLSX.writeFile(book, fileName);
}

/** Read the first sheet into plain rows (header row by name, case-insensitive). */
export async function readSheet(file: File): Promise<Record<string, unknown>[]> {
  const book = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  return sheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true }) : [];
}

/** Check a whole sheet against the line. Nothing is applied unless `problems` is empty. */
export function checkSheet(raw: Record<string, unknown>[], opts: {
  qty: number; trackSerial: boolean; trackImei: boolean;
  /** Codes already on the item's OTHER lines, lower-cased. */
  takenElsewhere: Set<string>;
}): SheetCheck {
  const pick = (row: Record<string, unknown>, ...names: string[]) => {
    const keys = Object.keys(row);
    for (const name of names) {
      const key = keys.find((k) => k.trim().toLowerCase().startsWith(name.toLowerCase()));
      if (key !== undefined) return row[key];
    }
    return "";
  };
  const problems: string[] = [];
  const warnings: string[] = [];
  const filled = raw.filter((row) => Object.entries(row).some(([k, v]) =>
    !/^unit$/i.test(k.trim()) && String(v ?? "").trim() !== ""));
  if (filled.length !== opts.qty) {
    problems.push(`The sheet has ${filled.length} unit row${filled.length === 1 ? "" : "s"}, but ${opts.qty} ${opts.qty === 1 ? "unit was" : "units were"} received on this line — it must be exactly ${opts.qty}.`);
  }
  const seen = { serial: new Map<string, number>(), imei: new Map<string, number>() };
  const rows: SheetRow[] = filled.map((row, i) => {
    const n = i + 2; // the sheet's own row number, under the header
    const serial = String(pick(row, "serial") ?? "").trim();
    const imei = String(pick(row, "imei") ?? "").trim();
    for (const [kind, value, tracked] of [["serial", serial, opts.trackSerial], ["imei", imei, opts.trackImei]] as const) {
      if (!tracked) continue;
      const label = kind === "imei" ? "IMEI" : "serial number";
      if (!value) { problems.push(`Row ${n}: the ${label} is missing.`); continue; }
      const key = value.toLowerCase();
      const first = seen[kind].get(key);
      if (first) problems.push(`Row ${n}: ${label} ${value} is also on row ${first}.`);
      else seen[kind].set(key, n);
      if (opts.takenElsewhere.has(key)) problems.push(`Row ${n}: ${label} ${value} is already on another line of this item.`);
    }
    const start = readDate(pick(row, "warranty start", "start"));
    const end = readDate(pick(row, "warranty end", "end"));
    if (start === null) problems.push(`Row ${n}: the warranty start is not a date — use DD-MM-YYYY.`);
    if (end === null) problems.push(`Row ${n}: the warranty end is not a date — use DD-MM-YYYY.`);
    if (start && end === "") problems.push(`Row ${n}: give the warranty end date too.`);
    if (end && start === "") problems.push(`Row ${n}: give the warranty start date too.`);
    if (start && end && end < start) problems.push(`Row ${n}: the warranty ends before it starts.`);
    const cardNo = String(pick(row, "warranty card", "card no") ?? "").trim().slice(0, 100);
    const fileHint = String(pick(row, "card file") ?? "").trim() || null;
    if (fileHint && !(start && end)) warnings.push(`Row ${n}: a card file is named but no warranty dates — it will not count until the dates are given.`);
    return { serial, imei, entry: { start: start || "", end: end || "", cardNo, fileHint } };
  });
  return { rows, problems, warnings };
}
