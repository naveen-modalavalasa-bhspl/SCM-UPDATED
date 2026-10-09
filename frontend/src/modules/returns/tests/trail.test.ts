import { describe, expect, it } from "vitest";
import {
  buildTrailChapters, filterTrailChapters, firstOfType, skippedChapters,
  timelineChapters, trailDocumentMatches,
} from "../trailModel";
import type { RelatedDocument, RelatedDocuments, TrailChapter } from "../types";

/**
 * The material's history, grouped into the legs it travelled.
 *
 * What is pinned here is the half that fails SILENTLY: a document that arrives and lands
 * under no heading is a row a reviewer never sees, and the difference between "never went
 * through this leg" and "not reached yet" is the difference between a purchase order that
 * was correctly never raised and one somebody should go looking for.
 */

const CHAPTERS: TrailChapter[] = [
  { key: "REQUEST", label: "Request", caption: "q1", count: 0 },
  { key: "COMMITMENT", label: "Allocation", caption: "q2", count: 0 },
  { key: "SOURCING", label: "Purchase", caption: "q3", count: 0 },
  { key: "INBOUND", label: "Receipt", caption: "q4", count: 0 },
  { key: "OUTBOUND", label: "Issue", caption: "q5", count: 0 },
  { key: "REVERSE", label: "Return", caption: "q6", count: 0 },
];

function doc(
  docType: string,
  chapter: string | null,
  over: Partial<RelatedDocument> = {},
): RelatedDocument {
  return {
    doc_type: docType,
    chapter,
    doc_id: 1,
    doc_no: `${docType}-1`,
    status: null,
    date: null,
    vendor_name: null,
    warehouse_name: null,
    ...over,
  };
}

function payload(documents: RelatedDocument[], chapters = CHAPTERS): RelatedDocuments {
  return {
    return_id: 1,
    return_no: "RET-1",
    originating_warehouse_id: null,
    originating_warehouse_name: null,
    originating_source_doc: null,
    originating_is_resolved: false,
    current_warehouse_id: null,
    current_warehouse_name: null,
    material_issue_no: null,
    material_issue_id: null,
    intent: null,
    intent_label: null,
    items: [],
    documents,
    chapters,
    documents_note: null,
    purchase_return_category: null,
    purchase_return_category_label: null,
    purchase_return_source_detail: null,
    purchase_return_source_tier: null,
    purchase_return_source_resolved: false,
    qc_rejected_tag: false,
    vehicle_options: [],
    vehicle_type: null,
    logistics_mode: null,
  } as unknown as RelatedDocuments;
}

describe("the material's history, as legs", () => {
  it("keeps every document, under the leg the server named", () => {
    const groups = buildTrailChapters(payload([
      doc("INDENT", "REQUEST"),
      doc("ALLOCATION", "COMMITMENT"),
      doc("MATERIAL_ISSUE", "OUTBOUND"),
    ]));
    const kept = groups.flatMap((group) => group.documents.map((row) => row.doc_type));
    expect(kept).toEqual(["INDENT", "ALLOCATION", "MATERIAL_ISSUE"]);
  });

  it("returns every leg, including the ones nothing landed in", () => {
    const groups = buildTrailChapters(payload([doc("INDENT", "REQUEST")]));
    expect(groups.map((group) => group.key)).toEqual(CHAPTERS.map((row) => row.key));
  });

  it("tells a leg the material skipped apart from one it has not reached", () => {
    // Asked for, never bought (served off stock already on the shelf), then issued.
    // Nothing has come back yet.
    const groups = buildTrailChapters(payload([
      doc("INDENT", "REQUEST"),
      doc("ALLOCATION", "COMMITMENT"),
      doc("MATERIAL_ISSUE", "OUTBOUND"),
    ]));
    const state = Object.fromEntries(groups.map((g) => [g.key, g.state]));
    expect(state.REQUEST).toBe("travelled");
    expect(state.COMMITMENT).toBe("travelled");
    // Behind the furthest point the material reached: it genuinely never went here.
    expect(state.SOURCING).toBe("skipped");
    expect(state.INBOUND).toBe("skipped");
    expect(state.OUTBOUND).toBe("travelled");
    // Ahead of it: simply has not happened yet.
    expect(state.REVERSE).toBe("ahead");
  });

  it("says which of the two an empty leg is, rather than leaving it blank", () => {
    const groups = buildTrailChapters(payload([
      doc("INDENT", "REQUEST"),
      doc("MATERIAL_ISSUE", "OUTBOUND"),
    ]));
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.summary]));
    expect(byKey.SOURCING).toBe("Never went through this leg");
    expect(byKey.REVERSE).toBe("Not reached yet");
    expect(byKey.REQUEST).toBe("1 document");
  });

  it("counts off the rows it was sent, not off the served count", () => {
    // A capped or filtered list and the headings over it must never disagree about how
    // far the material got.
    const chapters = CHAPTERS.map((row) => ({ ...row, count: 99 }));
    const groups = buildTrailChapters(payload([doc("INDENT", "REQUEST")], chapters));
    expect(groups[0].count).toBe(1);
    expect(groups.filter((g) => g.state === "travelled")).toHaveLength(1);
  });

  it("shows a document whose leg the server could not place, under its own heading", () => {
    const groups = buildTrailChapters(payload([
      doc("INDENT", "REQUEST"),
      doc("SOMETHING_NEW", null),
    ]));
    const last = groups[groups.length - 1];
    expect(last.documents.map((row) => row.doc_type)).toEqual(["SOMETHING_NEW"]);
    expect(last.label).toBeTruthy();
  });

  it("falls back to one flat leg when no chapters were served", () => {
    const groups = buildTrailChapters(payload([doc("INDENT", null)], []));
    expect(groups).toHaveLength(1);
    expect(groups[0].documents).toHaveLength(1);
  });

  it("renders nothing at all for an empty trail", () => {
    expect(buildTrailChapters(undefined)).toEqual([]);
    expect(buildTrailChapters(payload([], []))).toEqual([]);
  });
});

