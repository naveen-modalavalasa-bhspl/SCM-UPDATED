import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../../../src/config.js";

/**
 * The bug sheet, as data.
 *
 * The register of defects lives in a Google Sheet a human maintains. A test that
 * hardcodes "BUG-14 — draft can be submitted twice" drifts the moment somebody
 * renames the row, and a reader of the report then has no way to tie a failure
 * back to the ticket. So the sheet is exported to `data/bugs.csv` and read here:
 * the spec supplies the *verification*, the sheet supplies the identity — id,
 * title, module, severity, and the reporter's own steps and expectation, which
 * get copied into the verdict log so the log stands on its own.
 *
 * The CSV is optional. Without it every spec still runs and still reports FIXED
 * or NOT FIXED; it just carries less context. That matters because the sheet is
 * private — a run on a machine that cannot reach it must not turn into an error.
 */

export interface Bug {
  id: string;
  title: string;
  module?: string;
  severity?: string;
  status?: string;
  steps?: string;
  expected?: string;
  actual?: string;
  reportedBy?: string;
  reportedOn?: string;
  /** True when the row came from the sheet rather than from the spec's own fallback. */
  fromSheet: boolean;
}

export const BUGS_CSV = resolve(ROOT, "data", "bugs.csv");

/* ------------------------------------------------------------------ CSV parsing */

/**
 * RFC 4180 enough for a Google Sheets export: quoted fields, escaped quotes,
 * and newlines inside a quoted cell — which "steps to reproduce" columns are full
 * of, and which a `split("\n")` would shred into unusable half-rows.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  // Strip the BOM Sheets prepends; left in place it becomes part of the first
  // header name and every column lookup misses.
  const input = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

const normalise = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which spreadsheet column means what.
 *
 * Written as a list of accepted spellings rather than one exact name because the
 * sheet is a human's working document — "Bug ID", "S.No", "Issue", "Expected
 * Result" are all the same intent, and a column renamed between exports must not
 * silently empty the log.
 */
const COLUMNS: Record<keyof Omit<Bug, "fromSheet">, string[]> = {
  id: ["id", "bugid", "bugno", "ticket", "ticketid", "issueid", "key", "sno", "sluno", "srno", "no"],
  title: ["title", "summary", "issue", "bug", "bugtitle", "description", "problem", "defect", "issuedescription"],
  module: ["module", "area", "screen", "page", "component", "feature", "section"],
  severity: ["severity", "priority", "impact"],
  status: ["status", "state", "bugstatus", "devstatus", "currentstatus", "fixstatus"],
  steps: ["steps", "stepstoreproduce", "stepstoreplicate", "repro", "reproductionsteps", "howtoreproduce"],
  expected: ["expected", "expectedresult", "expectedbehaviour", "expectedbehavior", "expectedoutcome", "shouldbe"],
  actual: ["actual", "actualresult", "actualbehaviour", "actualbehavior", "observed", "currentbehaviour"],
  reportedBy: ["reportedby", "raisedby", "reporter", "loggedby", "author"],
  reportedOn: ["reportedon", "raisedon", "date", "reporteddate", "loggedon", "createdon"],
};

function resolveColumns(headers: string[]): Partial<Record<keyof Bug, number>> {
  const seen = headers.map(normalise);
  const mapping: Partial<Record<keyof Bug, number>> = {};
  for (const [field, spellings] of Object.entries(COLUMNS) as [keyof Bug, string[]][]) {
    // Exact match first, then prefix — "expectedresultafterfix" should still land
    // on `expected`, but must not steal the column an exact "expected" wants.
    let index = seen.findIndex((header) => spellings.includes(header));
    if (index < 0) index = seen.findIndex((header) => spellings.some((s) => header.startsWith(s)));
    if (index >= 0) mapping[field] = index;
  }
  return mapping;
}

/* ------------------------------------------------------------------- the loader */

let cache: Map<string, Bug> | null = null;

/**
 * The sheet, keyed by bug id (upper-cased, so `scm-14` and `SCM-14` are one bug).
 *
 * Read once per worker process. A missing or unreadable file yields an empty
 * register rather than an exception — see the note at the top of this file.
 */
export function bugRegister(): Map<string, Bug> {
  if (cache) return cache;
  cache = new Map();
  if (!existsSync(BUGS_CSV)) return cache;

  const rows = parseCsv(readFileSync(BUGS_CSV, "utf8"));
  if (rows.length < 2) return cache;

  // Sheets often carry a title banner above the real header. The header is the
  // first row that actually names an id-ish and a title-ish column.
  let headerIndex = rows.findIndex((cells) => {
    const mapping = resolveColumns(cells);
    return mapping.id !== undefined || mapping.title !== undefined;
  });
  if (headerIndex < 0) headerIndex = 0;

  const mapping = resolveColumns(rows[headerIndex]);
  const cell = (cells: string[], field: keyof Bug) => {
    const index = mapping[field];
    const value = index === undefined ? "" : (cells[index] ?? "").trim();
    return value || undefined;
  };

  for (const cells of rows.slice(headerIndex + 1)) {
    const id = cell(cells, "id");
    const title = cell(cells, "title");
    if (!id && !title) continue;
    const key = (id ?? title!).toUpperCase();
    cache.set(key, {
      id: id ?? key,
      title: title ?? "(no title in the sheet)",
      module: cell(cells, "module"),
      severity: cell(cells, "severity"),
      status: cell(cells, "status"),
      steps: cell(cells, "steps"),
      expected: cell(cells, "expected"),
      actual: cell(cells, "actual"),
      reportedBy: cell(cells, "reportedBy"),
      reportedOn: cell(cells, "reportedOn"),
      fromSheet: true,
    });
  }
  return cache;
}

/**
 * The sheet's row for a bug, or a stand-in built from what the spec knows.
 *
 * The fallback is deliberate: a spec must be runnable by someone who has not
 * exported the sheet, and the verdict for a bug must never depend on whether its
 * paperwork was to hand.
 */
export function bugRow(id: string, fallbackTitle: string): Bug {
  const found = bugRegister().get(id.toUpperCase());
  if (found) return { ...found, title: found.title || fallbackTitle };
  return { id, title: fallbackTitle, fromSheet: false };
}
