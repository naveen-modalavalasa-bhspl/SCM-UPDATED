import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps new screens mobile-friendly without relying on anyone remembering to be.
 *
 * The layout work is only half the job: the app already had a responsive shell, a
 * responsive list and a responsive line editor, and screens still shipped that
 * squashed on a phone. Documentation does not stop that; a failing build does.
 *
 * Escape hatch: put `mobile-ok` in a comment on the offending line or the line
 * above, with a reason. Exceptions are legitimate — a skeleton of four placeholder
 * dots is fine at 375px — but they should be visible in review rather than assumed.
 */

const ROOT = join(__dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "tests" ? [] : walk(full);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")
      ? [relative(ROOT, full).replace(/\\/g, "/")]
      : [];
  });
}

const SOURCES = walk(join(ROOT, "modules"));

/** Three or more columns leaves under ~110px per cell at 375px. Two survives. */
const DENSE_GRID = /\bgrid-cols-[3-9]\b/;
/** A hardcoded width wider than the narrowest phone forces a sideways page scroll.
 *  `max-w-` is excluded deliberately — it is a ceiling, not a floor, so `w-full
 *  max-w-[540px]` still collapses to the viewport on a phone. A breakpoint prefix
 *  (`:` before the utility, as in `lg:min-w-[420px]`) is excluded for the same
 *  reason: the smallest breakpoint is `sm` at 640px, so a prefixed width never
 *  applies on the 375px screen this guard protects. */
const WIDE_FIXED = /(?<![\w:-])(?:w|min-w)-\[(\d{3,})px\]/;
/** Handed to `LinesEditor`, which applies it inside its own scroll box. */
const SCROLL_SURFACE_PROP = /minTableWidth/;

/** Files whose whole job is to contain a wide thing safely. */
const SCROLL_SURFACES = [
  "shared/components/ResponsiveList.tsx",
  "shared/components/ScrollBox.tsx",
  "modules/warehouse/components/LinesEditor.tsx",
];

function offenders(test: (line: string, source: string) => boolean) {
  const found: string[] = [];
  for (const rel of SOURCES) {
    if (SCROLL_SURFACES.some((s) => rel.endsWith(s))) continue;
    const source = readFileSync(join(ROOT, rel), "utf8");
    const lines = source.split("\n");
    lines.forEach((line, i) => {
      if (!test(line, source)) return;
      const excused = /mobile-ok/.test(line) || /mobile-ok/.test(lines[i - 1] ?? "");
      if (!excused) found.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  return found;
}

describe("mobile guard", () => {
  it("has sources to check", () => {
    expect(SOURCES.length).toBeGreaterThan(50);
  });

  it("no grid of 3+ columns without a breakpoint prefix", () => {
    const bad = offenders(
      (line) => DENSE_GRID.test(line) && !/(sm|md|lg|xl):grid-cols-[3-9]/.test(line),
    );
    expect(bad, `Use <ResponsiveGrid cols={3}> instead:\n${bad.join("\n")}`).toEqual([]);
  });

  /* File-level, not ancestor-level: whether a given <table> sits inside the file's
   * scroll container cannot be decided from the text. This catches the failure that
   * actually happened — a table with no scroll container anywhere in the file, which
   * pushes the whole page sideways. */
  it("no <table> in a file with no scroll container", () => {
    const bad = offenders(
      (line, source) =>
        /<table[\s>]/.test(line) && !/overflow-(x-)?auto|<ScrollBox/.test(source),
    );
    expect(
      bad,
      `Wrap it in <ScrollBox>, or use <ResponsiveList>/<LinesEditor>:\n${bad.join("\n")}`,
    ).toEqual([]);
  });

  /* A wide min-width is correct inside a scroll box — that is how a dense grid keeps
   * its columns readable. It is only a bug when nothing can scroll it. */
  it("no fixed width wider than a phone outside a scroll container", () => {
    const bad = offenders((line, source) => {
      const m = WIDE_FIXED.exec(line);
      return m !== null && Number(m[1]) > 360
        && !SCROLL_SURFACE_PROP.test(line)
        && !/overflow-(x-)?auto|<ScrollBox/.test(source);
    });
    expect(bad, `Hardcoded width overflows a 375px screen:\n${bad.join("\n")}`).toEqual([]);
  });
});
