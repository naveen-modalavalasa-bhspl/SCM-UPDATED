import type { RelatedDocument, RelatedDocuments, TrailChapter } from "./types";

/**
 * The paper trail behind a returned item, grouped into the legs the material travelled.
 *
 * Same shape of model as `journeyModel.ts`, deliberately — the return's own journey and
 * the material's history are read on the same screen and must feel like one idea — but
 * they describe two different things and never share a row. The journey is what happened
 * to THIS DOCUMENT: who signed it, where it is now. This is what happened to the
 * MATERIAL, across a dozen other modules, long before anybody thought of sending it back.
 *
 * The legs, their names and the question each one answers are SERVED
 * (`returns/enums.py TRAIL_CHAPTERS`, on `payload.chapters`), and each document arrives
 * carrying the leg it belongs to (`doc.chapter`). Nothing here knows a document type.
 * That is the whole point: a type added to the trail lands under a heading without this
 * file changing, exactly as `doc_label` already means this file names nothing.
 */

export type TrailChapterState = "travelled" | "skipped" | "ahead";

export interface TrailChapterGroup extends TrailChapter {
  state: TrailChapterState;
  /** The one-line summary under the heading. Composed here, from the state and the
   *  count, the way `journeyModel.trackSummary` composes a leg's. */
  summary: string;
  documents: RelatedDocument[];
  /** How many documents this leg holds BEFORE any search narrowed it. Equal to
   *  `documents.length` until `filterTrailChapters` runs, and the number the index
   *  chips and the "x of y" wording are read off afterwards. */
  total: number;
  /** True only when the leg genuinely holds documents and the current search matched
   *  none of them. A different fact from `state`, and said in different words: the
   *  material DID travel this leg, the reader is just not looking at it right now. */
  hidden: boolean;
}

/** Where documents go whose `chapter` the server could not place — an older payload, or
 *  a type served before the chapter map caught up. Last, and named for what it is: a
 *  row with a number on it is worth more to a reviewer than a row quietly dropped. */
const UNPLACED: TrailChapter = {
  key: "__unplaced__",
  label: "Also under this item",
  caption: "Recorded against the material, outside the legs above.",
  count: 0,
};

/** One flat leg, for a payload served before chapters existed. The section then renders
 *  exactly the list it always did, under one heading, rather than nothing at all. */
const FLAT: TrailChapter = {
  key: "__all__",
  label: "Everything behind this item",
  caption: "In the order the work happened.",
  count: 0,
};

/**
 * The legs that belong on the TIMELINE — the ones with documents, plus the ones the
 * material has simply not reached yet.
 *
 * A leg the material demonstrably skipped is dropped (CHANGED 2026-09-14). This module's
 * returns are stock coming back to the warehouse it was issued from, and that material
 * was served off a shelf the warehouse already held: `Purchase` and `Receipt` are empty
 * on essentially every one of them. Drawing two permanent grey rows saying "never went
 * through this leg" on every return in the system is not a fact being reported, it is a
 * fact being repeated — and it cost a third of the section's height to say something the
 * desk knew before it opened the screen.
 *
 * It is DROPPED, never hidden. `skippedChapters` hands the same legs back so the screen
 * can name them in one quiet line, and the rule stays derived rather than configured: a
 * return whose material really was bought against a PO shows Purchase and Receipt with
 * their documents in them, because then they are not skipped.
 *
 * "Not reached yet" stays. That one is news — it says where the material is in its life
 * right now, and it stops being true on its own.
 */
export function timelineChapters(groups: TrailChapterGroup[]) {
  return groups.filter((group) => group.state !== "skipped");
}

/** The legs the material provably went round. Named in a sentence rather than drawn, so
 *  nothing is silently missing from the timeline above it. */
export function skippedChapters(groups: TrailChapterGroup[]) {
  return groups.filter((group) => group.state === "skipped");
}

function documentCount(count: number): string {
  return `${count} ${count === 1 ? "document" : "documents"}`;
}

function summaryOf(state: TrailChapterState, count: number): string {
  if (state === "travelled") return documentCount(count);
  // The two empties are NOT the same fact, and saying so is most of what this screen is
  // for. A gap BEHIND the material means it never travelled that leg — an indent served
  // off stock already on the shelf raises an allocation and never a purchase order, and
  // a reviewer who reads that as missing paperwork goes hunting for a PO that was
  // correctly never raised. A gap AHEAD of it simply has not happened yet.
  if (state === "skipped") return "Never went through this leg";
  return "Not reached yet";
}

/**
 * The trail as legs, in served order, EVERY leg included.
 *
 * A leg with nothing in it is kept on purpose: the shape of the gaps is the story. The
 * two kinds of gap are told apart positionally rather than by guessing from a document
 * type — a leg is "ahead" when nothing after it has happened either, and "skipped" when
 * the material has demonstrably moved past it. That is derivable from the counts alone,
 * so it stays true for a trail this file has never seen.
 */
