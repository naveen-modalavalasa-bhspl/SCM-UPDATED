import { describe, expect, it } from "vitest";
import {
  indentsPerRequester, linesByIndent, reasonsOf,
} from "../cycleIndentLines";
import type { CycleLedger, CycleLedgerItem } from "../types";

const site = (over: Partial<CycleLedgerItem["sites"][number]>) => ({
  line_id: 1, indent_id: 10, indent_no: "IND0001", requester: "Rajesh",
  office_name: "Agali", requested: 10, approved: 10, change: 0,
  decision: "APPROVED", is_excluded: false, indent_status: "PENDING_APPROVAL",
  ...over,
});

const item = (over: Partial<CycleLedgerItem>): CycleLedgerItem => ({
  item_id: 1, item_code: "C1", item_name: "Cotton", uom_code: "NOS",
  requested: 10, decided_requested: 10, approved: 10, waiting_quantity: 0,
  change: 0, request_count: 1, site_count: 1, decided_sites: 1,
  waiting_requests: 0, reduced_sites: 0, excluded_sites: 0,
  decision: "APPROVED", sites: [site({})],
  ...over,
});

describe("linesByIndent", () => {
  it("re-keys the item roll-up by indent, so a row can open without a request", () => {
    const lines = linesByIndent([
      item({ item_id: 1, item_name: "Cotton", sites: [
        site({ line_id: 1, indent_id: 10 }),
        site({ line_id: 2, indent_id: 20, requested: 5, approved: 3, change: -2 }),
      ] }),
      item({ item_id: 2, item_name: "Gloves", uom_code: "PKT", sites: [
        site({ line_id: 3, indent_id: 10, requested: 4, approved: 4 }),
      ] }),
    ]);
    expect([...lines.keys()].sort()).toEqual([10, 20]);
    expect(lines.get(10)!.map((line) => line.item_name)).toEqual(["Cotton", "Gloves"]);
    // The item's identity travels with the line: the panel names the item, and the
    // site row it came from never carried the name.
    expect(lines.get(10)![1]).toMatchObject({ item_id: 2, uom_code: "PKT" });
    expect(lines.get(20)![0]).toMatchObject({ requested: 5, approved: 3, change: -2 });
  });

  it("keeps an undecided line as null rather than folding it to zero", () => {
    // `0 approved` is a denial and `null` is an unanswered line. Collapsing the two
    // reports a decision the approver never took.
    const lines = linesByIndent([item({
      sites: [site({ indent_id: 7, approved: null, change: null, decision: "WAITING" })],
    })]);
    expect(lines.get(7)![0].approved).toBeNull();
    expect(lines.get(7)![0].decision).toBe("WAITING");
  });

  it("carries the line's audit through, and defaults it to no events", () => {
    // A server that has not shipped the field yet must leave a line with an empty
    // trail, never with `undefined` for the panel to crash a `.length` on.
    const lines = linesByIndent([item({
      sites: [
        site({ line_id: 1, indent_id: 7, quantity_history: [{
          audit_id: 1, previous_quantity: 20, new_quantity: 10, delta: -10,
          reduction: 10, actor_name: "C Ramakrishna", stage_name: "OE",
          changed_at: "2026-09-21T09:43:56", source: "sys_audit_log",
        }] }),
        site({ line_id: 2, indent_id: 7 }),
      ],
    })]);
    expect(lines.get(7)![0].quantity_history).toHaveLength(1);
    expect(lines.get(7)![1].quantity_history).toEqual([]);
  });

  it("carries a dropped line, which is not the same event as a cut to zero", () => {
    const lines = linesByIndent([item({
      sites: [site({ indent_id: 7, is_excluded: true, approved: 0, change: -10 })],
    })]);
    expect(lines.get(7)![0].is_excluded).toBe(true);
  });
});

describe("reasonsOf", () => {
  it("says one comment once, however many lines it was stamped on", () => {
    const lines = linesByIndent([item({
      sites: [
        site({ line_id: 1, indent_id: 7, reason: "Cut to available stock" }),
        site({ line_id: 2, indent_id: 7, reason: "Cut to available stock" }),
      ],
    })]);
    expect(reasonsOf(lines.get(7)!)).toEqual(["Cut to available stock"]);
  });

  it("keeps two distinct comments, because that is two presses on one document", () => {
    const lines = linesByIndent([item({
      sites: [
        site({ line_id: 1, indent_id: 7, reason: "Cut to stock" }),
        site({ line_id: 2, indent_id: 7, reason: "Duplicate of IND0044" }),
      ],
    })]);
    expect(reasonsOf(lines.get(7)!)).toHaveLength(2);
  });

  it("treats blank and whitespace as no comment, never as an empty quote", () => {
    const lines = linesByIndent([item({
      sites: [
        site({ line_id: 1, indent_id: 7, reason: "   " }),
        site({ line_id: 2, indent_id: 7, reason: null }),
      ],
    })]);
    expect(reasonsOf(lines.get(7)!)).toEqual([]);
  });
});

describe("indentsPerRequester", () => {
  it("counts a requester's indents in the cycle, so a repeat can say so", () => {
    // A month is meant to hold one indent per site; the rule is not written yet, so
    // the register has to read correctly when a requester raised three.
    const counts = indentsPerRequester({
      indents: [
        { requested_by_id: 1 }, { requested_by_id: 1 }, { requested_by_id: 2 },
      ],
    } as unknown as CycleLedger);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(1);
  });

  it("never keys on a missing requester id", () => {
    const counts = indentsPerRequester({
      indents: [{ requested_by_id: null }, { requested_by_id: undefined }],
    } as unknown as CycleLedger);
    expect(counts.size).toBe(0);
  });
});
