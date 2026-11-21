import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  AlertTriangle, Check, CheckCircle2, ChevronDown, ClipboardList, ClipboardPaste, Eraser,
  Layers, ScanLine, ShieldAlert, ShieldCheck, Smartphone, Tag, X,
} from "lucide-react";
import { fmtQty } from "../format";
import {
  BatchWarrantyForm, BulkWarrantyBar, FillEmptyBar, ImportReport, RowWarrantyCells,
  SwitchConfirm, WarrantyModeChooser,
} from "./WarrantyParts";
import {
  emptyEntry, entryProblem, hasDates, isBlank, matchCards, type LineWarrantyDraft,
  type WarrantyEntry, type WarrantyMode,
} from "./warrantyDraft";
import { checkSheet, downloadTemplate, readSheet, templateWorkbook } from "./warrantyExcel";

/**
 * Serials and IMEIs for every unit of one item on a receipt (2026-10-21).
 *
 * One ROW PER UNIT, with the serial and the IMEI side by side. The server pairs
 * `serial_numbers[i]` with `imei_numbers[i]` as the same physical handset
 * (`_land_units`), so two separate lists typed in two separate popups were one
 * mis-ordered scan away from giving a phone somebody else's IMEI. A row is the unit.
 *
 * The item's lines are GROUPS — the same item in two batches, or one batch in two
 * packings, is two lines of the receipt and two groups here. Codes are unique across
 * all of them, because the server refuses a serial used twice for one item on one
 * receipt whichever line it is on.
 *
 * What it checks before Save, so nothing is learnt at the server:
 * - a code used twice for this item (red, names where the other one is);
 * - a half-filled unit when both are tracked (a serial with no IMEI cannot be
 *   saved without pairing the next IMEI with the wrong handset);
 * - an IMEI that is not 15 digits, or whose check digit is wrong (amber — a warning,
 *   never a block: the label is what it is, and a misprint still has to get in).
 *
 * Saving fewer codes than units is allowed here, so a storekeeper can stop half-way
 * through a carton; the receipt's own Save still insists on one per unit.
 */
export interface UnitCodeGroup {
  /** The line's index in the form. */
  index: number;
  batchNo?: string | null;
  packLabel?: string | null;
  /** Units on the line — the received quantity. */
  qty: number;
  serials: string[];
  imeis: string[];
}

export interface UnitCodeSave {
  index: number;
  serial_numbers: string[] | null;
  imei_numbers: string[] | null;
  /** The line's warranty as left in the popup (2026-11-21), when warranties are on. */
  warranty?: LineWarrantyDraft;
}

/** Warranty inside the popup (2026-11-21): how it is given, the batch's, each piece's. */
export interface UnitWarrantyOptions {
  /** May the warranty be changed here — a GRN not cancelled, by someone who may file. */
  editable: boolean;
  /** Each line's draft, by the line's index in the form. */
  drafts: Record<number, LineWarrantyDraft | undefined>;
  /** Set when the codes are fixed (a submitted GRN): the popup's Save goes straight to
   *  the server. Without it, the warranty is kept with the form and saved with the GRN. */
  persist?: (updates: UnitCodeSave[]) => Promise<void>;
}

type Kind = "serial" | "imei";
type Row = { serial: string; imei: string };
type Cell = { group: number; row: number; kind: Kind };

/** A sheet's two columns paste with a tab between them. */
const TAB = String.fromCharCode(9);

const IMEI_RE = /^\d{15}$/;

