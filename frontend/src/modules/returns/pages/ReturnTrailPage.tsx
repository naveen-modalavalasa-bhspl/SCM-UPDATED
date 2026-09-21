import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@heroui/react";
import { ArrowLeft, Loader2, RefreshCw, SearchX } from "lucide-react";
import { Button, Card, SearchField } from "@/shared/components";
import { returnsApi } from "../api";
import { summaryFacts } from "../components/RelatedDocumentsSection";
import {
  LegChip, LegDot, ProvenanceStrip, TrailFacts, TrailRow, chapterIcon,
} from "../components/TrailChrome";
import {
  buildTrailChapters, filterTrailChapters, skippedChapters, timelineChapters,
  type TrailChapterGroup,
} from "../trailModel";

/**
 * Behind this material — the whole trail, on a page of its own.
 *
 * ## Why it is a page (2026-09-14)
 *
 * It used to be a panel on the return's detail screen. Eighteen kinds of document across a
 * dozen modules, twenty-six rows on a live return, sitting on a page that already carries
 * fourteen panels and a decision the reader came to take. Grouping it into legs made it
 * readable and did nothing about its SIZE: the desk still had to scroll a history to reach
 * a decision.
 *
 * The return's own journey made this call first (`ReturnJourneyPage`, and the indent's
 * before it) and for the same reason: a summary belongs beside the work, the full thing
 * belongs where it can be laid out properly. So the detail screen keeps the movement, the
 * two documents anybody opens and the shape of the trail, with one way in; this is the way
 * in, and it has room for what the panel could not show — every row, all legs open, a leg
 * index that follows the reader down the page, and a search.
 *
 * ## What it draws
 *
 * Nothing it decides. Every leg's NAME, the question it answers and the leg each document
 * belongs to are served (`returns/enums.py TRAIL_CHAPTERS`, `doc.chapter`); every row's
 * label is served with it. This page works out no document type of its own, so a type
 * added to the trail lands under a heading without it changing — the same property the
 * panel had, and the reason `TrailChrome` holds the drawing for both.
 *
 * Legs the material demonstrably skipped are named in a sentence rather than drawn. These
 * returns are stock coming home to the warehouse that issued it, so `Purchase` and
 * `Receipt` are empty on essentially all of them, and two permanent grey bands repeating
 * that on every return is not a fact being reported. A return whose material really was
 * bought shows them, with their documents in them — the rule is derived, not configured
 * (`trailModel.timelineChapters`).
 *
 * ## Who sees it
 *
 * `return.decide`, enforced by the endpoint. This is not a wider view of the return: it is
 * a dozen OTHER modules' documents, and each one is gated by its own module besides — a
 * row listed here is still unopenable by somebody with no right to that document.
 */
