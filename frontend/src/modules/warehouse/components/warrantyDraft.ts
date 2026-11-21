import type { LineWarrantyIn, WarrantyLine } from "../types";

/**
 * A GRN line's warranty while it is being filled in (2026-11-21) — pure, so tested.
 *
 * A line gives its units a warranty ONE of two ways, chosen first:
 * - BATCH: one start, end, card no. and card for every unit of the line;
 * - UNIT: each unit its own — the rows of the Serial / IMEI popup grow four columns.
 * `null` is "no warranty stated" (the default; never a refusal — the card often comes
 * later). Units are keyed by their CODE (serial, else IMEI), the same key the server
 * stores them under, so an entry follows its unit wherever the row moves.
 *
 * A card is either already filed on the GRN (`attachmentId`) or picked in this browser
 * and not uploaded yet (`file`); `persist` uploads the second kind after the GRN is
 * saved and swaps them for ids.
 */
export type WarrantyMode = "BATCH" | "UNIT" | null;

export interface WarrantyEntry {
  start: string;       // YYYY-MM-DD, "" = none
  end: string;
  cardNo: string;
  attachmentId?: number | null;
  documentName?: string | null;
  file?: File | null;
  /** The card's file name as an Excel row named it, until the file is attached. */
  fileHint?: string | null;
}

export interface LineWarrantyDraft {
  mode: WarrantyMode;
  batch: WarrantyEntry;
  units: Record<string, WarrantyEntry>;
  /** Changed here and not yet saved to the server. */
  dirty?: boolean;
}

export const emptyEntry = (): WarrantyEntry => ({ start: "", end: "", cardNo: "" });
export const emptyDraft = (): LineWarrantyDraft => ({ mode: null, batch: emptyEntry(), units: {} });

/** Both dates given — what makes an entry a warranty. */
export const hasDates = (e?: WarrantyEntry | null) => !!e?.start && !!e?.end;
export const hasCard = (e?: WarrantyEntry | null) => !!e?.file || !!e?.attachmentId;
export const isBlank = (e?: WarrantyEntry | null) =>
  !e || (!e.start && !e.end && !e.cardNo.trim() && !hasCard(e));

/** What is wrong with an entry, in words — or null. A blank entry is fine (no warranty). */
export function entryProblem(e?: WarrantyEntry | null): string | null {
  if (!e || (!e.start && !e.end)) {
    return e && (e.cardNo.trim() || hasCard(e)) ? "Give the start and end date for this card." : null;
  }
  if (!e.start) return "Give the start date too.";
  if (!e.end) return "Give the end date too.";
  if (e.end < e.start) return "Ends before it starts.";
  return null;
}

/** `YYYY-MM-DD` plus whole years, less a day: a 1-year warranty from 21 Nov 2026 ends
 *  20 Nov 2027. 29 Feb lands on 28 Feb in a common year. */
export function plusYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  const target = new Date(Date.UTC(y + years, m - 1, Math.min(d, lastDay)));
  target.setUTCDate(target.getUTCDate() - 1);
  return target.toISOString().slice(0, 10);
}

export const todayIso = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/** The draft a saved line starts from. Only a unit's OWN warranty is a unit entry —
 *  one it merely inherits from the batch is the batch's. */
export function draftFromServer(line?: WarrantyLine | null): LineWarrantyDraft {
  if (!line) return emptyDraft();
  const toEntry = (w?: WarrantyLine["batch"]): WarrantyEntry => w
    ? { start: w.start_date, end: w.end_date, cardNo: w.card_no ?? "",
        attachmentId: w.attachment_id ?? null, documentName: w.document_name ?? null }
    : emptyEntry();
  const units: Record<string, WarrantyEntry> = {};
  for (const unit of line.units) {
    if (unit.source === "UNIT" && unit.warranty) units[unit.code] = toEntry(unit.warranty);
  }
  return { mode: line.mode ?? null, batch: toEntry(line.batch), units };
}

/** How many of `codes` the draft covers — every one in BATCH mode with dates, else
 *  those with their own dates. */
export function covered(draft: LineWarrantyDraft | undefined, codes: string[]): number {
  if (!draft || !draft.mode) return 0;
  if (draft.mode === "BATCH") return hasDates(draft.batch) ? codes.length : 0;
  return codes.filter((code) => hasDates(draft.units[code])).length;
}

/** Cards picked in this browser and not uploaded yet, each once. */
export function pendingFiles(draft: LineWarrantyDraft): File[] {
  const out = new Set<File>();
  if (draft.mode === "BATCH" && draft.batch.file) out.add(draft.batch.file);
  if (draft.mode === "UNIT") for (const e of Object.values(draft.units)) if (e.file) out.add(e.file);
  return [...out];
}

/** The save payload. `fileIds` maps each picked file to the id it was filed under;
 *  only units that are still on the line (`codes`) and have dates are sent. */
export function toPayload(draft: LineWarrantyDraft, codes: string[],
                          fileIds: Map<File, number> = new Map()): LineWarrantyIn {
  const card = (e: WarrantyEntry) => (e.file ? fileIds.get(e.file) ?? null : e.attachmentId ?? null);
  if (draft.mode === "BATCH") {
    return { mode: "BATCH", start_date: draft.batch.start || null, end_date: draft.batch.end || null,
             card_no: draft.batch.cardNo.trim() || null, attachment_id: card(draft.batch), units: [] };
  }
  if (draft.mode === "UNIT") {
    return {
      mode: "UNIT",
      units: codes.filter((code) => hasDates(draft.units[code])).map((code) => {
        const e = draft.units[code];
        return { code, start_date: e.start, end_date: e.end,
                 card_no: e.cardNo.trim() || null, attachment_id: card(e) };
      }),
    };
  }
  return { mode: null, units: [] };
}

/** The units' codes of a line: the serial, else the IMEI — the server's key. */
export function unitCodes(serials: string[] | null | undefined, imeis: string[] | null | undefined): string[] {
  const s = serials ?? [], i = imeis ?? [];
  const out: string[] = [];
  for (let n = 0; n < Math.max(s.length, i.length); n += 1) {
    const code = (s[n] || i[n] || "").trim();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

/** Which picked card file belongs to which unit: the file an Excel row named, else
 *  one whose name IS the unit's code ("SN0001.pdf"), else one whose name contains it. */
export function matchCards(files: File[], codes: string[], hints: Record<string, string | null | undefined>):
  { matched: Map<string, File>; unmatched: File[] } {
  const stem = (name: string) => name.replace(/\.[^.]+$/, "").trim().toLowerCase();
  const matched = new Map<string, File>();
  const left = [...files];
  const take = (code: string, pick: (f: File) => boolean) => {
    if (matched.has(code)) return;
    const at = left.findIndex(pick);
    if (at >= 0) { matched.set(code, left[at]); left.splice(at, 1); }
  };
  for (const code of codes) {
    const hint = (hints[code] ?? "").trim().toLowerCase();
    if (hint) take(code, (f) => f.name.toLowerCase() === hint || stem(f.name) === stem(hint));
  }
  for (const code of codes) take(code, (f) => stem(f.name) === code.toLowerCase());
  // Longest codes first, so "SN-1" never claims "SN-12.pdf".
  for (const code of [...codes].sort((a, b) => b.length - a.length)) {
    take(code, (f) => stem(f.name).includes(code.toLowerCase()));
  }
  return { matched, unmatched: left };
}
