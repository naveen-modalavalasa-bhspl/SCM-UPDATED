import { describe, expect, it } from "vitest";
import {
  groupIssueLines, normalizeSplits, redistribute, replaceGroup, splitProblems,
  trackingOf,
} from "../issueSplits";
import type { IssueItemWrite, IssueStockSource, TrackingType } from "../types";

/**
 * The split model, tested without a screen.
 *
 * These are the rules the server enforces from the other side — a line must request
 * something, and may not issue more than it requested — plus the one this whole
 * change exists for: a pick names exactly as many identifiers as it takes off the
 * shelf, per BATCH and BIN, not per item.
 */

const line = (over: Partial<IssueItemWrite> = {}): IssueItemWrite => ({
  item_id: 7,
  item_code: "303010-MONITOR-HP-HP-0001",
  item_name: "All-in-One Monitor",
  indent_item_id: 55,
  requested_qty: 15,
  issued_qty: 0,
  serial_numbers: [],
  ...over,
});

/** A source row. `drawable_qty` follows `available_qty` unless a case is
 *  deliberately about the difference — which, on an approved allocation, is the
 *  normal case rather than the exotic one. */
const source = (over: Partial<IssueStockSource> = {}): IssueStockSource => {
  const base = {
    item_id: 7,
    bin_id: 1,
    bin_code: "F1-A1-R1-B1",
    batch_id: 11,
    batch_no: "AUG-26",
    available_qty: 5,
    reserved_qty: 0,
    own_reserved_qty: 0,
    ...over,
  };
  return {
    ...base,
    total_qty: over.total_qty ?? base.available_qty + base.reserved_qty,
    drawable_qty: over.drawable_qty ?? base.available_qty + base.own_reserved_qty,
  };
};

const label = (_type: TrackingType, count: number) =>
  count === 1 ? "asset tag" : "asset tags";

