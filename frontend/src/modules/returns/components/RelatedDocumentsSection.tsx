import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, History } from "lucide-react";
import { returnsApi } from "../api";
import { relatedDocumentLinks } from "../documentLinks";
import {
  buildTrailChapters, firstOfType, skippedChapters, timelineChapters,
} from "../trailModel";
import type { RelatedDocuments } from "../types";
import { SectionCard } from "./DetailChrome";
import { LegChip, ProvenanceStrip, TrailFacts, type TrailFact } from "./TrailChrome";

/**
 * Behind this material — the SUMMARY, on the return's own screen.
 *
 * The whole history of a returned item is eighteen kinds of document across a dozen
 * modules: the indent it was asked for on, the allocation that decided this branch got
 * these units, the material request that went short, the requisition, the RFQ, the winning
 * quotation, the PO, the vendor's despatch note, the GRN, the inbound bench, the putaway
 * that names the lot, the picklist, the issue, the outward check, the consignment it left
 * on, both legs of transport, and the purchase return once the load has gone.
 *
 * ## Why that is no longer all on this screen (2026-09-14)
 *
 * It was, and it was the single heaviest thing on a page that already carries fourteen
 * panels — a twenty-six row expandable tree standing between the reader and the decision
 * they came to take. Grouping it into legs made it readable; it did not make it SHORT, and
 * the complaint was never that the list was disordered.
 *
 * So the detail page keeps the part a desk needs at a glance and nothing else:
 *
 * - **the movement** — which point the material left and which one it is standing at now,
 *   the one fact that decides where a return may go;
 * - **the two documents anybody actually opens** — the indent it was raised against and
 *   the issue that handed it over — as LINKS, not as numbers to go and find;
 * - **the shape of the trail** — one chip per leg with its count, so "eleven issue
 *   documents, nine on the way back" is read without a press;
 * - **one way in** to the whole thing.
 *
 * Everything else moved to `ReturnTrailPage` (`/returns/:id/trail`), which has a page to
 * itself and can lay the same documents out with room — the same call the indent's journey
 * screen makes, and for the same reason. Nothing was removed from the system; one screen
 * stopped trying to be two.
 *
 * Legs the material demonstrably skipped are named in a sentence rather than drawn
 * (`trailModel.timelineChapters`): these returns are stock coming back to the warehouse it
 * was issued from, so `Purchase` and `Receipt` are empty on essentially all of them, and
 * two permanent grey rows repeating that on every return in the system is not a fact being
 * reported.
 *
 * ## Who sees it
 *
 * The decision desk: `return.decide`. The route is gated on the same code and the detail
 * page asks `can_view_trail` before rendering this at all. It is not a wider view of the
 * return — it is a dozen OTHER modules' documents, and somebody who only raises returns
 * does not need the branch's purchase orders, its vendor or what the material cost.
 *
 * Every desk holder sees the same thing, including one who raised the return themselves:
 * which profiles hold `return.decide` is an administrator's call on Job Profiles, and each
 * document is gated by its own module besides — a row served here is still unopenable by
 * somebody with no right to that document.
 */
