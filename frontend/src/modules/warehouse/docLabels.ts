import type { DocLabelRow } from "./types";

/**
 * Label printing for a posted issue or an acknowledged receipt (2026-10-28), as plain
 * functions: the size presets (thermal roll AND A4 sheet — the floor uses both), the
 * A4 grid arithmetic, which stickers a choice selects, and the per-user settings kept
 * in the browser (decided 2026-10-28: no database table for presets).
 */

export type CodeKind = "BOTH" | "BARCODE" | "QR";
export type BarFormat = "CODE128" | "CODE39";
export type Layout = "ROLL" | "SHEET";
export type FontSize = "S" | "M" | "L";
export type PackScope = "ALL" | "TOP" | "NEW" | "NONE";
/** What a sticker's QR carries (2026-11-02): the details themselves as text — any
 *  phone camera shows them on scan, no login, no network — or the live-details link. */
export type QrContent = "DETAILS" | "LINK";

/** The QR text: the code, then one "Label: value" line per known fact. Empty values
 *  are dropped so a scan never reads "Batch: —". Kept plain (no markup) because every
 *  scanner app shows text as-is. */
export function qrDetailsText(code: string, facts: [string, string | number | null | undefined][]): string {
  const lines = [code];
  for (const [label, value] of facts) {
    const v = value == null ? "" : String(value).trim();
    if (v && v !== code) lines.push(`${label}: ${v}`);
  }
  return lines.join("\n");
}

/** The live-details page a `qr_token` opens (`/c/<token>`). */
export const qrLink = (token: string) => `${window.location.origin}/c/${encodeURIComponent(token)}`;

/** Every fact a document label knows, for the QR (independent of which fields the
 *  sticker prints — the scan is where the rest of the detail lives). */
export function docLabelFacts(r: DocLabelRow, doc?: {
  document_type?: string; document_no?: string | null; to_name?: string | null; document_date?: string | null;
} | null): [string, string | number | null | undefined][] {
  const combo = [r.brand_name, r.variant_name, r.model_name].filter(Boolean).join(" / ");
  const qty = r.kind === "UNIT" ? null
    : `${r.qty}${r.part ? ` of ${r.pack_size}` : ""} ${r.uom_code ?? ""}`.trim();
  return [
    ["Type", r.kind === "UNIT" ? r.pack_name : r.pack_name ? `${r.pack_name}${qty ? ` (${qty})` : ""}` : qty],
    ["Item", [r.item_code, r.item_name].filter(Boolean).join(" - ")],
    ["Serial", r.serial_number],
    ["IMEI", r.imei],
    ["Brand", combo],
    ["Batch", r.batch_no],
    ["Expiry", r.expiry_date],
    ["Holds", r.packs_inside],
    ["Inside", (r.path ?? []).map((p) => `${p.name ?? "Pack"} ${p.code}`).join(" > ")],
    [doc?.document_type === "RECEIPT" ? "Received on" : "Issue", doc?.document_no],
    ["To", doc?.to_name],
    ["Date", doc?.document_date],
  ];
}

export const FIELDS = [
  ["item_name", "Item name"],
  ["item_code", "Item code"],
  ["pack", "Pack and quantity"],
  ["batch", "Batch"],
  ["expiry", "Expiry"],
  ["combo", "Brand / variant / model"],
  ["path", "Path (carton › box)"],
  ["parent", "Inside (parent pack)"],
  ["inside", "Packs inside"],
  ["doc", "Document no."],
  ["to", "Destination"],
  ["date", "Date"],
] as const;
export type FieldKey = (typeof FIELDS)[number][0];

export interface LabelSettings {
  sizeId: string;
  w: number;
  h: number;
  layout: Layout;
  code: CodeKind;
  barFormat: BarFormat;
  font: FontSize;
  copies: number;
  margin: number;
  gap: number;
  fields: Record<FieldKey, boolean>;
  /** Print the carton (and an opened box) as a parent label on top (2026-10-28). */
  parents: boolean;
  /** What the QR carries — the details as text (default) or the live link. */
  qr: QrContent;
}

export interface SizePreset { id: string; label: string; w: number; h: number; layout: Layout; group: string }

export const SIZE_PRESETS: SizePreset[] = [
  { id: "38x25", label: "38 × 25 mm", w: 38, h: 25, layout: "ROLL", group: "Thermal roll" },
  { id: "50x25", label: "50 × 25 mm", w: 50, h: 25, layout: "ROLL", group: "Thermal roll" },
  { id: "75x50", label: "75 × 50 mm", w: 75, h: 50, layout: "ROLL", group: "Thermal roll" },
  { id: "100x50", label: "100 × 50 mm", w: 100, h: 50, layout: "ROLL", group: "Thermal roll" },
  { id: "100x150", label: "100 × 150 mm (4 × 6 in)", w: 100, h: 150, layout: "ROLL", group: "Thermal roll" },
  { id: "a4-3x8", label: "A4 · 3 × 8 (70 × 36 mm)", w: 70, h: 36, layout: "SHEET", group: "A4 sheet" },
  { id: "a4-2x7", label: "A4 · 2 × 7 (99 × 38 mm)", w: 99, h: 38, layout: "SHEET", group: "A4 sheet" },
  { id: "a4-2x4", label: "A4 · 2 × 4 (99 × 67 mm)", w: 99, h: 67, layout: "SHEET", group: "A4 sheet" },
];

export const ALL_FIELDS_ON = Object.fromEntries(FIELDS.map(([k]) => [k, true])) as Record<FieldKey, boolean>;