export function buildTrailChapters(data?: RelatedDocuments): TrailChapterGroup[] {
  const documents = data?.documents ?? [];
  const served = data?.chapters ?? [];

  if (served.length === 0) {
    // No chapters served. One leg holding the whole trail, in the order it arrived.
    if (documents.length === 0) return [];
    return [{
      ...FLAT,
      count: documents.length,
      total: documents.length,
      hidden: false,
      state: "travelled",
      summary: summaryOf("travelled", documents.length),
      documents,
    }];
  }

  const byChapter = new Map<string, RelatedDocument[]>();
  served.forEach((chapter) => byChapter.set(chapter.key, []));
  const unplaced: RelatedDocument[] = [];
  documents.forEach((doc) => {
    const bucket = doc.chapter ? byChapter.get(doc.chapter) : undefined;
    (bucket ?? unplaced).push(doc);
  });

  // The furthest leg the material actually reached. Read off the rows this payload
  // carries, never off the served `count`, so a capped or filtered list and the headings
  // over it can never disagree about how far the material got.
  let lastReached = -1;
  served.forEach((chapter, index) => {
    if ((byChapter.get(chapter.key) ?? []).length > 0) lastReached = index;
  });

  const groups: TrailChapterGroup[] = served.map((chapter, index) => {
    const rows = byChapter.get(chapter.key) ?? [];
    const state: TrailChapterState = rows.length > 0
      ? "travelled"
      : (index < lastReached ? "skipped" : "ahead");
    return {
      ...chapter,
      count: rows.length,
      total: rows.length,
      hidden: false,
      state,
      summary: summaryOf(state, rows.length),
      documents: rows,
    };
  });

  if (unplaced.length > 0) {
    groups.push({
      ...UNPLACED,
      count: unplaced.length,
      total: unplaced.length,
      hidden: false,
      state: "travelled",
      summary: summaryOf("travelled", unplaced.length),
      documents: unplaced,
    });
  }
  return groups;
}

/**
 * Does this document answer the search?
 *
 * Every field the row PRINTS is searchable, and nothing it does not. A desk looking for
 * one document on a long trail has one of four things in hand — a number somebody read
 * down a phone, a vendor's name, the warehouse it moved through, or the kind of document
 * it is — and a search that matches only the number sends them back to reading
 * twenty-six rows. The served `doc_label` is included and the raw `doc_type` with it, so
 * "material issue" and "MATERIAL_ISSUE" both land.
 */
export function trailDocumentMatches(doc: RelatedDocument, needle: string): boolean {
  const fields = [
    doc.doc_no, doc.doc_label, doc.doc_type, doc.status,
    doc.vendor_name, doc.warehouse_name, doc.date, doc.note,
  ];
  return fields.some((field) => (
    typeof field === "string" && field.toLowerCase().includes(needle)
  ));
}

export interface FilteredTrail {
  groups: TrailChapterGroup[];
  /** Rows still standing across the whole trail. Zero is a state the section has to say
   *  something about, rather than draw six empty legs for. */
  matches: number;
  /** Whether a search is actually narrowing anything, so no caller has to re-derive
   *  "is the box non-blank" from the raw string. */
  active: boolean;
}

/**
 * The same legs, narrowed to a search.
 *
 * **A leg's STATE never changes under a filter.** Whether the material was bought is a
 * fact about the material; it cannot become false because somebody typed a vendor's name
 * into a box. So a travelled leg stays travelled — filled dot, coloured spine — and is
 * merely marked `hidden` when nothing in it matched, which the band then says in its own
 * words. Letting a search rewrite the state would turn the one thing this screen exists
 * to show ("it was never bought") into something that lies whenever the box is not empty.
 */
export function filterTrailChapters(
  groups: TrailChapterGroup[],
  query: string,
): FilteredTrail {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return {
      groups,
      matches: groups.reduce((sum, group) => sum + group.total, 0),
      active: false,
    };
  }

  let matches = 0;
  const narrowed = groups.map((group) => {
    const rows = group.documents.filter((doc) => trailDocumentMatches(doc, needle));
    matches += rows.length;
    const hidden = group.total > 0 && rows.length === 0;
    return {
      ...group,
      count: rows.length,
      hidden,
      documents: rows,
      // A leg that never held anything keeps the sentence that says WHY it is empty —
      // that fact survives the search, and replacing it with "nothing matches" would
      // hide the trail's one genuinely interesting gap behind the reader's own typing.
      summary: group.total === 0
        ? group.summary
        : (hidden
          ? "Nothing here matches"
          : `${documentCount(rows.length)} of ${group.total}`),
    };
  });
  return { groups: narrowed, matches, active: true };
}

/**
 * The first document of a given type on the trail, or null.
 *
 * Exists so the summary card can put the indent and the material issue on the screen as
 * LINKS rather than as two numbers somebody has to go and find. They are the two rows a
 * desk reaches for on nearly every return — where the request came from, and what handed
 * the goods over — and making them one press each is most of the reason the full trail can
 * live on its own page without the common case losing anything.
 *
 * Keyed on `doc_type` rather than on a chapter, because it is one specific document being
 * named and not "whatever happened to be first in that leg".
 */
export function firstOfType(
  data: RelatedDocuments | undefined,
  docType: string,
): RelatedDocument | null {
  return data?.documents.find((doc) => doc.doc_type === docType) ?? null;
}
