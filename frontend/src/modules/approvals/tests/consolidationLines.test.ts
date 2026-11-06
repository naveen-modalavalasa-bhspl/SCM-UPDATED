import { describe, expect, it } from "vitest";
import {
  heldIndentIds, indentLineIds, isIndentRemoved, reducePercent, resolveItem, stepDown,
} from "../consolidationLines";
import type { CycleDecisions } from "../consolidationDecisions";
import type { ConsolidatedItem, ConsolidatedItemAllocation } from "../types";

/** The approver decides at the indent. Each line carries its own quantity and its own
 *  excluded flag, and the numbers that go out are exactly what these functions return —
 *  there is no batch total shared out in proportion any more. */

interface LineSpec {
  indent: number;      // indent id (and number IND-<id>)
  line: number;        // line id, unique across the cycle
  requested: number;
  ceiling?: number;    // defaults to the request
  lockedBelow?: boolean;
}

const alloc = (spec: LineSpec): ConsolidatedItemAllocation => ({
  indent_id: spec.indent,
  indent_no: `IND-${spec.indent}`,
  line_id: spec.line,
  requested_quantity: spec.requested,
  ceiling_quantity: spec.ceiling ?? spec.requested,
  ...(spec.lockedBelow ? { is_excluded: true, excluded_by_name: "Lower Approver" } : {}),
});

const item = (
  id: number, specs: LineSpec[], extra: Partial<ConsolidatedItem> = {},
): ConsolidatedItem => ({
  item_id: id,
  item_code: `ITEM-${id}`,
  item_name: `Item ${id}`,
  uom_code: "STRIP",
  total_requested_quantity: specs.reduce((sum, s) => sum + s.requested, 0),
  total_ceiling_quantity: specs.reduce((sum, s) => sum + (s.ceiling ?? s.requested), 0),
  indent_count: specs.length,
  allocations: specs.map(alloc),
  ...extra,
});

const draft = (entries: Record<number, { approved?: string; excluded?: boolean }>): CycleDecisions =>
  Object.fromEntries(Object.entries(entries).map(([id, d]) => [
    id, { approved: d.approved ?? "", excluded: d.excluded ?? false },
  ]));

describe("resolveItem", () => {
  const dolo = item(1, [
    { indent: 1, line: 11, requested: 10 },
    { indent: 2, line: 12, requested: 10 },
    { indent: 3, line: 13, requested: 5 },
  ]);

  it("sends every indent its full ceiling when nothing is touched", () => {
    const resolved = resolveItem(dolo, {});
    expect(resolved.lines.map((line) => line.value)).toEqual([10, 10, 5]);
    expect(resolved.total).toBe(25);
    expect(resolved.ceiling).toBe(25);
    expect(resolved.droppedCount).toBe(0);
  });

  it("gives each indent the quantity typed in its own box, and only that indent", () => {
    const resolved = resolveItem(dolo, draft({ 12: { approved: "4" } }));
    expect(resolved.lines.map((line) => line.value)).toEqual([10, 4, 5]);
    expect(resolved.total).toBe(19);
  });

  it("caps a quantity typed past the ceiling and says so", () => {
    const resolved = resolveItem(dolo, draft({ 11: { approved: "40" } }));
    expect(resolved.lines[0]).toMatchObject({ over: true, value: 10 });
    expect(resolved.over).toBe(true);
  });

  it("flags a negative quantity, and reads blank as the full ceiling, not zero", () => {
    expect(resolveItem(dolo, draft({ 11: { approved: "-1" } })).invalid).toBe(true);
    expect(resolveItem(dolo, draft({ 11: { approved: "" } })).lines[0].value).toBe(10);
  });

  it("treats zero as a quantity, not as an exclusion", () => {
    const resolved = resolveItem(dolo, draft({ 11: { approved: "0" } }));
    expect(resolved.lines[0]).toMatchObject({ value: 0, excluded: false });
    expect(resolved.droppedCount).toBe(0);
  });

  it("steps a countable unit down to whole units", () => {
    const gloves = item(2, [{ indent: 1, line: 21, requested: 10 }], { uom_decimals: 0 });
    const resolved = resolveItem(gloves, draft({ 21: { approved: "4.9" } }));
    expect(resolved.lines[0]).toMatchObject({ value: 4, rounded: true });
  });

  it("takes an excluded indent's ceiling out of what is approvable", () => {
    const resolved = resolveItem(dolo, draft({ 13: { excluded: true } }));
    expect(resolved.lines[2]).toMatchObject({ excluded: true, value: 0 });
    expect(resolved.droppedCount).toBe(1);
    expect(resolved.ceiling).toBe(20);
    expect(resolved.total).toBe(20);
  });

  it("does not let an excluded row's leftover typing raise a problem", () => {
    const resolved = resolveItem(dolo, draft({ 11: { approved: "999", excluded: true } }));
    expect(resolved.over).toBe(false);
    expect(resolved.lines[0].value).toBe(0);
  });

  it("keeps a line dropped further down the ladder dropped, whatever the draft says", () => {
    const locked = item(3, [
      { indent: 1, line: 31, requested: 10, lockedBelow: true },
      { indent: 2, line: 32, requested: 10 },
    ]);
    const resolved = resolveItem(locked, draft({ 31: { excluded: false, approved: "5" } }));
    expect(resolved.lines[0]).toMatchObject({ excluded: true, excludedBelow: true, value: 0 });
    expect(resolved.droppedCount).toBe(1);
  });
});