/**
 * Narrowing the trail to a search.
 *
 * The half that fails silently here is the STATE of a leg. "It was never bought" is a
 * fact about the material and the most useful thing this screen says; a filter that can
 * turn it on and off by what somebody typed makes the screen lie every time the box is
 * not empty.
 */
describe("narrowing the trail to a search", () => {
  const trail = () => buildTrailChapters(payload([
    doc("INDENT", "REQUEST", { doc_no: "IND0012", warehouse_name: "Central Warehouse-1" }),
    doc("ALLOCATION", "COMMITMENT", { doc_no: "ALC0044" }),
    doc("PO", "SOURCING", { doc_no: "PO0013", vendor_name: "Bavya Traders" }),
    doc("MATERIAL_ISSUE", "OUTBOUND", { doc_no: "WHI0022" }),
  ]));

  it("hands back the same legs untouched when the box is empty", () => {
    const groups = trail();
    const result = filterTrailChapters(groups, "   ");
    expect(result.active).toBe(false);
    expect(result.groups).toBe(groups);
    expect(result.matches).toBe(4);
  });

  it("keeps only the rows that match, and counts them", () => {
    const { groups, matches, active } = filterTrailChapters(trail(), "po0013");
    expect(active).toBe(true);
    expect(matches).toBe(1);
    const kept = groups.flatMap((g) => g.documents.map((row) => row.doc_no));
    expect(kept).toEqual(["PO0013"]);
  });

  it("matches on the vendor, the warehouse and the document type, not only the number", () => {
    expect(filterTrailChapters(trail(), "bavya").matches).toBe(1);
    expect(filterTrailChapters(trail(), "central warehouse").matches).toBe(1);
    expect(filterTrailChapters(trail(), "material_issue").matches).toBe(1);
  });

  it("never lets a search rewrite whether the material travelled a leg", () => {
    // The whole point of the grouping: SOURCING here is real (a PO was raised) and
    // REVERSE genuinely never happened. Neither may change because somebody typed.
    const { groups } = filterTrailChapters(trail(), "ind0012");
    const state = Object.fromEntries(groups.map((g) => [g.key, g.state]));
    expect(state.SOURCING).toBe("travelled");
    expect(state.REVERSE).toBe("ahead");
  });

  it("says 'nothing here matches' for a real leg, and keeps the reason an empty one is empty", () => {
    const { groups } = filterTrailChapters(trail(), "ind0012");
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    // A leg that HAS documents, none of them matching: a fact about the search.
    expect(byKey.SOURCING.hidden).toBe(true);
    expect(byKey.SOURCING.summary).toBe("Nothing here matches");
    // A leg that never held anything keeps the sentence that says why.
    expect(byKey.REVERSE.hidden).toBe(false);
    expect(byKey.REVERSE.summary).toBe("Not reached yet");
  });

  it("says how much of a leg is being shown when only part of it matches", () => {
    const groups = buildTrailChapters(payload([
      doc("INDENT", "REQUEST", { doc_no: "IND0012" }),
      doc("INTENT", "REQUEST", { doc_no: "IND0099" }),
      doc("ALLOCATION", "COMMITMENT", { doc_no: "ALC0044" }),
    ]));
    const { groups: narrowed } = filterTrailChapters(groups, "IND00");
    const request = narrowed.find((g) => g.key === "REQUEST")!;
    expect(request.count).toBe(2);
    expect(request.total).toBe(2);
    expect(request.summary).toBe("2 documents of 2");
    const commitment = narrowed.find((g) => g.key === "COMMITMENT")!;
    expect(commitment.summary).toBe("Nothing here matches");
  });

  it("reports no matches at all rather than six empty legs", () => {
    const { matches } = filterTrailChapters(trail(), "nothing-like-this");
    expect(matches).toBe(0);
  });

  it("ignores case and reads the fields a row actually prints", () => {
    const row = doc("PO", "SOURCING", { doc_no: "PO0013", note: "Signed by A. Rao" });
    expect(trailDocumentMatches(row, "a. rao")).toBe(true);
    expect(trailDocumentMatches(row, "po0013")).toBe(true);
    expect(trailDocumentMatches(row, "grn")).toBe(false);
  });

  it("carries the leg's real size through, so the index can still show it", () => {
    const { groups } = filterTrailChapters(trail(), "po0013");
    const sourcing = groups.find((g) => g.key === "SOURCING")!;
    expect(sourcing.total).toBe(1);
    expect(groups.filter((g) => g.state === "travelled").map((g) => g.key))
      .toEqual(["REQUEST", "COMMITMENT", "SOURCING", "OUTBOUND"]);
  });
});