export function RelatedDocumentsSection({ returnId }: { returnId: number }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["returns", returnId, "related-documents"],
    queryFn: () => returnsApi.relatedDocuments(returnId),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const chapters = useMemo(() => buildTrailChapters(data), [data]);
  const legs = useMemo(() => timelineChapters(chapters), [chapters]);
  const skipped = useMemo(() => skippedChapters(chapters), [chapters]);

  if (isLoading) {
    return (
      <SectionCard icon={<History className="h-4 w-4" />} title="Behind this material">
        <p className="text-sm text-muted">Loading this material&apos;s history…</p>
      </SectionCard>
    );
  }
  if (error) {
    return (
      <SectionCard
        tone="bad"
        icon={<History className="h-4 w-4" />}
        title="Behind this material"
      >
        <p className="text-sm text-bad">
          This material&apos;s history could not be loaded — the decision still works below.
        </p>
      </SectionCard>
    );
  }
  if (!data) return null;

  const total = data.documents.length;

  return (
    <SectionCard
      icon={<History className="h-4 w-4" />}
      title="Behind this material"
      subtitle="Where these items came from, and every document raised against them."
      aside={total > 0 ? (
        <span className="tabular rounded-full bg-content2 px-2.5 py-1 text-xs font-semibold text-muted">
          {total} {total === 1 ? "document" : "documents"}
        </span>
      ) : undefined}
      bodyClassName="p-0"
    >
      <div className="border-b border-line/70 bg-content2/30">
        <ProvenanceStrip data={data} />
        <div className="border-t border-line/60">
          {data.qc_rejected_tag && (
            /* Only drawn when TRUE. A row reading "No" is a fact nobody came looking for;
             * a row reading "Yes" changes the decision, so it is a warning and not a
             * value. */
            <div className="mx-5 mt-3.5 flex items-start gap-2 rounded-xl border border-bad/30 bg-bad-bg px-3.5 py-2.5 text-sm font-medium text-bad">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                These items were <strong>rejected at QC after the GRN</strong> — they failed
                the check on the way in, before the branch ever had them.
              </span>
            </div>
          )}
          <TrailFacts facts={summaryFacts(data)} />
        </div>
      </div>

      {total === 0 ? (
        <p className="px-5 py-5 text-sm text-muted">
          Nothing else in the system points at these items. The return itself is all there
          is.
        </p>
      ) : (
        <div className="space-y-3 px-5 py-4">
          <ul className="flex flex-wrap gap-1.5" aria-label="The legs this material travelled">
            {legs.map((chapter) => (
              <LegChip key={chapter.key} chapter={chapter} count={chapter.total} />
            ))}
          </ul>

          {skipped.length > 0 && (
            /* Named, never silently missing. On these returns it normally reads "Purchase
             * and Receipt", and it is the reason the row of chips above is four legs
             * rather than six. */
            <p className="text-xs text-muted">
              {listOf(skipped.map((chapter) => chapter.label))}{" "}
              {skipped.length === 1 ? "is" : "are"} not part of this trail — the material
              was served off stock the warehouse already held.
            </p>
          )}

          <Link
            to={`/returns/${returnId}/trail`}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-brand/25 bg-brand-050 px-4 text-sm font-semibold text-brand transition-colors hover:border-brand/45 hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 motion-reduce:transition-none"
          >
            View all {total} documents
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * The facts worth carrying on the summary, two of them as links.
 *
 * The indent and the material issue are the rows a desk opens on nearly every return, so
 * they are lifted out of the trail and put on the screen already addressed. Everything
 * else about them — their status, their date, who signed them — is one press away on the
 * full trail, which is the right place for it.
 *
 * The intent is deliberately absent: it is the trail's first row and it is already on the
 * document's own details panel, and the same sentence in three places on one screen is two
 * of them being scrolled past.
 */
export function summaryFacts(data: RelatedDocuments): TrailFact[] {
  const indent = firstOfType(data, "INDENT");
  const issue = firstOfType(data, "MATERIAL_ISSUE");
  const facts: TrailFact[] = [];

  if (indent?.doc_no) {
    facts.push({
      label: "Raised against",
      value: indent.doc_no,
      href: relatedDocumentLinks(indent).open,
      mono: true,
    });
  }
  if (data.material_issue_no) {
    facts.push({
      label: "Issued to the branch on",
      value: data.material_issue_no,
      // The served number is the authority; the link is whatever the trail resolved for
      // it, and is simply absent when the row behind it has gone.
      href: issue ? relatedDocumentLinks(issue).open : null,
      mono: true,
    });
  }
  facts.push({
    // The category is a coarse three-way filter over a chain of THREE rungs, so the rung
    // this document actually resolved to is served beside it (and says when it is a
    // fallback rather than a fact). Composing that sentence here would mean this screen
    // deciding what a stocking point is called, which `inventory.locations` already owns.
    label: "Purchase return filed as",
    value: data.purchase_return_category_label ?? "—",
    note: data.purchase_return_source_detail ?? undefined,
  });
  if (data.warehouse_return_no) {
    facts.push({
      label: "Warehouse document",
      value: data.warehouse_return_no,
      note: "Raised when the vehicle left",
      mono: true,
    });
  }
  return facts;
}

/** "Purchase and Receipt", "Purchase, Receipt and Issue" — a sentence, not a join. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