/** The IMEI check digit is a Luhn digit over the first fourteen. */
function luhnOk(value: string): boolean {
  let sum = 0;
  for (let i = 0; i < value.length; i += 1) {
    let d = Number(value[value.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

/** What a pasted list holds. `pairs` is two columns — a serial and its IMEI per line. */
type BulkMode = "serial" | "imei" | "pairs";

const bulkNoun = (mode: BulkMode) =>
  mode === "pairs" ? "serial & IMEI pairs" : mode === "imei" ? "IMEIs" : "serials";

/** The list as codes, or a sentence saying which line of it is not a pair. Codes are
 *  separated the way people paste them: new lines, spaces, commas, semicolons; a pair
 *  is one line holding two of them (a sheet's two columns paste as a tab). */
function parseBulk(raw: string, mode: BulkMode): Row[] | string {
  if (mode !== "pairs") {
    return raw.split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean)
      .map((v) => ({ serial: mode === "serial" ? v : "", imei: mode === "imei" ? v : "" }));
  }
  const out: Row[] = [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [n, line] of lines.entries()) {
    const parts = line.split(/[\t,;]+|\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2) {
      return `Line ${n + 1} of your list ("${line}") should be a serial and its IMEI — found ${parts.length} value${parts.length === 1 ? "" : "s"}.`;
    }
    out.push({ serial: parts[0], imei: parts[1] });
  }
  return out;
}

function imeiWarning(value: string): string | null {
  if (!value) return null;
  if (!IMEI_RE.test(value)) return "An IMEI is 15 digits — check the label";
  if (!luhnOk(value)) return "Check digit does not match — re-scan this IMEI";
  return null;
}

export function UnitCodesModal({
  isOpen, onClose, onSave, readOnly = false, itemName, itemCode, uom, trackSerial,
  trackImei, groups, focusIndex, warranty,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (updates: UnitCodeSave[]) => void;
  readOnly?: boolean;
  itemName: string;
  itemCode?: string | null;
  uom?: string | null;
  trackSerial: boolean;
  trackImei: boolean;
  groups: UnitCodeGroup[];
  /** The line the popup was opened from — its group is the one shown first. */
  focusIndex: number;
  /** Warranty per batch or per piece, captured with the codes (2026-11-21). */
  warranty?: UnitWarrantyOptions;
}) {
  const kinds: Kind[] = [...(trackSerial ? ["serial" as const] : []),
                         ...(trackImei ? ["imei" as const] : [])];
  const both = trackSerial && trackImei;

  const [rows, setRows] = useState<Row[][]>([]);
  const [active, setActive] = useState(0);
  const [scan, setScan] = useState("");
  const [scanNote, setScanNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  // The bulk list, as on the GRN's serial popup: paste hundreds, press once.
  const defaultMode: BulkMode = both ? "pairs" : trackImei ? "imei" : "serial";
  const [bulkOpen, setBulkOpen] = useState(true);
  const [bulkText, setBulkText] = useState("");
  const [bulkMode, setBulkMode] = useState<BulkMode>(defaultMode);

  // ---- warranty (2026-11-21) ----------------------------------------------------
  // Per GROUP (line): how the warranty is given (undefined = not chosen yet), the
  // batch's entry, and one entry per ROW — an entry follows its row, so re-scanning a
  // code keeps the dates typed beside it.
  const wOn = !!warranty;
  const wEdit = !!warranty?.editable;
  const [wMode, setWMode] = useState<(WarrantyMode | undefined)[]>([]);
  const [wBatch, setWBatch] = useState<WarrantyEntry[]>([]);
  const [wRows, setWRows] = useState<WarrantyEntry[][]>([]);
  const [fill, setFill] = useState<WarrantyEntry>(emptyEntry());
  const [report, setReport] = useState<{ tone: "ok" | "bad" | "warn"; title: string; lines: string[] } | null>(null);
  const [switching, setSwitching] = useState<{ group: number; to: WarrantyMode } | null>(null);
  const [persisting, setPersisting] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const cardInput = useRef<HTMLInputElement>(null);
  const cardTarget = useRef<{ group: number; row: number | "batch" } | null>(null);

  // A fresh copy every time it opens: Cancel must leave the line exactly as it was.
  useEffect(() => {
    if (!isOpen) return;
    setRows(groups.map((g) => {
      const length = Math.max(Math.floor(g.qty), g.serials.length, g.imeis.length);
      return Array.from({ length }, (_, i) => ({
        serial: g.serials[i] ?? "", imei: g.imeis[i] ?? "",
      }));
    }));
    setActive(Math.max(0, groups.findIndex((g) => g.index === focusIndex)));
    setScan("");
    setScanNote(null);
    setBulkText("");
    setBulkMode(defaultMode);
    // The paste box only while there are units left to code — open on a finished line
    // it is 200 px of nothing between the storekeeper and the rows (2026-11-21).
    setBulkOpen(groups.some((g) => Math.max(g.serials.length, g.imeis.length) < Math.floor(g.qty)));
    if (warranty) {
      const drafts = groups.map((g) => warranty.drafts[g.index]);
      // A line nobody has decided for yet opens on the question, not on "No warranty".
      setWMode(drafts.map((d) => d?.mode ?? (d?.dirty ? null : undefined)));
      setWBatch(drafts.map((d) => ({ ...(d?.batch ?? emptyEntry()) })));
      setWRows(groups.map((g, gi) => {
        const length = Math.max(Math.floor(g.qty), g.serials.length, g.imeis.length);
        return Array.from({ length }, (_, i) => {
          const code = (g.serials[i] || g.imeis[i] || "").trim();
          return { ...(drafts[gi]?.units[code] ?? emptyEntry()) };
        });
      }));
      setFill(emptyEntry());
      setReport(null);
      setSwitching(null);
      setPersistError(null);
    }
    setTimeout(() => scanRef.current?.focus(), 150);
  }, [isOpen]);

  /** Where each code sits, per kind, across every group — for the duplicate check. */
  const seen = useMemo(() => {
    const out: Record<Kind, Map<string, Cell[]>> = { serial: new Map(), imei: new Map() };
    rows.forEach((groupRows, group) => groupRows.forEach((r, row) => {
      for (const kind of kinds) {
        const v = r[kind].trim().toLowerCase();
        if (!v) continue;
        out[kind].set(v, [...(out[kind].get(v) ?? []), { group, row, kind }]);
      }
    }));
    return out;
  }, [rows]);

  const where = (cell: Pick<Cell, "group" | "row">) =>
    `${groups.length > 1 ? `line ${groups[cell.group].index + 1}, ` : ""}unit ${cell.row + 1}`;

  const duplicateOf = (group: number, row: number, kind: Kind): Cell | null => {
    const v = rows[group]?.[row]?.[kind].trim().toLowerCase();
    if (!v) return null;
    return (seen[kind].get(v) ?? []).find((c) => c.group !== group || c.row !== row) ?? null;
  };

  const rowDone = (r: Row) => kinds.every((k) => r[k].trim());
  const rowHalf = (r: Row) => both && !!r.serial.trim() !== !!r.imei.trim();

  const stats = useMemo(() => {
    let done = 0, units = 0, dupes = 0, half = 0, over = 0;
    rows.forEach((groupRows, g) => {
      const qty = Math.floor(groups[g]?.qty ?? 0);
      units += qty;
      groupRows.forEach((r, i) => {
        if (rowDone(r)) { if (i < qty) done += 1; else over += 1; }
        if (rowHalf(r)) half += 1;
      });
    });
    for (const kind of kinds) for (const cells of seen[kind].values()) {
      if (cells.length > 1) dupes += cells.length;
    }
    return { done, units, dupes, half, over };
  }, [rows, seen]);

  // Folded away the moment the last unit gets its code: the rows (and their warranty
  // columns) are what is left to look at.
  const allCoded = stats.units > 0 && stats.done >= stats.units;
  useEffect(() => { if (isOpen && allCoded) setBulkOpen(false); }, [allCoded, isOpen]);

  const groupDone = (g: number) =>
    (rows[g] ?? []).slice(0, Math.floor(groups[g]?.qty ?? 0)).filter(rowDone).length;

  /** The next empty cell, in reading order: this group first, then the ones after it. */
  const nextEmpty = (): Cell | null => {
    for (let step = 0; step < groups.length; step += 1) {
      const group = (active + step) % groups.length;
      const qty = Math.floor(groups[group].qty);
      for (let row = 0; row < qty; row += 1) {
        for (const kind of kinds) {
          if (!rows[group]?.[row]?.[kind].trim()) return { group, row, kind };
        }
      }
    }
    return null;
  };
  const target = rows.length ? nextEmpty() : null;

  const setCell = (group: number, row: number, kind: Kind, value: string) =>
    setRows((current) => current.map((groupRows, g) => g !== group ? groupRows
      : groupRows.map((r, i) => (i === row ? { ...r, [kind]: value } : r))));

  /** A scanner gun fires a code and an Enter; each lands in the next empty cell. */
  const takeScan = () => {
    const value = scan.trim();
    if (!value) return;
    if (!target) {
      setScanNote({ tone: "bad", text: `Every unit already has its code — ${value} was not used.` });
      setScan("");
      return;
    }
    const clash = (seen[target.kind].get(value.toLowerCase()) ?? [])[0];
    if (clash) {
      setScanNote({ tone: "bad", text: `${value} is already scanned (${where(clash)}). Scan the next unit.` });
      setScan("");
      return;
    }
    setCell(target.group, target.row, target.kind, value);
    if (target.group !== active) setActive(target.group);
    const warn = target.kind === "imei" ? imeiWarning(value) : null;
    setScanNote(warn
      ? { tone: "bad", text: `${value} — ${warn}.` }
      : { tone: "ok", text: `${value} → ${where(target)} · ${target.kind === "imei" ? "IMEI" : "serial"}` });
    setScan("");
  };

  /**
   * A whole list at once — the GRN popup's "Paste numbers", here (2026-10-21). The
   * codes fill the EMPTY cells in unit order, this line first and then the item's
   * other lines, so a list of 450 lands across both batches without anyone choosing
   * where each one goes. Refused WHOLE, never half-applied, when it repeats a code,
   * clashes with one already captured, or is longer than the units left to code:
   * a half-applied paste leaves the storekeeper working out which part went in.
   */
  const fillMany = (raw: string, mode: BulkMode): boolean => {
    const items = parseBulk(raw, mode);
    if (typeof items === "string") { setScanNote({ tone: "bad", text: items }); return false; }
    if (!items.length) return false;
    const kindsIn: Kind[] = mode === "pairs" ? ["serial", "imei"] : [mode];

    for (const kind of kindsIn) {
      const inList = new Set<string>();
      for (const item of items) {
        const v = item[kind].toLowerCase();
        if (inList.has(v)) {
          setScanNote({ tone: "bad", text: `${item[kind]} is in your list twice. Remove the extra one and paste again.` });
          return false;
        }
        inList.add(v);
        const clash = (seen[kind].get(v) ?? [])[0];
        if (clash) {
          setScanNote({ tone: "bad", text: `${item[kind]} is already captured (${where(clash)}). Remove it from your list and paste again.` });
          return false;
        }
      }
    }

    // The empty slots, in the order a scanner would fill them.
    const slots: { group: number; row: number }[] = [];
    for (let step = 0; step < groups.length; step += 1) {
      const group = (active + step) % groups.length;
      const qty = Math.floor(groups[group].qty);
      for (let row = 0; row < qty; row += 1) {
        const r = rows[group]?.[row] ?? { serial: "", imei: "" };
        if (kindsIn.every((k) => !r[k].trim())) slots.push({ group, row });
      }
    }
    if (items.length > slots.length) {
      setScanNote({ tone: "bad", text: slots.length
        ? `Only ${slots.length} unit${slots.length === 1 ? "" : "s"} still need${slots.length === 1 ? "s" : ""} ${bulkNoun(mode)}, but your list has ${items.length}. Remove the extra ones and paste again.`
        : `Every unit already has its ${bulkNoun(mode)}.` });
      return false;
    }

    const fill = new Map<string, Partial<Row>>();
    items.forEach((item, i) => {
      const { group, row } = slots[i];
      fill.set(`${group}-${row}`, Object.fromEntries(kindsIn.map((k) => [k, item[k]])));
    });
    setRows((current) => current.map((groupRows, g) => groupRows.map((r, i) => {
      const patch = fill.get(`${g}-${i}`);
      return patch ? { ...r, ...patch } : r;
    })));
    const first = slots[0], last = slots[items.length - 1];
    const span = first.group === last.group
      ? `${where(first)}${items.length > 1 ? `–${last.row + 1}` : ""}`
      : `${where(first)} to ${where(last)}`;
    const badImeis = kindsIn.includes("imei")
      ? items.filter((item) => imeiWarning(item.imei)).length : 0;
    setScanNote(badImeis
      ? { tone: "bad", text: `Added ${items.length} — ${badImeis} IMEI${badImeis === 1 ? " looks" : "s look"} wrong; check the amber cells.` }
      : { tone: "ok", text: `Added ${items.length} ${bulkNoun(mode)} — ${span}.` });
    if (first.group !== active) setActive(first.group);
    return true;
  };

  /** A column copied out of a sheet, or two columns (serial ⇥ IMEI), pasted at once. */
  const pasteInto = (group: number, row: number, kind: Kind, text: string): boolean => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2 && !text.includes("\t")) return false;
    setRows((current) => current.map((groupRows, g) => {
      if (g !== group) return groupRows;
      const next = [...groupRows];
      lines.forEach((line, offset) => {
        const at = row + offset;
        while (next.length <= at) next.push({ serial: "", imei: "" });
        const parts = line.split("\t").map((p) => p.trim());
        if (both && parts.length > 1 && kind === "serial") {
          next[at] = { serial: parts[0], imei: parts[1] };
        } else {
          next[at] = { ...next[at], [kind]: parts[0] };
        }
      });
      return next;
    }));
    setScanNote({ tone: "ok", text: `Pasted ${lines.length} code${lines.length === 1 ? "" : "s"} from unit ${row + 1} down.` });
    return true;
  };

  /** Enter in a cell moves down the column, as it does in a sheet. */
  const focusCell = (group: number, row: number, kind: Kind) => {
    tableRef.current
      ?.querySelector<HTMLInputElement>(`input[data-cell="${group}-${row}-${kind}"]`)
      ?.focus();
  };

  const clearGroup = () => setRows((current) => current.map((groupRows, g) =>
    g !== active ? groupRows : groupRows.map(() => ({ serial: "", imei: "" }))));

  // ---- warranty helpers --------------------------------------------------------
  const codeOf = (r?: Row) => ((r?.serial || r?.imei || "") as string).trim();
  const entryAt = (group: number, row: number) => wRows[group]?.[row] ?? emptyEntry();
  const setEntry = (group: number, row: number, patch: Partial<WarrantyEntry>) =>
    setWRows((cur) => cur.map((list, g) => {
      if (g !== group) return list;
      const next = [...list];
      while (next.length <= row) next.push(emptyEntry());
      next[row] = { ...next[row], ...patch };
      return next;
    }));
  const setBatch = (group: number, patch: Partial<WarrantyEntry>) =>
    setWBatch((cur) => cur.map((e, g) => (g === group ? { ...e, ...patch } : e)));
  const ownCount = (group: number) =>
    (rows[group] ?? []).filter((r, i) => codeOf(r) && hasDates(entryAt(group, i))).length;
  const chooseMode = (group: number, to: WarrantyMode, confirmed = false) => {
    if (!confirmed && wMode[group] === "UNIT" && to !== "UNIT" && ownCount(group) > 0) {
      setSwitching({ group, to });
      return;
    }
    setSwitching(null);
    if (to !== "UNIT" && wMode[group] === "UNIT") {
      setWRows((cur) => cur.map((list, g) => (g === group ? list.map(() => emptyEntry()) : list)));
    }
    setWMode((cur) => { const next = [...cur]; next[group] = to; return next; });
  };
  /** How many units of a group are covered right now. */
  const wCovered = (group: number) => {
    const units = (rows[group] ?? []).slice(0, Math.floor(groups[group]?.qty ?? 0)).filter((r) => codeOf(r));
    if (wMode[group] === "BATCH") return hasDates(wBatch[group]) ? units.length : 0;
    if (wMode[group] === "UNIT") {
      return (rows[group] ?? []).filter((r, i) => i < Math.floor(groups[group]?.qty ?? 0) && codeOf(r)
        && hasDates(entryAt(group, i))).length;
    }
    return 0;
  };
  const wStats = useMemo(() => {
    let cov = 0, problems = 0;
    groups.forEach((_, g) => {
      cov += wCovered(g);
      if (wMode[g] === "BATCH" && entryProblem(wBatch[g])) problems += 1;
      if (wMode[g] === "UNIT") {
        (rows[g] ?? []).forEach((r, i) => { if (codeOf(r) && entryProblem(entryAt(g, i))) problems += 1; });
      }
    });
    return { covered: cov, problems };
  }, [rows, wRows, wMode, wBatch]);

  const pickCard = (group: number, row: number | "batch") => {
    cardTarget.current = { group, row };
    cardInput.current?.click();
  };
  const onCardPicked = (file: File | null) => {
    const t = cardTarget.current;
    if (!file || !t) return;
    const patch = { file, attachmentId: null, documentName: null, fileHint: null };
    if (t.row === "batch") setBatch(t.group, patch); else setEntry(t.group, t.row, patch);
  };
  const emptyDateRows = (group: number) =>
    (rows[group] ?? []).filter((_r, i) => i < Math.floor(groups[group]?.qty ?? 0)
      && !hasDates(entryAt(group, i))).length;
  const applyFill = (group: number) => {
    const qtyG = Math.floor(groups[group]?.qty ?? 0);
    let n = 0;
    setWRows((cur) => cur.map((list, g) => {
      if (g !== group) return list;
      const next = Array.from({ length: Math.max(list.length, qtyG) }, (_, i) => list[i] ?? emptyEntry());
      return next.map((e, i) => {
        if (i >= qtyG || hasDates(e)) return e;
        n += 1;
        return { ...e, start: fill.start, end: fill.end };
      });
    }));
    setReport({ tone: "ok", title: `Dates given to ${emptyDateRows(group)} unit${emptyDateRows(group) === 1 ? "" : "s"}. Add each one's card in its row, or all at once with "Card files".`, lines: [] });
    void n;
  };

  /** The sheet, checked whole; applied only when nothing is wrong with it. */
  const importSheet = async (group: number, file: File) => {
    const g = groups[group];
    const qtyG = Math.floor(g?.qty ?? 0);
    let raw: Record<string, unknown>[];
    try { raw = await readSheet(file); }
    catch { setReport({ tone: "bad", title: `${file.name} could not be read — save it as .xlsx and try again.`, lines: [] }); return; }
    const takenElsewhere = new Set<string>();
    rows.forEach((list, gi) => { if (gi !== group) list.forEach((r) => {
      if (r.serial.trim()) takenElsewhere.add(r.serial.trim().toLowerCase());
      if (r.imei.trim()) takenElsewhere.add(r.imei.trim().toLowerCase());
    }); });
    const out = checkSheet(raw, { qty: qtyG, trackSerial, trackImei, takenElsewhere });
    // Codes fixed (a submitted GRN): the sheet may only describe the units already here.
    if (readOnly) {
      const here = new Set((rows[group] ?? []).map((r) => codeOf(r).toLowerCase()).filter(Boolean));
      out.rows.forEach((r, i) => {
        const code = (r.serial || r.imei).trim();
        if (code && !here.has(code.toLowerCase())) out.problems.push(`Row ${i + 2}: ${code} is not one of this line's units.`);
      });
    }
    if (out.problems.length) {
      setReport({ tone: "bad", title: `Nothing was applied — ${out.problems.length} thing${out.problems.length === 1 ? "" : "s"} to fix in ${file.name}:`, lines: out.problems });
      return;
    }
    if (readOnly) {
      const byCode = new Map(out.rows.map((r) => [(r.serial || r.imei).trim().toLowerCase(), r.entry]));
      setWRows((cur) => cur.map((list, gi) => gi !== group ? list
        : (rows[group] ?? []).map((r, i) => ({ ...(list[i] ?? emptyEntry()), ...(byCode.get(codeOf(r).toLowerCase()) ?? {}) }))));
    } else {
      setRows((cur) => cur.map((list, gi) => gi !== group ? list
        : out.rows.map((r) => ({ serial: trackSerial ? r.serial : "", imei: trackImei ? r.imei : "" }))));
      setWRows((cur) => cur.map((list, gi) => gi !== group ? list : out.rows.map((r) => ({ ...r.entry }))));
    }
    setWMode((cur) => { const next = [...cur]; next[group] = "UNIT"; return next; });
    const withDates = out.rows.filter((r) => hasDates(r.entry)).length;
    const named = out.rows.filter((r) => r.entry.fileHint).length;
    setReport({
      tone: out.warnings.length ? "warn" : "ok",
      title: `${out.rows.length} units read from ${file.name} · ${withDates} with a warranty`
        + (named ? ` · ${named} card file${named === 1 ? "" : "s"} named — attach them with "Card files"` : ""),
      lines: out.warnings,
    });
  };

  /** Many cards at once, matched to their units by the sheet's file names or the codes. */
  const importCards = (group: number, files: File[]) => {
    if (wMode[group] === "BATCH") {
      setBatch(group, { file: files[0], attachmentId: null, documentName: null });
      setReport({ tone: files.length > 1 ? "warn" : "ok",
        title: `${files[0].name} is the batch's card.${files.length > 1 ? ` The other ${files.length - 1} file(s) were not used — a batch has one card.` : ""}`, lines: [] });
      return;
    }
    const list = rows[group] ?? [];
    const codes = list.map(codeOf).filter(Boolean);
    const hints: Record<string, string | null | undefined> = {};
    list.forEach((r, i) => { const c = codeOf(r); if (c) hints[c] = entryAt(group, i).fileHint; });
    const { matched, unmatched } = matchCards(files, codes, hints);
    setWRows((cur) => cur.map((entries, gi) => gi !== group ? entries
      : list.map((r, i) => {
        const f = matched.get(codeOf(r));
        const e = entries[i] ?? emptyEntry();
        return f ? { ...e, file: f, attachmentId: null, documentName: null, fileHint: null } : e;
      })));
    if (wMode[group] !== "UNIT") setWMode((cur) => { const next = [...cur]; next[group] = "UNIT"; return next; });
    setReport({
      tone: unmatched.length ? "warn" : "ok",
      title: `${matched.size} of ${files.length} card file${files.length === 1 ? "" : "s"} matched to their units.`,
      lines: unmatched.map((f) => `${f.name} — no unit matches it. Name it after the serial (e.g. ${codes[0] ?? "SN0001"}.pdf) or list it in the sheet's "Card file name" column.`),
    });
  };

  const blocked = stats.dupes > 0 || stats.half > 0 || stats.over > 0;
  const wBlocked = wOn && wEdit && wStats.problems > 0;
  const blockReason = wBlocked
    ? `${wStats.problems} warranty ${wStats.problems === 1 ? "entry needs" : "entries need"} fixing — both dates, and never ending before starting.`
    : stats.dupes > 0
    ? "Two units cannot share one code — fix the red cells."
    : stats.half > 0
      ? "Each handset needs both its serial and its IMEI, or neither — fill or clear the amber rows."
      : stats.over > 0
        ? "There are more codes than units received — remove the extra rows."
        : null;

  const updates = (): UnitCodeSave[] => groups.map((g, gi) => {
    const kept = (rows[gi] ?? []).filter((r) => r.serial.trim() || r.imei.trim());
    const out: UnitCodeSave = {
      index: g.index,
      serial_numbers: trackSerial ? kept.map((r) => r.serial.trim()).filter(Boolean) : null,
      imei_numbers: trackImei ? kept.map((r) => r.imei.trim()).filter(Boolean) : null,
    };
    if (wOn && wEdit) {
      const units: Record<string, WarrantyEntry> = {};
      (rows[gi] ?? []).forEach((r, i) => {
        const code = codeOf(r);
        const e = entryAt(gi, i);
        if (code && !isBlank(e)) units[code] = e;
      });
      out.warranty = {
        mode: wMode[gi] ?? null,
        batch: wBatch[gi] ?? emptyEntry(),
        units: wMode[gi] === "UNIT" ? units : {},
        dirty: true,
      };
    }
    return out;
  });

  const save = async () => {
    const next = updates();
    if (warranty?.persist) {
      setPersisting(true); setPersistError(null);
      try { await warranty.persist(next); }
      catch (e) {
        setPersistError((e as { message?: string })?.message ?? "The warranty could not be saved.");
        setPersisting(false);
        return;
      }
      setPersisting(false);
    } else {
      onSave(next);
    }
    onClose();
  };

  const noun = both ? "serial & IMEI" : trackImei ? "IMEI" : "serial";
  const g = groups[active];
  const groupRows = rows[active] ?? [];
  const qty = Math.floor(g?.qty ?? 0);
  const unitMode = wOn && wMode[active] === "UNIT";
  const gridCols = [
    "3.5rem",
    ...(trackSerial ? ["minmax(9rem,1fr)"] : []),
    ...(trackImei ? ["minmax(9rem,1fr)"] : []),
    ...(unitMode ? ["9rem", "9rem", "minmax(6.5rem,0.7fr)", "minmax(7rem,0.8fr)"] : []),
    "2.5rem",
  ].join(" ");
  const pct = stats.units ? Math.round((stats.done / stats.units) * 100) : 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size={wOn ? "5xl" : "4xl"}
      backdrop="blur"
      scrollBehavior="inside"
      classNames={{
        base: `rounded-3xl border border-line/80 shadow-2xl bg-content1 overflow-hidden ${
          unitMode ? "!max-w-[min(1320px,96vw)]" : ""}`,
        backdrop: "bg-black/50 backdrop-blur-sm",
      }}
    >
      <ModalContent>
        <div className="h-1.5 w-full bg-gradient-to-r from-brand via-violet-500 to-indigo-600" />
        <ModalHeader className="flex flex-col gap-3 border-b border-line/60 px-6 pb-4 pt-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-brand-050 text-brand ring-1 ring-brand/20">
                {trackImei && !trackSerial ? <Smartphone className="h-5 w-5" /> : <ScanLine className="h-5 w-5" />}
              </div>
              <div className="min-w-0 space-y-0.5">
                <h3 className="text-base font-bold text-ink">
                  {readOnly ? `Unit ${noun}s` : `Scan a ${noun} for every unit`}
                  {wOn && <span className="font-semibold text-muted"> & {readOnly ? "their" : "its"} warranty</span>}
                </h3>
                <p className="truncate text-xs font-normal text-muted">
                  <span className="font-semibold text-ink">{itemName}</span>
                  {itemCode ? ` · ${itemCode}` : ""}
                  {groups.length > 1 ? ` · ${groups.length} lines` : ""}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-5 text-right">
              <div>
                <div className={`text-lg font-bold tabular ${stats.done === stats.units && stats.units > 0 ? "text-ok" : "text-ink"}`}>
                  {stats.done}<span className="text-sm font-semibold text-muted"> / {stats.units}</span>
                </div>
                <div className="text-[11px] font-medium text-muted">units coded</div>
              </div>
              {wOn && (
                <div>
                  <div className={`text-lg font-bold tabular ${wStats.covered === stats.units && stats.units > 0 ? "text-ok" : wStats.covered ? "text-warn" : "text-muted"}`}>
                    {wStats.covered}<span className="text-sm font-semibold text-muted"> / {stats.units}</span>
                  </div>
                  <div className="text-[11px] font-medium text-muted">with warranty</div>
                </div>
              )}
            </div>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-content2">
            <div className={`h-full rounded-full transition-all duration-300 ${pct === 100 ? "bg-ok" : "bg-brand"}`}
                 style={{ width: `${pct}%` }} />
          </div>

          {/* The scanner bar — where the gun's keystrokes go. */}
          {!readOnly && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 rounded-2xl border-2 border-brand/30 bg-brand-050/40 px-3 py-1.5 focus-within:border-brand">
                <ScanLine className="h-5 w-5 shrink-0 text-brand" aria-hidden />
                <input
                  ref={scanRef}
                  value={scan}
                  onChange={(e) => setScan(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); takeScan(); } }}
                  onPaste={(e) => {
                    // A list pasted into the scan box fills the units in one go, as the
                    // GRN's popup does; two columns per line are read as pairs.
                    const text = e.clipboardData.getData("text");
                    const mode: BulkMode = both && text.includes(TAB) ? "pairs"
                      : target?.kind ?? defaultMode;
                    const parsed = parseBulk(text, mode);
                    if (typeof parsed === "string" || parsed.length > 1) {
                      e.preventDefault();
                      fillMany(text, mode);
                    }
                  }}
                  placeholder={target
                    ? `Scan or type, then Enter — goes to ${where(target)} · ${target.kind === "imei" ? "IMEI" : "serial"}`
                    : "Every unit has its code"}
                  aria-label="Scan a code"
                  disabled={!target}
                  className="h-10 min-w-0 flex-1 bg-transparent font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-muted"
                />
                <button type="button" onClick={takeScan} disabled={!scan.trim() || !target}
                        className="inline-flex min-h-9 items-center gap-1 rounded-xl bg-brand px-3 text-xs font-bold text-white transition-all hover:bg-brand/90 disabled:opacity-40">
                  <Check className="h-4 w-4" /> Add
                </button>
              </div>
              {scanNote && (
                <p className={`flex items-center gap-1.5 text-xs font-medium ${scanNote.tone === "ok" ? "text-ok" : "text-bad"}`}
                   role="status">
                  {scanNote.tone === "ok" ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  {scanNote.text}
                </p>
              )}
              <BulkPanel
                open={bulkOpen}
                onToggle={() => setBulkOpen((v) => !v)}
                text={bulkText}
                onText={setBulkText}
                mode={bulkMode}
                onMode={setBulkMode}
                modes={both ? ["pairs", "serial", "imei"] : [defaultMode]}
                room={stats.units - stats.done}
                onAdd={() => { if (fillMany(bulkText, bulkMode)) setBulkText(""); }}
              />
            </div>
          )}
        </ModalHeader>

        <ModalBody className="space-y-3 px-6 py-4">
          {/* One tab per line of this item: same batch in two packings, or two batches. */}
          {groups.length > 1 && (
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Lines of this item">
              {groups.map((grp, i) => {
                const done = groupDone(i);
                const full = Math.floor(grp.qty);
                const on = i === active;
                return (
                  <button key={grp.index} type="button" role="tab" aria-selected={on}
                          onClick={() => setActive(i)}
                          className={`flex min-h-11 items-center gap-2.5 rounded-xl border px-3 py-1.5 text-left transition-all ${
                            on ? "border-brand bg-brand-050 shadow-sm ring-1 ring-brand/30"
                               : "border-line bg-content1 hover:border-brand/40"}`}>
                    <span className={`flex h-6 min-w-6 items-center justify-center rounded-lg px-1 text-[11px] font-bold ${
                      on ? "bg-brand text-white" : "bg-content2 text-ink-700"}`}>
                      {grp.index + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-ink">
                        Batch {grp.batchNo || "—"}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {grp.packLabel ? `${grp.packLabel} · ` : ""}
                        <span className={done === full && full > 0 ? "font-semibold text-ok" : ""}>
                          {done}/{full}
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {g && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 rounded-full bg-neutral-bg px-2 py-0.5 font-semibold text-ink-700 ring-1 ring-line">
                <Tag className="h-3 w-3" /> Line {g.index + 1} · Batch {g.batchNo || "not set"}
              </span>
              {g.packLabel && (
                <span className="inline-flex items-center gap-1 rounded-full bg-neutral-bg px-2 py-0.5 font-semibold text-ink-700 ring-1 ring-line">
                  <Layers className="h-3 w-3" /> {g.packLabel}
                </span>
              )}
              <span className="text-muted">{fmtQty(qty)} {uom ?? "units"} received</span>
              {!readOnly && (
                <span className="ml-auto inline-flex items-center gap-3">
                  <span className="hidden items-center gap-1 text-[11px] text-muted sm:inline-flex">
                    <ClipboardPaste className="h-3.5 w-3.5" />
                    {both ? "Paste two columns (serial ⇥ IMEI) from a sheet" : "Paste a column from a sheet"}
                  </span>
                  <button type="button" onClick={clearGroup}
                          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-bad hover:bg-bad-bg">
                    <Eraser className="h-3.5 w-3.5" /> Clear this line
                  </button>
                </span>
              )}
            </div>
          )}

          {/* Warranty (2026-11-21): how it is given, then given — batch or per piece. */}
          {wOn && g && qty > 0 && (
            <div className="space-y-2">
              <WarrantyModeChooser mode={wMode[active] ?? null} chosen={wMode[active] !== undefined}
                                   qty={qty} disabled={!wEdit} onChoose={(m) => chooseMode(active, m)} />
              {switching && switching.group === active && (
                <SwitchConfirm count={ownCount(active)} to={switching.to}
                               onYes={() => chooseMode(active, switching.to, true)}
                               onNo={() => setSwitching(null)} />
              )}
              {wMode[active] === "BATCH" && (
                <BatchWarrantyForm entry={wBatch[active] ?? emptyEntry()} qty={qty} disabled={!wEdit}
                                   onChange={(patch) => setBatch(active, patch)}
                                   onPickCard={() => pickCard(active, "batch")} />
              )}
              {wMode[active] === "UNIT" && wEdit && (
                <>
                  <FillEmptyBar draft={fill} empty={emptyDateRows(active)}
                                onDraft={(patch) => setFill((f) => ({ ...f, ...patch }))}
                                onApply={() => applyFill(active)} />
                  <BulkWarrantyBar
                    sheetLabel={readOnly ? "Upload warranty sheet" : "Upload Excel"}
                    onTemplate={() => downloadTemplate(templateWorkbook({
                      rows: groupRows.map((r, i) => ({ ...r, entry: entryAt(active, i) })),
                      qty, trackSerial, trackImei, itemName, batchNo: g.batchNo,
                    }), `${(itemCode || itemName).replace(/[^\w.-]+/g, "_")}-${g.batchNo || `line${g.index + 1}`}-warranty.xlsx`)}
                    onSheet={(file) => void importSheet(active, file)}
                    onCards={(files) => importCards(active, files)} />
                </>
              )}
              {report && <ImportReport {...report} onClose={() => setReport(null)} />}
            </div>
          )}

          {g && qty === 0 && groupRows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
              Enter the received quantity on line {g.index + 1} first — one row is drawn per unit.
            </div>
          ) : g && (
            <div ref={tableRef} className="overflow-hidden rounded-2xl border border-line/80">
              <div style={{ gridTemplateColumns: gridCols }} className="grid border-b border-line bg-content2/60 text-[11px] font-bold uppercase tracking-wider text-muted">
                <div className="px-3 py-2">Unit</div>
                {trackSerial && <div className="px-3 py-2">Serial number</div>}
                {trackImei && <div className="px-3 py-2">IMEI <span className="font-medium normal-case tracking-normal">(15 digits)</span></div>}
                {unitMode && (
                  <>
                    <div className="px-2 py-2">Warranty starts</div>
                    <div className="px-2 py-2">Ends</div>
                    <div className="px-2 py-2">Card no.</div>
                    <div className="px-2 py-2">Card</div>
                  </>
                )}
                <div />
              </div>
              <div className="max-h-[46vh] overflow-y-auto">
                {groupRows.map((r, row) => {
                  const extra = row >= qty;
                  const done = rowDone(r);
                  const half = rowHalf(r);
                  const wEntry = entryAt(active, row);
                  const wProblem = unitMode && !!codeOf(r) ? entryProblem(wEntry) : null;
                  const wHas = (unitMode && hasDates(wEntry)) || (wMode[active] === "BATCH" && hasDates(wBatch[active]));
                  return (
                    <div key={row} style={{ gridTemplateColumns: gridCols }}
                         className={`grid items-start border-b border-line/50 last:border-b-0 ${
                           extra || wProblem ? "bg-bad-bg/40" : half ? "bg-warn-bg/40" : done ? "bg-ok-bg/20" : ""}`}>
                      <div className="px-3 py-2.5 font-mono text-xs font-semibold tabular text-muted">
                        {row + 1}
                      </div>
                      {kinds.map((kind) => {
                        const dup = duplicateOf(active, row, kind);
                        const warn = kind === "imei" ? imeiWarning(r.imei.trim()) : null;
                        const empty = !r[kind].trim();
                        return (
                          <div key={kind} className="px-2 py-1.5">
                            <input
                              data-cell={`${active}-${row}-${kind}`}
                              value={r[kind]}
                              readOnly={readOnly}
                              aria-label={`${kind === "imei" ? "IMEI" : "Serial"}, unit ${row + 1}`}
                              inputMode={kind === "imei" ? "numeric" : undefined}
                              placeholder={readOnly ? "—" : kind === "imei" ? "IMEI" : "Serial no."}
                              onChange={(e) => setCell(active, row, kind, e.target.value)}
                              onPaste={(e) => {
                                if (readOnly) return;
                                if (pasteInto(active, row, kind, e.clipboardData.getData("text"))) e.preventDefault();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); focusCell(active, row + 1, kind); }
                              }}
                              className={`h-9 w-full rounded-lg border bg-content1 px-2.5 font-mono text-sm text-ink outline-none transition-colors focus:border-brand focus:ring-2 focus:ring-brand/20 ${
                                dup ? "border-bad ring-1 ring-bad/30"
                                  : warn ? "border-warn"
                                  : half && empty ? "border-warn border-dashed"
                                  : "border-line"}`}
                            />
                            {dup && (
                              <p className="mt-0.5 text-[11px] font-medium text-bad">Also on {where(dup)}</p>
                            )}
                            {!dup && warn && (
                              <p className="mt-0.5 text-[11px] font-medium text-warn">{warn}</p>
                            )}
                            {!dup && !warn && half && empty && (
                              <p className="mt-0.5 text-[11px] font-medium text-warn">
                                Needs its {kind === "imei" ? "IMEI" : "serial"} too
                              </p>
                            )}
                          </div>
                        );
                      })}
                      {unitMode && (
                        <RowWarrantyCells entry={wEntry} unit={row + 1} disabled={!wEdit}
                                          onChange={(patch) => setEntry(active, row, patch)}
                                          onPickCard={() => pickCard(active, row)} />
                      )}
                      <div className="flex flex-col items-center gap-1 py-2.5">
                        {extra
                          ? <span title="More codes than units received"><AlertTriangle className="h-4 w-4 text-bad" /></span>
                          : done ? <CheckCircle2 className="h-4 w-4 text-ok" /> : null}
                        {wOn && !extra && done && (
                          wProblem
                            ? <span title={wProblem}><ShieldAlert className="h-4 w-4 text-bad" /></span>
                            : wHas ? <span title="Has a warranty"><ShieldCheck className="h-4 w-4 text-ok" /></span> : null
                        )}
                      </div>
                      {wProblem && (
                        <p className="col-span-full -mt-1 px-3 pb-1.5 text-[11px] font-medium text-bad">Unit {row + 1} warranty: {wProblem}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </ModalBody>

        <ModalFooter className="flex flex-wrap items-center gap-3 border-t border-line/70 bg-content2/30 px-6 py-3.5">
          <div className="min-w-0 flex-1 text-xs">
            {blockReason ? (
              <span className="flex items-center gap-1.5 font-medium text-bad">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {blockReason}
              </span>
            ) : stats.done < stats.units ? (
              <span className="text-muted">
                {stats.units - stats.done} unit{stats.units - stats.done === 1 ? "" : "s"} still
                without a code. You can save and come back — the receipt itself needs every unit
                coded before it saves.
              </span>
            ) : stats.units > 0 ? (
              <span className="flex items-center gap-1.5 font-medium text-ok">
                <CheckCircle2 className="h-3.5 w-3.5" /> Every unit has its {noun}.
              </span>
            ) : null}
            {wOn && !blockReason && stats.units > 0 && (
              <span className={`mt-0.5 block ${wStats.covered === stats.units ? "text-ok" : "text-muted"}`}>
                {wStats.covered === stats.units
                  ? "Every unit has its warranty."
                  : `${stats.units - wStats.covered} unit${stats.units - wStats.covered === 1 ? "" : "s"} without a warranty — fine to save; add it whenever the card arrives.`}
                {warranty?.persist ? "" : " Cards upload when the GRN is saved."}
              </span>
            )}
            {persistError && (
              <span className="mt-0.5 flex items-center gap-1.5 font-medium text-bad">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {persistError}
              </span>
            )}
          </div>
          <button type="button" onClick={onClose}
                  className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-line bg-content1 px-3 text-xs font-semibold text-ink-700 transition-all hover:bg-content2">
            <X className="h-4 w-4" /> {readOnly && !(wOn && wEdit) ? "Close" : "Cancel"}
          </button>
          {(!readOnly || (wOn && wEdit)) && (
            <button type="button" onClick={() => void save()} disabled={blocked || wBlocked || persisting}
                    title={blockReason ?? undefined}
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-brand px-3.5 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50">
              <Check className="h-4 w-4" />
              {persisting ? "Saving warranty…"
                : readOnly ? `Save warranty · ${wStats.covered} of ${stats.units}`
                : wOn ? `Save ${stats.done} of ${stats.units} · warranty ${wStats.covered}`
                : `Save ${stats.done} of ${stats.units}`}
            </button>
          )}
          <input ref={cardInput} type="file" className="hidden" accept="application/pdf,image/*"
                 onChange={(e) => { onCardPicked(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** The paste box: a list of codes, what the list holds, and one press to fill. */
function BulkPanel({ open, onToggle, text, onText, mode, onMode, modes, room, onAdd }: {
  open: boolean;
  onToggle: () => void;
  text: string;
  onText: (value: string) => void;
  mode: BulkMode;
  onMode: (mode: BulkMode) => void;
  modes: BulkMode[];
  room: number;
  onAdd: () => void;
}) {
  const parsed = parseBulk(text, mode);
  const count = typeof parsed === "string" ? 0 : parsed.length;
  const over = count > room;
  const label: Record<BulkMode, string> = {
    pairs: "Serial + IMEI pairs", serial: "Serials only", imei: "IMEIs only",
  };
  const placeholder = mode === "pairs"
    ? "One unit per line — its serial, then its IMEI:\nSN0001    490154203237518\n"
      + "SN0002    356938035643809\n(two columns copied from Excel paste exactly like this)"
    : `Paste ${bulkNoun(mode)} — one per line, or separated by spaces or commas.\n`
      + "Copying a whole column out of Excel works.";

  return (
    <div className="rounded-2xl border border-line/80 bg-content2/40">
      <button type="button" onClick={onToggle} aria-expanded={open}
              className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-xs font-semibold text-ink-700">
        <ClipboardList className="h-4 w-4 text-brand" aria-hidden />
        Paste a list
        <span className="font-normal text-muted">— fill many units at once</span>
        <ChevronDown className={`ml-auto h-4 w-4 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-line/60 px-3 pb-3 pt-2.5">
          {modes.length > 1 && (
            <div className="inline-flex rounded-xl bg-content1 p-0.5 ring-1 ring-line" role="radiogroup"
                 aria-label="What the list holds">
              {modes.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m}
                        onClick={() => onMode(m)}
                        className={`min-h-8 rounded-lg px-3 text-[11px] font-semibold transition-all ${
                          mode === m ? "bg-brand text-white shadow-sm" : "text-ink-700 hover:bg-content2"}`}>
                  {label[m]}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value)}
            placeholder={placeholder}
            aria-label={`Bulk ${bulkNoun(mode)}`}
            rows={4}
            className="min-h-24 w-full resize-y rounded-xl border border-line bg-content1 px-3 py-2 font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-xs placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/20"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs ${typeof parsed === "string" || over ? "font-medium text-bad" : "text-muted"}`}>
              {typeof parsed === "string" ? parsed
                : !count ? `Room for ${room} more unit${room === 1 ? "" : "s"}.`
                : over ? `${count} in your list, but only ${room} unit${room === 1 ? "" : "s"} still need${room === 1 ? "s" : ""} a code.`
                : `${count} ${count === 1 ? "code" : bulkNoun(mode)} found · fills the next ${count} empty unit${count === 1 ? "" : "s"}.`}
            </span>
            <span className="ml-auto inline-flex items-center gap-2">
              {text && (
                <button type="button" onClick={() => onText("")}
                        className="min-h-8 rounded-lg px-2 text-[11px] font-semibold text-muted hover:bg-content2">
                  Clear
                </button>
              )}
              <button type="button" onClick={onAdd} disabled={!count || over}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-brand px-3.5 text-xs font-bold text-white shadow-sm transition-all hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-40">
                <ClipboardPaste className="h-4 w-4" /> Add {count || ""} pasted
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