export default function ReturnTrailPage() {
  const { id } = useParams<{ id: string }>();
  const returnId = Number(id);
  const nav = useNavigate();
  /* Carried straight back, so the detail screen still knows which queue opened it — the
   * same contract `ReturnJourneyPage` keeps. */
  const { state } = useLocation();

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    // The same key the detail screen's summary uses, so opening this costs no second
    // fetch and the two zooms of the trail can never disagree.
    queryKey: ["returns", returnId, "related-documents"],
    queryFn: () => returnsApi.relatedDocuments(returnId),
    enabled: Number.isFinite(returnId),
    retry: false,
  });

  const [query, setQuery] = useState("");
  const all = useMemo(() => buildTrailChapters(data), [data]);
  const { groups, matches, active } = useMemo(
    () => filterTrailChapters(all, query),
    [all, query],
  );
  const legs = useMemo(() => timelineChapters(groups), [groups]);
  const skipped = useMemo(() => skippedChapters(groups), [groups]);

  const [current, setCurrent] = useState<string | null>(null);
  const bands = useRef(new Map<string, HTMLLIElement>());

  /**
   * Which leg the reader is standing in, so the index says where they are rather than only
   * where they could go.
   *
   * An observer rather than a scroll handler: the browser does the measuring off the main
   * thread, and a page of twenty-six rows would otherwise recompute every band's box on
   * every frame of a flick scroll. The top third of the viewport is the "reading line" —
   * a band is current once its head passes it, which is where a person's eye actually is,
   * not when it first peeps in at the bottom.
   */
  useEffect(() => {
    const nodes = [...bands.current.values()];
    // Knowing where the reader is standing is an ENHANCEMENT — the index still jumps,
    // still counts and still names every leg without it — so an environment that has no
    // observer loses the highlight rather than the page.
    if (nodes.length === 0 || typeof IntersectionObserver === "undefined") return undefined;
    const seen = new Set<string>();
    const watch = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const key = (entry.target as HTMLElement).dataset.leg;
        if (!key) return;
        if (entry.isIntersecting) seen.add(key);
        else seen.delete(key);
      });
      // The FIRST leg still on screen, in served order — so scrolling up and scrolling
      // down land on the same answer instead of the index flickering between two.
      const ordered = legs.find((leg) => seen.has(leg.key));
      setCurrent(ordered?.key ?? null);
    }, { rootMargin: "-12% 0px -66% 0px" });
    nodes.forEach((node) => watch.observe(node));
    return () => watch.disconnect();
  }, [legs]);

  const jumpTo = (key: string) => {
    bands.current.get(key)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (error) {
    return (
      <div className="space-y-4 rounded-xl border border-bad/30 bg-content1 p-5">
        <p className="text-sm font-semibold text-body">
          This material&apos;s history could not be loaded
        </p>
        <p className="break-words text-sm text-muted">{(error as Error).message}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => refetch()} disabled={isFetching}>
            {isFetching
              ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            {isFetching ? "Retrying…" : "Try again"}
          </Button>
          <Button variant="secondary" onClick={() => nav(`/returns/${returnId}`, { state })}>
            <ArrowLeft className="h-4 w-4" /> Back to return details
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading || !data) return <Skeleton className="h-64 rounded-2xl" />;

  const total = data.documents.length;

  return (
    <div className="min-w-0 space-y-5">
      <button
        type="button"
        onClick={() => nav(`/returns/${returnId}`, { state })}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-muted transition-colors hover:text-body motion-reduce:transition-none"
      >
        <ArrowLeft className="h-4 w-4" /> Back to return details
      </button>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              Behind this material
            </p>
            <h1 className="mono mt-1 break-words text-2xl font-semibold text-ink">
              {data.return_no ?? `Return ${returnId}`}
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm text-muted">
              Everything that happened to these items, from the day they were asked for to
              the day they came back.
            </p>
          </div>
          <span className="tabular rounded-full bg-content2 px-3 py-1.5 text-xs font-semibold text-muted">
            {total} {total === 1 ? "document" : "documents"}
          </span>
        </div>

        <div className="border-t border-line/70 bg-content2/30">
          <ProvenanceStrip data={data} />
          <div className="border-t border-line/60">
            <TrailFacts facts={summaryFacts(data)} />
          </div>
        </div>

        {data.qc_rejected_tag && (
          <p className="border-t border-line/70 bg-bad-bg px-5 py-3 text-sm font-medium text-bad">
            These items were <strong>rejected at QC after the GRN</strong> — they failed the
            check on the way in, before the branch ever had them.
          </p>
        )}

        {/* Only rendered when the server says a kind was capped — the normal case is a
          * complete trail and a permanent "there may be more" would read as one. */}
        {data.documents_note && (
          <p className="border-t border-line/70 bg-warn-bg/60 px-5 py-2.5 text-xs font-medium text-warn">
            {data.documents_note}
          </p>
        )}
      </Card>

      {total === 0 ? (
        <Card>
          <p className="px-5 py-6 text-sm text-muted">
            Nothing else in the system points at these items. The return itself is all there
            is.
          </p>
        </Card>
      ) : (
        <div className="grid min-w-0 gap-5 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start">
          <LegIndex
            legs={legs}
            skipped={skipped}
            current={current}
            query={query}
            onQuery={setQuery}
            onJump={jumpTo}
          />

          {active && matches === 0 ? (
            <Card>
              <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
                <SearchX className="h-6 w-6 text-muted" aria-hidden="true" />
                <p className="text-sm font-semibold text-ink">
                  No document on this trail matches “{query.trim()}”.
                </p>
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="min-h-11 text-xs font-semibold text-brand hover:underline"
                >
                  Show all {total} again
                </button>
              </div>
            </Card>
          ) : (
            <Card className="min-w-0 overflow-hidden">
              <ol
                className="px-4 py-3 sm:px-5 sm:py-4"
                aria-label="This material's history, leg by leg"
              >
                {legs.map((leg, index) => (
                  <LegBand
                    key={leg.key}
                    leg={leg}
                    index={index}
                    isLast={index === legs.length - 1}
                    register={(node) => {
                      if (node) bands.current.set(leg.key, node);
                      else bands.current.delete(leg.key);
                    }}
                  />
                ))}
              </ol>
              {skipped.length > 0 && (
                <p className="border-t border-line/70 px-5 py-3 text-xs text-muted">
                  {listOf(skipped.map((leg) => leg.label))}{" "}
                  {skipped.length === 1 ? "is" : "are"} not part of this trail — the material
                  was served off stock the warehouse already held, so no order was placed and
                  nothing was received against it.
                </p>
              )}
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The legs, down the side, following the reader.
 *
 * A column on a wide screen and a wrapped row of chips on a narrow one — the same control
 * either way, because a reader who learns it at a desk should not meet a different one on
 * a phone. Sticky from `lg` up, which is the whole reason a long trail is comfortable
 * here and was not in a panel: the index does not scroll away from the list it indexes.
 *
 * The search is part of it rather than a separate bar. Finding a document and choosing a
 * leg are the same job — narrowing twenty-six rows to the one in your hand — and splitting
 * them across two places on the page makes the reader decide which control they need
 * before they have decided what they are looking for.
 */
function LegIndex({
  legs, skipped, current, query, onQuery, onJump,
}: {
  legs: TrailChapterGroup[];
  skipped: TrailChapterGroup[];
  current: string | null;
  query: string;
  onQuery: (value: string) => void;
  onJump: (key: string) => void;
}) {
  return (
    <div className="min-w-0 lg:sticky lg:top-4">
      <Card className="overflow-hidden">
        <div className="p-3">
          <SearchField
            value={query}
            onChange={onQuery}
            placeholder="Find a document…"
            label="Search this material's history"
          />
        </div>

        {/* Wide: a list, one leg per row, with the reader's place marked. Narrow: the same
          * legs as chips, wrapped — a 240px column down the side of a phone is not a
          * column, it is a page nobody scrolls past. */}
        <ul
          className="flex flex-wrap gap-1.5 px-3 pb-3 lg:hidden"
          aria-label="The legs this material travelled"
        >
          {legs.map((leg) => (
            <LegChip
              key={leg.key}
              chapter={leg}
              count={leg.documents.length}
              active={current === leg.key}
              onJump={leg.documents.length > 0 ? () => onJump(leg.key) : undefined}
            />
          ))}
        </ul>

        <nav className="hidden border-t border-line/70 p-1.5 lg:block" aria-label="The legs this material travelled">
          <ul>
            {legs.map((leg) => (
              <LegNavRow
                key={leg.key}
                leg={leg}
                active={current === leg.key}
                onJump={() => onJump(leg.key)}
              />
            ))}
          </ul>
        </nav>

        {skipped.length > 0 && (
          <p className="hidden border-t border-line/70 px-3 py-2.5 text-[11px] leading-snug text-muted lg:block">
            Not on this trail: {listOf(skipped.map((leg) => leg.label))}.
          </p>
        )}
      </Card>
    </div>
  );
}

function LegNavRow({
  leg, active, onJump,
}: {
  leg: TrailChapterGroup;
  active: boolean;
  onJump: () => void;
}) {
  const Icon = chapterIcon(leg.key);
  const reachable = leg.documents.length;
  const lit = reachable > 0;

  return (
    <li>
      <button
        type="button"
        onClick={onJump}
        disabled={!lit}
        aria-current={active ? "true" : undefined}
        className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 motion-reduce:transition-none ${
          active ? "bg-brand-050 text-brand" : "text-ink hover:bg-content2"
        } ${lit ? "" : "cursor-default text-muted hover:bg-transparent"}`}
      >
        <Icon
          className={`h-4 w-4 shrink-0 ${lit ? (active ? "text-brand" : "text-muted") : "text-muted"}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{leg.label}</span>
        <span
          className={`tabular shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
            lit ? "bg-brand/10 text-brand" : "bg-content2 text-muted"
          }`}
        >
          {leg.state === "travelled" ? reachable : "–"}
        </span>
      </button>
    </li>
  );
}

/**
 * One leg of the material's life: the heading, the question it answers, and every document
 * under it on a continuous spine.
 *
 * Always open. There is nothing else on this page and no decision underneath it to reach,
 * which is the only thing collapsing ever bought — and a reader who pressed "view all
 * documents" has already said what they want. A leg the material has not reached yet is a
 * slim, quiet row and carries no spine below it, because there is nothing to connect to.
 */
function LegBand({
  leg, index, isLast, register,
}: {
  leg: TrailChapterGroup;
  index: number;
  isLast: boolean;
  register: (node: HTMLLIElement | null) => void;
}) {
  const empty = leg.documents.length === 0;
  return (
    <li ref={register} data-leg={leg.key} className="relative scroll-mt-4 pl-11">
      {/* The spine, coloured only as far as the material actually got — read off `state`,
        * never off what is currently on screen, so a search cannot redraw the history. */}
      {!isLast && (
        <span
          aria-hidden="true"
          className={`absolute bottom-0 left-[15px] top-9 w-0.5 ${
            leg.state === "travelled" ? "bg-brand/20" : "bg-line"
          }`}
        />
      )}
      <span className="absolute left-0 top-1.5">
        <LegDot chapterKey={leg.key} lit={leg.state === "travelled"} />
      </span>

      <div className={empty ? "py-2.5" : "pb-5 pt-1.5"}>
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h2
            className={`font-display text-[15px] font-bold leading-tight ${
              empty ? "text-muted" : "text-ink"
            }`}
          >
            {leg.label}
          </h2>
          <span className="tabular text-xs font-semibold text-muted">{leg.summary}</span>
        </div>
        {/* The question this leg answers — SERVED, and the reason a reader can tell an
          * Allocation from a Requisition without knowing either. */}
        {!empty && (
          <p className="mt-0.5 break-words text-xs text-muted">{leg.caption}</p>
        )}

        {!empty && (
          <ul className="mt-3 space-y-1.5">
            {leg.documents.map((doc, position) => (
              <TrailRow
                key={`${doc.doc_type}-${doc.doc_id ?? position}`}
                doc={doc}
                // The leg, then the place within it — so a reviewer quoting a row down a
                // phone has something to quote, and the number says which leg it came off
                // rather than counting to twenty-six.
                step={`${index + 1}.${position + 1}`}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/** "Purchase and Receipt", "Purchase, Receipt and Issue" — a sentence, not a join. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