describe("whole-indent actions", () => {
  // Indent 1 is on both items, indent 2 only on the first.
  const a = item(1, [
    { indent: 1, line: 11, requested: 10 },
    { indent: 2, line: 12, requested: 10 },
  ]);
  const b = item(2, [{ indent: 1, line: 21, requested: 6 }]);
  const items = [a, b];

  it("finds every line an indent has across the cycle, minus those a rung below dropped", () => {
    expect(indentLineIds(items, 1)).toEqual([11, 21]);
    const withLocked = [a, item(2, [{ indent: 1, line: 21, requested: 6, lockedBelow: true }])];
    expect(indentLineIds(withLocked, 1)).toEqual([11]);
  });

  it("calls an indent removed only when every line it can still decide is excluded", () => {
    expect(isIndentRemoved(items, 1, draft({ 11: { excluded: true } }))).toBe(false);
    expect(isIndentRemoved(items, 1, draft({ 11: { excluded: true }, 21: { excluded: true } }))).toBe(true);
    // An indent with only this one line is removed as soon as the line is excluded.
    expect(isIndentRemoved(items, 2, draft({ 12: { excluded: true } }))).toBe(true);
  });

  it("is not removed when it has nothing left for this approver to decide", () => {
    const allLocked = [item(1, [{ indent: 9, line: 91, requested: 3, lockedBelow: true }])];
    expect(isIndentRemoved(allLocked, 9, {})).toBe(false);
  });

  it("holds back an indent that is out of every line, and only that one", () => {
    expect([...heldIndentIds(items, draft({ 11: { excluded: true } }))]).toEqual([]);
    const removedOne = draft({ 11: { excluded: true }, 21: { excluded: true } });
    expect([...heldIndentIds(items, removedOne)]).toEqual([1]);
  });

  it("counts a line dropped below as out when deciding whether an indent is held", () => {
    const mixed = [
      item(1, [{ indent: 1, line: 11, requested: 5, lockedBelow: true }]),
      item(2, [{ indent: 1, line: 21, requested: 5 }]),
    ];
    expect([...heldIndentIds(mixed, draft({ 21: { excluded: true } }))]).toEqual([1]);
    expect([...heldIndentIds(mixed, {})]).toEqual([]);
  });
});

