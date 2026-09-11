import { describe, expect, it } from "vitest";
import {
  allowedExpiries, batchChoices, groupIssueLines, locationChoices, normalizeSplits,
  redistribute, replaceGroup, splitProblems, trackingOf, trimUnits,
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
  const total = over.total_qty ?? base.available_qty + base.reserved_qty;
  return {
    ...base,
    total_qty: total,
    drawable_qty: over.drawable_qty ?? base.available_qty + base.own_reserved_qty,
    // The wider readings default to this row alone, which is what a one-location
    // warehouse actually holds. A case about the difference states them.
    batch_total_qty: over.batch_total_qty ?? total,
    batch_available_qty: over.batch_available_qty ?? base.available_qty,
    item_total_qty: over.item_total_qty ?? total,
    item_available_qty: over.item_available_qty ?? base.available_qty,
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

  it("reads the warehouse and the batch around each pick, not just the bay", () => {
    // One batch split over two bays, and a second batch elsewhere. 40 of the item in
    // the warehouse, 25 of it in the batch this pick names, 5 in the bay it names.
    const sources = [
      source({ bin_id: 1, batch_id: 11, available_qty: 5,
               batch_total_qty: 25, batch_available_qty: 25,
               item_total_qty: 40, item_available_qty: 40 }),
      source({ bin_id: 2, batch_id: 11, available_qty: 20,
               batch_total_qty: 25, batch_available_qty: 25,
               item_total_qty: 40, item_available_qty: 40 }),
      source({ bin_id: 3, batch_id: 12, available_qty: 15,
               batch_total_qty: 15, batch_available_qty: 15,
               item_total_qty: 40, item_available_qty: 40 }),
    ];
    const out = group([line({ issued_qty: 5, batch_id: 11, bin_id: 1 })], sources);

    expect(out.warehouseTotal).toBe(40);
    expect(out.warehouseDrawable).toBe(40);
    expect(out.splits[0].batchTotal).toBe(25);
    expect(out.splits[0].batchDrawable).toBe(25);
    // The innermost of the three stays what it always was: this bay, this batch.
    expect(out.splits[0].total).toBe(5);
  });

  it("takes the warehouse total from the server, never from the rows on screen", () => {
    // 30 in the warehouse and only 10 of it offerable — the other 20 sit on a
    // location another document has reserved outright, which is why that row is not
    // in the list at all. Summing the list would report the shelf as a third full.
    const sources = [
      source({ bin_id: 1, batch_id: 11, available_qty: 10,
               batch_total_qty: 30, batch_available_qty: 10,
               item_total_qty: 30, item_available_qty: 10 }),
    ];
    const out = group([line({ issued_qty: 10, batch_id: 11, bin_id: 1 })], sources);

    expect(out.warehouseTotal).toBe(30);
    expect(out.warehouseDrawable).toBe(10);
    expect(out.splits[0].batchTotal).toBe(30);
    expect(out.splits[0].batchDrawable).toBe(10);
  });

  it("says nothing about either width until the sources have been read", () => {
    const out = groupIssueLines([line({ issued_qty: 5, batch_id: 11, bin_id: 1 })])[0];
    expect(out.warehouseTotal).toBeNull();
    expect(out.warehouseDrawable).toBeNull();
    expect(out.splits[0].batchTotal).toBeNull();
    expect(out.splits[0].batchDrawable).toBeNull();
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

/* ------------------------------------------------ what a pick may be moved onto -- */

describe("the batches a pick may be moved onto", () => {
  // Two batches of one item: AUG-26 expires first and sits in two bays, SEP-26
  // expires six weeks later. A third, undated, is on the shelf as well.
  const shelf = [
    source({ bin_id: 1, batch_id: 11, batch_no: "AUG-26", expiry_date: "2026-08-31",
             available_qty: 5, batch_total_qty: 25 }),
    source({ bin_id: 2, batch_id: 11, batch_no: "AUG-26", expiry_date: "2026-08-31",
             available_qty: 20, batch_total_qty: 25 }),
    source({ bin_id: 3, batch_id: 12, batch_no: "SEP-26", expiry_date: "2026-09-30",
             available_qty: 15, batch_total_qty: 15 }),
    source({ bin_id: 4, batch_id: 13, batch_no: "NO-DATE", expiry_date: null,
             available_qty: 7, batch_total_qty: 7 }),
  ];

  it("offers each batch once, oldest first, with what it can give", () => {
    const choices = batchChoices(shelf);

    expect(choices.map((row) => row.batchNo)).toEqual(["AUG-26", "SEP-26", "NO-DATE"]);
    // Summed over the bays it sits in, and the bay count says how many walks it is.
    expect(choices[0].drawable).toBe(25);
    expect(choices[0].locations).toBe(2);
    expect(choices[0].total).toBe(25);
  });

  it("puts an undated batch last, because it is unknown rather than distant", () => {
    // Sorting an absent expiry as "far future" would be a guess; sorting it first
    // would send every picker to stock nobody can date.
    expect(batchChoices(shelf).at(-1)?.batchNo).toBe("NO-DATE");
  });

  it("allows a swap only onto a batch expiring on the same day", () => {
    // Inventory allocated AUG-26. FEFO cannot tell two batches expiring on one day
    // apart — it can tell AUG-26 from SEP-26, and taking SEP-26 first leaves the
    // earlier batch on the shelf to expire.
    const allocated = [
      source({ bin_id: 1, batch_id: 11, batch_no: "AUG-26", expiry_date: "2026-08-31",
               own_reserved_qty: 5, available_qty: 0, reserved_qty: 5,
               drawable_qty: 5 }),
    ];
    const allowed = allowedExpiries(allocated);
    const choices = batchChoices([...shelf,
      source({ bin_id: 9, batch_id: 14, batch_no: "AUG-26-B",
               expiry_date: "2026-08-31", available_qty: 4 }),
    ], allowed);

    const by = Object.fromEntries(choices.map((row) => [row.batchNo, row]));
    expect(by["AUG-26"].allowed).toBe(true);
    // The same expiry on a different batch number is the one swap FEFO permits.
    expect(by["AUG-26-B"].allowed).toBe(true);
    expect(by["SEP-26"].allowed).toBe(false);
    expect(by["SEP-26"].blocked).toContain("oldest first");
    // An undated batch matches only another undated one — "no expiry" is not a date.
    expect(by["NO-DATE"].allowed).toBe(false);
  });

  it("keeps a batch FEFO refuses out of what is offered as somewhere else to look", () => {
    // `spare` prefills the next pick and names what the item is short of. A row on a
    // later-expiring batch is one the server would refuse, so offering it sends the
    // storekeeper to a bay he cannot draw from.
    const group = groupIssueLines(
      [line({ issued_qty: 5, batch_id: 11, bin_id: 1 })],
      {
        7: [
          source({ bin_id: 1, batch_id: 11, expiry_date: "2026-08-31",
                   available_qty: 0, reserved_qty: 5, own_reserved_qty: 5,
                   drawable_qty: 5 }),
          source({ bin_id: 2, batch_id: 11, expiry_date: "2026-08-31",
                   available_qty: 9 }),
          source({ bin_id: 3, batch_id: 12, expiry_date: "2026-09-30",
                   available_qty: 30 }),
        ],
      },
    )[0];

    // The other bay of the allocated batch, and not the later batch behind it.
    expect(group.spare.map((row) => row.bin_id)).toEqual([2]);
  });

  it("constrains nothing when there is no allocation to depart from", () => {
    // A manual issue has nothing signed behind it. The FEFO order still stands as
    // advice; refusing every batch but one would make an indent-less issue unusable.
    expect(allowedExpiries([])).toBeNull();
    expect(batchChoices(shelf, null).every((row) => row.allowed)).toBe(true);
  });

  it("lists only the locations holding the chosen batch, fullest first", () => {
    const locations = locationChoices(shelf, 11);

    expect(locations.map((row) => row.binId)).toEqual([2, 1]);
    expect(locations[0].drawable).toBe(20);
  });

  it("names what somebody else is holding at a location, rather than leaving a gap", () => {
    const locations = locationChoices([
      source({ bin_id: 1, batch_id: 11, available_qty: 2, reserved_qty: 8,
               own_reserved_qty: 3, total_qty: 10, drawable_qty: 5 }),
    ], 11);

    // 8 held altogether, 3 of it this document's own: the other 5 belong elsewhere
    // and an unexplained gap between the shelf and the pick reads as a bug.
    expect(locations[0].othersHold).toBe(5);
    expect(locations[0].allocated).toBe(true);
  });
});

describe("lowering an issue quantity", () => {
  it("drops the identifiers the pick can no longer carry, from the tail", () => {
    const pick = line({ issued_qty: 10, serial_numbers: ["a", "b", "c", "d"] });

    // Six units, four codes: nothing to drop.
    expect(trimUnits(pick, 6)).toEqual(["a", "b", "c", "d"]);
    // Two units: the last two scanned are the ones still in his hand.
    expect(trimUnits(pick, 2)).toEqual(["a", "b"]);
    expect(trimUnits(pick, 0)).toEqual([]);
  });

  it("keeps the same array when nothing has to go", () => {
    const pick = line({ serial_numbers: ["a"] });
    expect(trimUnits(pick, 5)).toBe(pick.serial_numbers);
  });
});

describe("FEFO, as the grid states it", () => {
  const problems = (batchId: number, expiry: string) =>
    splitProblems(
      groupIssueLines(
        [line({ issued_qty: 5, batch_id: batchId, bin_id: 1 })],
        {
          7: [
            source({ bin_id: 1, batch_id: 11, batch_no: "AUG-26",
                     expiry_date: "2026-08-31", available_qty: 0, reserved_qty: 5,
                     own_reserved_qty: 5, drawable_qty: 5 }),
            source({ bin_id: 1, batch_id: batchId, batch_no: "OTHER",
                     expiry_date: expiry, available_qty: 5 }),
          ],
        },
      ),
      { binManaged: true, unitLabel: label, requireUnits: false },
    );

  it("refuses a pick that reaches past the batch the allocation reserved", () => {
    const found = problems(12, "2026-09-30");
    expect(found.some((p) => p.level === "error" && p.message.includes("oldest first")))
      .toBe(true);
  });

  it("accepts one expiring on the same day, which is the swap FEFO cannot see", () => {
    expect(problems(14, "2026-08-31").some((p) => p.message.includes("oldest first")))
      .toBe(false);
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
