import { describe, expect, it } from "vitest";
import {
  deriveResult, lineResult, qcRate, qcSentence, qcTone, summarizeQc, summaryFromRow,
} from "../qcSummary";

const line = (inspected: number, accepted: number, result = "PENDING") =>
  ({ inspected_qty: inspected, accepted_qty: accepted, rejected_qty: inspected - accepted, result });

describe("summarizeQc — SCM_0164 / 0165 / 0166", () => {
  it("counts a partly rejected line as PARTIAL and its rejection in the totals", () => {
    // The bug: Passed 0, Failed 0, 0 % pass rate, no rejected total.
    const s = summarizeQc([line(10, 8)]);
    expect(s).toMatchObject({ partial: 1, passed: 0, failed: 0, inspected: 10, accepted: 8, rejected: 2 });
    expect(s.passRate).toBe(80);
  });

  it("puts every line in exactly one bucket", () => {
    const s = summarizeQc([line(5, 5), line(4, 0), line(6, 3), line(0, 0)]);
    expect(s.passed + s.partial + s.failed + s.pending).toBe(s.lines);
    expect(s).toMatchObject({ passed: 1, failed: 1, partial: 1, pending: 1 });
  });

  it("rates by quantity, not by lines", () => {
    // One failed line of 1 unit next to a passed line of 99: 99 %, not 50 %.
    expect(summarizeQc([line(99, 99), line(1, 0)]).passRate).toBe(99);
  });

  it("has no pass rate while nothing is inspected", () => {
    expect(summarizeQc([line(0, 0)]).passRate).toBeNull();
    expect(summarizeQc([]).passRate).toBeNull();
    expect(qcRate(null)).toBe("—");
  });

  it("reads a stored result, and judges a PENDING one off its split", () => {
    expect(lineResult({ inspected_qty: 10, accepted_qty: 10, result: "PENDING" })).toBe("PASSED");
    expect(lineResult({ inspected_qty: 10, accepted_qty: 4, result: "PARTIAL" })).toBe("PARTIAL");
    expect(deriveResult(3, 0)).toBe("FAILED");
  });
});

describe("summaryFromRow", () => {
  it("uses the served quantities", () => {
    const s = summaryFromRow({
      total_items: 2, passed_items: 1, failed_items: 0, partial_items: 1, pending_items: 0,
      inspected_qty: "12.000", accepted_qty: "10.000", rejected_qty: "2.000", pass_rate: 83.3,
    });
    expect(s).toMatchObject({ inspected: 12, accepted: 10, rejected: 2, partial: 1, passRate: 83.3 });
  });

  it("falls back to line counts when the quantities are not served", () => {
    const s = summaryFromRow({ total_items: 3, passed_items: 1, failed_items: 1 });
    expect(s).toMatchObject({ pending: 1, passRate: null, inspected: 0 });
  });
});

describe("the sentence and the tone", () => {
  it("says what happened, in words", () => {
    expect(qcSentence(summarizeQc([]))).toBe("Nothing inspected yet.");
    expect(qcSentence(summarizeQc([line(10, 10)]))).toBe("All 10 units accepted.");
    expect(qcSentence(summarizeQc([line(10, 8)])))
      .toBe("8 of 10 units accepted · 2 rejected, on 1 partly rejected line.");
    expect(qcSentence(summarizeQc([line(3, 0), line(3, 0)])))
      .toBe("All 6 units rejected, on 2 failed lines.");
  });

  it("colours by outcome", () => {
    expect(qcTone(summarizeQc([]))).toBe("idle");
    expect(qcTone(summarizeQc([line(4, 4)]))).toBe("ok");
    expect(qcTone(summarizeQc([line(4, 2)]))).toBe("warn");
    expect(qcTone(summarizeQc([line(4, 0)]))).toBe("bad");
  });
});

import { applyQcEdit, passIfUntouched, qcLineResult } from "../qcSummary";

describe("a QC line starts un-inspected — SCM_0124", () => {
  const blank = { inspected: 0, accepted: 0, rejected: 0 };

  it("is Pending until accepted + rejected account for what was inspected", () => {
    expect(qcLineResult(0, 0, 0)).toBe("PENDING");
    expect(qcLineResult(10, 0, 0)).toBe("PENDING");
    expect(qcLineResult(10, 6, 0)).toBe("PENDING");
    expect(qcLineResult(10, 10, 0)).toBe("PASSED");
    expect(qcLineResult(10, 7, 3)).toBe("PARTIAL");
    expect(qcLineResult(10, 0, 10)).toBe("FAILED");
  });

  it("counting alone never rejects anything", () => {
    expect(applyQcEdit(blank, { inspected: 10 }, 10)).toEqual({ inspected: 10, accepted: 0, rejected: 0 });
  });

  it("typing accepted or rejected completes the split", () => {
    const counted = { inspected: 10, accepted: 0, rejected: 0 };
    expect(applyQcEdit(counted, { accepted: 8 })).toEqual({ inspected: 10, accepted: 8, rejected: 2 });
    expect(applyQcEdit(counted, { rejected: 3 })).toEqual({ inspected: 10, accepted: 7, rejected: 3 });
  });

  it("re-counting a judged line keeps it judged; Inspected never passes what arrived", () => {
    expect(applyQcEdit({ inspected: 10, accepted: 8, rejected: 2 }, { inspected: 6 }))
      .toEqual({ inspected: 6, accepted: 6, rejected: 0 });
    expect(applyQcEdit(blank, { inspected: 99 }, 10).inspected).toBe(10);
  });

  it("Pass all touches only lines nobody has worked", () => {
    expect(passIfUntouched(blank, 10)).toEqual({ inspected: 10, accepted: 10, rejected: 0 });
    expect(passIfUntouched({ inspected: 4, accepted: 0, rejected: 0 }, 10)).toBeNull();
  });
});