describe("reducePercent", () => {
  const dolo = item(1, [
    { indent: 1, line: 11, requested: 10 },
    { indent: 2, line: 12, requested: 10 },
    { indent: 3, line: 13, requested: 5 },
  ]);

  it("gives every included indent the same share of its own ceiling", () => {
    const { entries, before, after } = reducePercent(dolo, {}, 80);
    expect(entries.map((e) => [e.lineId, e.approved])).toEqual([[11, "8"], [12, "8"], [13, "4"]]);
    expect(before).toBe(25);
    expect(after).toBe(20);
  });

  it("leaves excluded indents alone, here and further down the ladder", () => {
    const locked = item(2, [
      { indent: 1, line: 21, requested: 10 },
      { indent: 2, line: 22, requested: 10, lockedBelow: true },
      { indent: 3, line: 23, requested: 10 },
    ]);
    const { entries } = reducePercent(locked, draft({ 23: { excluded: true } }), 50);
    expect(entries.map((e) => e.lineId)).toEqual([21]);
  });

  it("works from the ceiling, so pressing it twice with the same number changes nothing", () => {
    const once = reducePercent(dolo, {}, 80);
    const applied = draft(Object.fromEntries(once.entries.map((e) => [e.lineId, { approved: e.approved }])));
    const twice = reducePercent(dolo, applied, 80);
    expect(twice.entries.map((e) => e.approved)).toEqual(once.entries.map((e) => e.approved));
  });

  it("puts every line back to its full ceiling at 100", () => {
    const { entries, after } = reducePercent(dolo, draft({ 11: { approved: "3" } }), 100);
    expect(entries.every((e) => e.approved === "")).toBe(true);
    expect(after).toBe(25);
  });

  it("steps a countable unit down and says how many lines fall to nothing", () => {
    const gloves = item(3, [
      { indent: 1, line: 31, requested: 7 },
      { indent: 2, line: 32, requested: 1 },
    ], { uom_decimals: 0 });
    const { entries, zeroed } = reducePercent(gloves, {}, 70);
    expect(entries.map((e) => e.approved)).toEqual(["4", "0"]);
    expect(zeroed).toBe(1);
  });

  it("produces exactly the total it announced once it is applied", () => {
    const { entries, after } = reducePercent(dolo, {}, 60);
    const applied = draft(Object.fromEntries(entries.map((e) => [e.lineId, { approved: e.approved }])));
    expect(resolveItem(dolo, applied).total).toBe(after);
  });

  it("does not touch the other items of the same indents", () => {
    const other = item(2, [{ indent: 1, line: 21, requested: 10 }]);
    const { entries } = reducePercent(dolo, {}, 50);
    expect(entries.some((e) => e.lineId === 21)).toBe(false);
    expect(resolveItem(other, draft(Object.fromEntries(entries.map((e) => [e.lineId, { approved: e.approved }])))).total).toBe(10);
  });
});

describe("what Approve all sends", () => {
  it("is each line's own quantity and excluded flag, with excluded lines at zero", () => {
    const a = item(1, [
      { indent: 1, line: 11, requested: 10 },
      { indent: 2, line: 12, requested: 10 },
      { indent: 3, line: 13, requested: 10, lockedBelow: true },
    ]);
    const decisions = draft({ 11: { approved: "6" }, 12: { excluded: true } });
    const lines = resolveItem(a, decisions).lines.map((line) => ({
      indent_id: line.allocation.indent_id,
      line_id: line.allocation.line_id,
      approved_quantity: line.value,
      excluded: line.excluded,
    }));
    expect(lines).toEqual([
      { indent_id: 1, line_id: 11, approved_quantity: 6, excluded: false },
      { indent_id: 2, line_id: 12, approved_quantity: 0, excluded: true },
      { indent_id: 3, line_id: 13, approved_quantity: 0, excluded: true },
    ]);
  });
});

describe("stepDown", () => {
  it("does not lose a whole step to floating point", () => {
    expect(stepDown(5.7, 3)).toBe(5.7);
    expect(stepDown(4.9, 0)).toBe(4);
    expect(stepDown(0.3, 1)).toBe(0.3);
  });
});