describe("groupIssueLines", () => {
  it("reads two lines against one indent line as two picks of one ask", () => {
    const groups = groupIssueLines([
      line({ requested_qty: 5, issued_qty: 5, batch_id: 11, bin_id: 1 }),
      line({ requested_qty: 10, issued_qty: 10, batch_id: 12, bin_id: 2 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].splits).toHaveLength(2);
    expect(groups[0].requested).toBe(15);
    expect(groups[0].issued).toBe(15);
    expect(groups[0].remaining).toBe(0);
  });

  it("keeps two different indent lines of the same item apart", () => {
    const groups = groupIssueLines([
      line({ indent_item_id: 55 }),
      line({ indent_item_id: 56 }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("tells each pick what its own location holds, and lists the rest as spare", () => {
    const groups = groupIssueLines(
      [line({ issued_qty: 5, batch_id: 11, bin_id: 1 })],
      { 7: [source(), source({ bin_id: 2, batch_id: 12, batch_no: "SEP-26", available_qty: 10 })] },
    );
    expect(groups[0].splits[0].drawable).toBe(5);
    expect(groups[0].spare).toHaveLength(1);
    expect(groups[0].spare[0].available_qty).toBe(10);
  });

  it("reports availability as unknown, not zero, before the sources have loaded", () => {
    const groups = groupIssueLines([line({ issued_qty: 5, batch_id: 11, bin_id: 1 })]);
    expect(groups[0].splits[0].drawable).toBeNull();
  });
});

describe("trackingOf", () => {
  it("prefers what the server said over what the item flags imply", () => {
    expect(trackingOf(line({ tracking_type: "ASSET", is_serial_tracked: true })))
      .toBe("ASSET");
  });

  it("falls back to the item's own flags on a line the server has not read yet", () => {
    expect(trackingOf(line({ is_serial_tracked: true }))).toBe("SERIAL");
    expect(trackingOf(line({ is_imei_tracked: true }))).toBe("IMEI");
    expect(trackingOf(line({ has_units: false }))).toBe("NONE");
  });
});

describe("what inventory allocated, and what the picks now say", () => {
  const group = (lines: IssueItemWrite[], sources: IssueStockSource[]) =>
    groupIssueLines(lines, { 7: sources })[0];

  it("names the locations inventory is holding for this document", () => {
    const sources = [
      source({ bin_id: 1, batch_id: 11, available_qty: 0, own_reserved_qty: 5,
               reserved_qty: 5, drawable_qty: 5 }),
      source({ bin_id: 2, batch_id: 12, available_qty: 10, drawable_qty: 10 }),
    ];
    const out = group([line({ issued_qty: 5, batch_id: 11, bin_id: 1 })], sources);

    expect(out.allocated.map((row) => row.bin_id)).toEqual([1]);
    // Still picked from where it was allocated, so nothing is being released.
    expect(out.releasing).toHaveLength(0);
    expect(out.splits[0].isAllocated).toBe(true);
  });

  it("flags the allocated location a pick has moved off, which saving will free", () => {
    const sources = [
      source({ bin_id: 1, batch_id: 11, available_qty: 0, own_reserved_qty: 5,
               reserved_qty: 5, drawable_qty: 5 }),
      source({ bin_id: 2, batch_id: 12, available_qty: 10, drawable_qty: 10 }),
    ];
    // The storekeeper found the goods in bay 2 and repointed the pick there.
    const out = group([line({ issued_qty: 5, batch_id: 12, bin_id: 2 })], sources);

    expect(out.releasing.map((row) => row.bin_id)).toEqual([1]);
    expect(out.splits[0].isAllocated).toBe(false);
  });

  it("carries the walk down to each pick's location, not just a bin code", () => {
    const sources = [
      source({ bin_id: 1, batch_id: 11, available_qty: 5, drawable_qty: 5,
               bin_path: "F1 / F1-A1 / F1-A1-R1 / F1-A1-R1-B1" }),
    ];
    const out = group([line({ issued_qty: 5, batch_id: 11, bin_id: 1 })], sources);
    expect(out.splits[0].binPath).toBe("F1 / F1-A1 / F1-A1-R1 / F1-A1-R1-B1");
  });
});

describe("replaceGroup", () => {
  it("puts the new picks where the old ones were, leaving the rest of the document alone", () => {
    const lines = [
      line({ item_id: 1, indent_item_id: 1 }),
      line({ item_id: 7, indent_item_id: 55 }),
      line({ item_id: 9, indent_item_id: 99 }),
    ];
    const target = groupIssueLines(lines)[1];
    const out = replaceGroup(lines, target, [
      line({ item_id: 7, indent_item_id: 55, issued_qty: 5 }),
      line({ item_id: 7, indent_item_id: 55, issued_qty: 10 }),
    ]);

    expect(out.map((l) => l.item_id)).toEqual([1, 7, 7, 9]);
  });
});

describe("normalizeSplits", () => {
  it("shares one ask across its picks so the requested quantities still add up", () => {
    // The ask is the SUM over the picks, so the fixture states it as the editor
    // maintains it: five here, ten there, fifteen in total.
    const out = normalizeSplits([
      line({ requested_qty: 5, issued_qty: 5, batch_id: 11, bin_id: 1 }),
      line({ requested_qty: 10, issued_qty: 10, batch_id: 12, bin_id: 2 }),
    ]);

    expect(out.map((l) => l.requested_qty)).toEqual([5, 10]);
    expect(out.map((l) => l.issued_qty)).toEqual([5, 10]);
    // Never more issued than requested: the rule `_apply_issue_lines` enforces.
    expect(out.every((l) => Number(l.issued_qty) <= Number(l.requested_qty))).toBe(true);
  });

  it("parks the shortfall on the first pick, so a short issue stays short", () => {
    const out = normalizeSplits([
      line({ requested_qty: 15, issued_qty: 4, batch_id: 11, bin_id: 1 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].requested_qty).toBe(15);
    expect(out[0].issued_qty).toBe(4);
  });

  it("drops a pick that names no goods, which the server would refuse outright", () => {
    const out = normalizeSplits([
      line({ requested_qty: 10, issued_qty: 10, batch_id: 11, bin_id: 1 }),
      line({ requested_qty: 0, issued_qty: 0, batch_id: 12, bin_id: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].issued_qty).toBe(10);
  });

  it("redistributes an ask over a new set of picks without inventing any of it", () => {
    // The bug this replaces: a pick added carrying the whole remainder made the
    // group's requested quantity a sum that had grown — fifteen monitors quietly
    // becoming twenty-five because the storekeeper split them over two bays.
    const out = redistribute(
      [
        line({ requested_qty: 15, issued_qty: 5, batch_id: 11, bin_id: 1 }),
        line({ requested_qty: 0, issued_qty: 10, batch_id: 12, bin_id: 2 }),
      ],
      15,
    );
    expect(out.reduce((sum, l) => sum + Number(l.requested_qty), 0)).toBe(15);
    expect(out.map((l) => l.requested_qty)).toEqual([5, 10]);
  });

  it("keeps a wholly unserved ask as one line requesting everything", () => {
    const out = normalizeSplits([line({ requested_qty: 15, issued_qty: 0 })]);
    expect(out).toHaveLength(1);
    expect(out[0].requested_qty).toBe(15);
    expect(out[0].issued_qty).toBe(0);
  });
});

describe("splitProblems", () => {
  const check = (lines: IssueItemWrite[], sources: IssueStockSource[] = []) =>
    splitProblems(groupIssueLines(lines, sources.length ? { 7: sources } : {}), {
      binManaged: true,
      unitLabel: label,
    });

  it("counts identifiers per PICK, not per item", () => {
    // Ten units over two bins with all ten codes piled onto the first pick used to
    // look complete: the item had 10 of 10. It is two picks and the second has none.
    const problems = check([
      line({
        requested_qty: 5, issued_qty: 5, batch_id: 11, bin_id: 1, tracking_type: "ASSET",
        serial_numbers: ["A1", "A2", "A3", "A4", "A5"],
      }),
      line({
        requested_qty: 5, issued_qty: 5, batch_id: 12, bin_id: 2, tracking_type: "ASSET",
        serial_numbers: [],
      }),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0].level).toBe("warn");
    expect(problems[0].message).toContain("5 more asset tags");
  });

  it("refuses a pick that takes more than its own location can give", () => {
    const problems = check(
      [line({ requested_qty: 15, issued_qty: 15, batch_id: 11, bin_id: 1, tracking_type: "NONE" })],
      [source({ available_qty: 5 })],
    );
    expect(problems.some((p) => p.level === "error" && p.message.includes("can give 5")))
      .toBe(true);
  });

  it("counts stock this document's own indent has reserved as drawable", () => {
    // The defect this replaces. An approved allocation reserves what it is about to
    // issue, so a correct line sees `available 0` over goods it plainly owns — and
    // the screen called it impossible. WHI0022 line 6 is exactly this: total 5,
    // available 0, reserved 5, reserved by its OWN indent.
    const problems = check(
      [line({ requested_qty: 5, issued_qty: 5, batch_id: 11, bin_id: 1, tracking_type: "NONE" })],
      [source({ available_qty: 0, reserved_qty: 5, own_reserved_qty: 5, total_qty: 5 })],
    );
    expect(problems).toEqual([]);
  });

  it("names somebody else's hold rather than leaving an unexplained gap", () => {
    const problems = check(
      [line({ requested_qty: 10, issued_qty: 10, batch_id: 11, bin_id: 1, tracking_type: "NONE" })],
      [source({ available_qty: 2, reserved_qty: 8, own_reserved_qty: 0, total_qty: 10 })],
    );
    expect(problems[0].message).toContain("can give 2");
    expect(problems[0].message).toContain("8 more is here but reserved for another document");
  });

  it("reports a quantity that is present but cannot be identified, separately", () => {
    // Quantity and identity are two tables. A pick can be sound on `stk_balance` and
    // still have no code to put against half its units — that used to surface only as
    // "the picker offers fewer codes than the line asks for".
    const problems = check(
      [line({
        requested_qty: 10, issued_qty: 10, batch_id: 11, bin_id: 1,
        tracking_type: "ASSET", units_available: 4,
      })],
      [source({ available_qty: 10 })],
    );
    const identity = problems.find((p) => p.message.includes("only 4 asset tags"));
    expect(identity).toBeDefined();
    expect(identity!.level).toBe("warn");
    // The quantity itself is not faulted — the stock is there.
    expect(problems.some((p) => p.level === "error")).toBe(false);
  });

  it("refuses two picks drawing on the same batch and storage location", () => {
    const problems = check([
      line({ requested_qty: 5, issued_qty: 5, batch_id: 11, bin_id: 1, tracking_type: "NONE" }),
      line({ requested_qty: 5, issued_qty: 5, batch_id: 11, bin_id: 1, tracking_type: "NONE" }),
    ]);
    expect(problems.some(
      (p) => p.message.includes("same batch and storage location"),
    )).toBe(true);
  });

  it("refuses more identifiers than the pick is for", () => {
    const problems = check([
      line({
        requested_qty: 2, issued_qty: 2, batch_id: 11, bin_id: 1, tracking_type: "ASSET",
        serial_numbers: ["A1", "A2", "A3"],
      }),
    ]);
    expect(problems.some(
      (p) => p.level === "error" && p.message.includes("3 asset tags named for 2 units"),
    )).toBe(true);
  });

  it("says nothing about identifiers for an item that has none", () => {
    expect(check([
      line({ requested_qty: 5, issued_qty: 5, batch_id: 11, bin_id: 1, has_units: false }),
    ])).toEqual([]);
  });

  it("stops asking for identifiers once the stock has been posted", () => {
    const problems = splitProblems(
      groupIssueLines([line({
        requested_qty: 5, issued_qty: 5, batch_id: 11, bin_id: 1, tracking_type: "ASSET",
        serial_numbers: [],
      })]),
      { binManaged: true, unitLabel: label, requireUnits: false },
    );
    expect(problems).toEqual([]);
  });
});