export const DEFAULT_SETTINGS: LabelSettings = {
  sizeId: "50x25", w: 50, h: 25, layout: "ROLL", code: "BOTH", barFormat: "CODE128",
  font: "M", copies: 1, margin: 8, gap: 2,
  fields: { ...ALL_FIELDS_ON, to: false, date: false, parent: false },
  parents: true,
  qr: "DETAILS",
};

export const A4 = { w: 210, h: 297 };

/** How many stickers of this size fit an A4 page, with its margin and gap. */
export function sheetGrid(w: number, h: number, margin: number, gap: number) {
  const usableW = A4.w - 2 * margin;
  const usableH = A4.h - 2 * margin;
  const cols = Math.max(1, Math.floor((usableW + gap) / (w + gap)));
  const rows = Math.max(1, Math.floor((usableH + gap) / (h + gap)));
  return { cols, rows, perPage: cols * rows };
}

/** "18 labels · 1 A4 sheet" / "18 labels on the roll". */
export function printSummary(count: number, s: LabelSettings): string {
  const n = `${count} label${count === 1 ? "" : "s"}`;
  if (s.layout === "ROLL") return `${n} on the roll`;
  const { perPage } = sheetGrid(s.w, s.h, s.margin, s.gap);
  const pages = Math.max(1, Math.ceil(count / perPage));
  return `${n} · ${pages} A4 sheet${pages === 1 ? "" : "s"} (${perPage} a sheet)`;
}

/** The `@page` rule react-to-print runs the sheet under. */
export function pageCss(s: LabelSettings): string {
  if (s.layout === "ROLL") {
    return `@page { size: ${s.w}mm ${s.h}mm; margin: 0; }
      @media print {
        html, body { margin: 0; padding: 0; }
        .doc-label-sheet { display: block !important; }
        .doc-label { border: 0 !important; border-radius: 0 !important; break-after: page; page-break-after: always; }
        .doc-label:last-child { break-after: auto; page-break-after: auto; }
      }`;
  }
  const { cols } = sheetGrid(s.w, s.h, s.margin, s.gap);
  return `@page { size: A4; margin: ${s.margin}mm; }
    @media print {
      html, body { margin: 0; padding: 0; }
      .doc-label-sheet { display: grid !important; grid-template-columns: repeat(${cols}, ${s.w}mm);
        gap: ${s.gap}mm; }
      .doc-label { break-inside: avoid; page-break-inside: avoid; border: 0.2mm dashed #ccc !important; }
    }`;
}

/** Which stickers a choice selects, in print order (each line's packs parent first,
 *  then its codes), each repeated `copies` times. */
export function selectLabels(labels: DocLabelRow[], opts: {
  lineIds: number[] | null; packs: PackScope; units: boolean; copies?: number; parents?: boolean;
}): DocLabelRow[] {
  const lines = opts.lineIds ? new Set(opts.lineIds) : null;
  const chosen = labels.filter((r) => {
    if (lines && !lines.has(r.line_id)) return false;
    if (r.kind === "UNIT") return opts.units;
    if (opts.packs === "NONE") return false;
    if (r.context) return opts.parents ?? true;
    if (opts.packs === "TOP") return r.issued ?? r.depth === 0;
    if (opts.packs === "NEW") return r.new_here;
    return true;
  });
  // A parent label only rides along with something printed under it.
  const under = new Set(chosen.filter((r) => !r.context).flatMap((r) => (r.path ?? []).map((p) => p.code)));
  const picked = chosen.filter((r) => !r.context || under.has(r.code));
  const copies = Math.max(1, Math.min(10, Math.floor(opts.copies ?? 1)));
  return copies === 1 ? picked : picked.flatMap((r) => Array.from({ length: copies }, () => r));
}

/** The font scale for a sticker of this size: small labels stay legible, big ones fill. */
export function fontScale(s: Pick<LabelSettings, "w" | "h" | "font">): number {
  const k = Math.max(0.8, Math.min(3, Math.min(s.w / 50, s.h / 25)));
  return k * (s.font === "S" ? 0.85 : s.font === "L" ? 1.2 : 1);
}

// ---- per-user settings, in the browser (rule: never state anything must survive) ----

const KEY = (user: string) => `scm.docLabels.${user || "anon"}`;

interface Stored { last?: LabelSettings; presets?: { name: string; settings: LabelSettings }[] }

function read(user: string): Stored {
  try {
    const raw = window.localStorage.getItem(KEY(user));
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {};
  }
}

function write(user: string, value: Stored) {
  try {
    window.localStorage.setItem(KEY(user), JSON.stringify(value));
  } catch {
    // Private window or blocked storage: the dialog still works, it just forgets.
  }
}

/** A stored value read back through the defaults, so a setting added later never
 *  arrives undefined from an older browser copy. */
export function withDefaults(s: Partial<LabelSettings> | undefined): LabelSettings {
  return { ...DEFAULT_SETTINGS, ...(s ?? {}), fields: { ...DEFAULT_SETTINGS.fields, ...(s?.fields ?? {}) } };
}

export const loadLast = (user: string) => withDefaults(read(user).last);
export const saveLast = (user: string, s: LabelSettings) => write(user, { ...read(user), last: s });
export const loadPresets = (user: string) =>
  (read(user).presets ?? []).map((p) => ({ name: p.name, settings: withDefaults(p.settings) }));
export function savePreset(user: string, name: string, s: LabelSettings) {
  const now = read(user);
  const presets = (now.presets ?? []).filter((p) => p.name !== name);
  write(user, { ...now, presets: [...presets, { name, settings: s }] });
}
export function deletePreset(user: string, name: string) {
  const now = read(user);
  write(user, { ...now, presets: (now.presets ?? []).filter((p) => p.name !== name) });
}