/**
 * Which legs belong on the timeline.
 *
 * A leg the material demonstrably skipped is dropped from the drawing and named in a
 * sentence instead; a leg it simply has not reached yet stays. The difference is the
 * difference between a fact the desk already knows on every return in the system ("stock
 * off the shelf was never bought") and one that tells it where the material is right now.
 */
describe("which legs are drawn", () => {
  it("drops a skipped leg and hands it back to be named", () => {
    const groups = buildTrailChapters(payload([
      doc("INDENT", "REQUEST"),
      doc("ALLOCATION", "COMMITMENT"),
      doc("MATERIAL_ISSUE", "OUTBOUND"),
    ]));
    expect(timelineChapters(groups).map((g) => g.key))
      .toEqual(["REQUEST", "COMMITMENT", "OUTBOUND", "REVERSE"]);
    expect(skippedChapters(groups).map((g) => g.label)).toEqual(["Purchase", "Receipt"]);
  });

  it("keeps a leg the material has not reached yet — that one is news", () => {
    const groups = buildTrailChapters(payload([doc("INDENT", "REQUEST")]));
    const drawn = timelineChapters(groups);
    expect(drawn.map((g) => g.key)).toEqual(["REQUEST", "COMMITMENT", "SOURCING",
      "INBOUND", "OUTBOUND", "REVERSE"]);
    expect(drawn[1].summary).toBe("Not reached yet");
  });

  it("keeps a leg that really was travelled — the rule is derived, not configured", () => {
    const groups = buildTrailChapters(payload([
      doc("INDENT", "REQUEST"),
      doc("PO", "SOURCING"),
      doc("MATERIAL_ISSUE", "OUTBOUND"),
    ]));
    const keys = timelineChapters(groups).map((g) => g.key);
    expect(keys).toContain("SOURCING");
    // COMMITMENT and INBOUND are the skipped ones here, and they go.
    expect(keys).not.toContain("COMMITMENT");
    expect(keys).not.toContain("INBOUND");
  });

  it("never drops a leg while a search is narrowing it", () => {
    // `hidden` is not `skipped`: the material travelled the leg, the reader is simply
    // not looking at it. Dropping it would make the timeline change shape as you type.
    const groups = buildTrailChapters(payload([
      doc("INDENT", "REQUEST", { doc_no: "IND0012" }),
      doc("ALLOCATION", "COMMITMENT", { doc_no: "ALC0044" }),
    ]));
    const { groups: narrowed } = filterTrailChapters(groups, "IND0012");
    expect(timelineChapters(narrowed).map((g) => g.key)).toContain("COMMITMENT");
  });
});

describe("the documents lifted onto the summary", () => {
  it("finds the first row of a type, so the indent can be a link and not a number", () => {
    const data = payload([
      doc("INTENT", "REQUEST"),
      doc("INDENT", "REQUEST", { doc_no: "IND0012", doc_id: 5 }),
      doc("INDENT", "REQUEST", { doc_no: "IND0099", doc_id: 9 }),
    ]);
    expect(firstOfType(data, "INDENT")?.doc_no).toBe("IND0012");
    expect(firstOfType(data, "PO")).toBeNull();
    expect(firstOfType(undefined, "INDENT")).toBeNull();
  });
});
