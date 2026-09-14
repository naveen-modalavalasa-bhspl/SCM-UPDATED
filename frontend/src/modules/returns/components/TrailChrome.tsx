import type { ReactNode } from "react";
import {
  ArrowRight, ClipboardList, ExternalLink, FileText, Handshake, History, PackageCheck,
  PackageOpen, Route, ShoppingCart, Undo2,
} from "lucide-react";
import { StatusPill } from "@/shared/components";
import { relatedDocumentLinks } from "../documentLinks";
import type { TrailChapterGroup } from "../trailModel";
import type { RelatedDocument, RelatedDocuments } from "../types";

/**
 * The chrome the material's trail is drawn with — one leg marker, one chip, one document
 * row, one context band, defined once.
 *
 * The trail is read at two zooms: a summary on the return's own detail screen, and the
 * whole thing on `ReturnTrailPage`. Both are the same idea and neither may invent its own
 * idea of what a leg looks like, so everything visual lives here and each screen decides
 * only what it shows. Same reason `DetailChrome` exists, and it is a composition of
 * `@/shared/components` and the design tokens exactly as that one is — no shared primitive
 * is restyled here.
 *
 * ## The colour (2026-09-14)
 *
 * A travelled leg used to be a saturated `--color-step-done` disc: deep emerald, white
 * glyph, the same fill the progress steppers use. Wrong twice. It was DARK — six
 * bottle-green discs down a pale warm card, the heaviest thing on a screen showing
 * reference history — and green is this product's *status* colour, so it quietly said
 * "good" about a leg whose only claim is that it happened.
 *
 * It is the brand's own light wash now: `bg-brand-050` with a `text-brand` glyph, which is
 * what this application already uses everywhere something is lit but not shouting (the
 * admin banners, the audit chips, the policy tiles). Crimson on pale pink measures 5.1:1,
 * so it clears AA as text and not merely as a graphic, and it belongs to the warm ground
 * the page is painted on instead of sitting on top of it. Nothing on the trail is set in
 * a status colour any more: a document's STATUS is what `StatusPill` is for, and that is
 * now the only colour on a row that means anything.
 */

/**
 * A picture for each leg. Presentation only, and the one thing on the trail keyed on a
 * served key — a leg added to `TRAIL_CHAPTERS` draws the neutral fallback and loses
 * nothing a reader needs, because its NAME and its QUESTION both arrived with it.
 */
const CHAPTER_ICONS: Record<string, typeof ClipboardList> = {
  REQUEST: ClipboardList,
  COMMITMENT: Handshake,
  SOURCING: ShoppingCart,
  INBOUND: PackageCheck,
  OUTBOUND: PackageOpen,
  REVERSE: Undo2,
};

export const chapterIcon = (key: string) => CHAPTER_ICONS[key] ?? History;

/** Lit, or not. Two states rather than three: the WORDS say which kind of empty a leg is
 *  (`trailModel.summary`), and a third shade of grey would only make the reader guess at
 *  a distinction that is already written out beside it. */
const LIT = "border-brand/20 bg-brand-050 text-brand";
const QUIET = "border-dashed border-line bg-content1 text-muted";

/** One leg's marker: the disc on the spine, or the dot on a nav row. */
export function LegDot({
  chapterKey, lit, size = "md",
}: {
  chapterKey: string;
  lit: boolean;
  size?: "sm" | "md";
}) {
  const Icon = chapterIcon(chapterKey);
  const box = size === "sm" ? "h-6 w-6" : "h-8 w-8";
  const glyph = size === "sm" ? "h-3 w-3" : "h-4 w-4";
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full border ${box} ${lit ? LIT : QUIET}`}
    >
      <Icon className={glyph} />
    </span>
  );
}

/**
 * One leg as a chip: icon, name, count.
 *
 * `onJump` makes it a button — the whole point of the index on a long page. Without one it
 * is a plain span, because a leg with nothing to open has nowhere to go and a control that
 * does nothing when pressed is worse than no control.
 */
export function LegChip({
  chapter, count, onJump, active = false,
}: {
  chapter: TrailChapterGroup;
  /** What the reader can currently reach — the leg's size, or the matches under a
   *  search. Passed in rather than read off the group, so the caller decides which. */
  count: number;
  onJump?: () => void;
  active?: boolean;
}) {
  const Icon = chapterIcon(chapter.key);
  const lit = count > 0;
  const shell = "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold";
  const tone = lit ? `${LIT} text-ink` : QUIET;
  const body = (
    <>
      <Icon className={`h-3.5 w-3.5 shrink-0 ${lit ? "text-brand" : ""}`} aria-hidden="true" />
      <span className="whitespace-nowrap">{chapter.label}</span>
      <span
        className={`tabular rounded-full px-1.5 text-[10px] leading-[18px] ${
          lit ? "bg-brand/10 text-brand" : "bg-content2"
        }`}
      >
        {chapter.state === "travelled" ? count : "–"}
      </span>
    </>
  );

  if (!onJump) {
    return (
      <li>
        <span className={`${shell} ${tone}`} title={`${chapter.label} — ${chapter.summary}`}>
          {body}
          <span className="sr-only">— {chapter.summary}</span>
        </span>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={onJump}
        title={`${chapter.label} — ${chapter.summary}`}
        className={`${shell} ${tone} transition-colors hover:border-brand/45 hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 motion-reduce:transition-none ${
          active ? "ring-2 ring-brand/25" : ""
        }`}
      >
        {body}
        <span className="sr-only">— {chapter.summary}. Go to this leg.</span>
      </button>
    </li>
  );
}

/**
 * Where the material came from and where it is standing now, as one movement.
 *
 * Two long warehouse strings ("AP-104-MMU-Chilamathur -phc-AP39TL9499 - LIP") on separate
 * rows of a definition list left the reader working out which end was which. The arrow
 * says it without a word being added. Each end keeps its own qualifier, which is why this
 * is not `DetailChrome.RouteRibbon`: one end has to say WHAT document named it — a
 * resolved fact and a fallback guess look identical otherwise — and the other has to say
 * it can never be the destination.
 *
 * Drawn with no border of its own: it lives inside a band that already has one, and three
 * nested boxes is how a screen carrying one plain fact starts to feel like an interface.
 */
export function ProvenanceStrip({ data }: { data: RelatedDocuments }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-stretch">
      <div className="min-w-0 flex-1">
        <FieldLabel>Came from</FieldLabel>
        <div className="mt-0.5 break-words text-[13px] font-semibold leading-snug text-ink">
          {data.originating_warehouse_name ?? "—"}
        </div>
        <p className="mt-0.5 break-words text-xs text-muted">
          {data.originating_is_resolved && data.originating_source_doc
            ? `Named by ${data.originating_source_doc}`
            : "No document names it — this is only where the return was addressed"}
        </p>
      </div>
      <div aria-hidden="true" className="flex items-center justify-center sm:w-9 sm:shrink-0">
        <span className="h-px w-8 bg-line sm:hidden" />
        <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-050 text-brand ring-1 ring-brand/20">
          <ArrowRight className="h-3.5 w-3.5 rotate-90 sm:rotate-0" strokeWidth={2.5} />
        </span>
        <span className="h-px w-8 bg-line sm:hidden" />
      </div>
      <div className="min-w-0 flex-1">
        <FieldLabel>Standing now</FieldLabel>
        <div className="mt-0.5 break-words text-[13px] font-semibold leading-snug text-ink">
          {data.current_warehouse_name ?? "—"}
        </div>
        <p className="mt-0.5 text-xs text-muted">Never offered as the destination</p>
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">
      {children}
    </div>
  );
}

export interface TrailFact {
  label: string;
  value: string;
  /** Where the value opens, when it is a document rather than a description. */
  href?: string | null;
  note?: string | null;
  mono?: boolean;
}

/**
 * The handful of facts about the trail that are not themselves rows of it.
 *
 * A divided strip rather than a grid of `DetailChrome.Fact`s: the values are short and
 * unrelated, and a three-column definition list gave the longest of them — a filing rung
 * with its own explanatory sentence — a third of the card and made the two numbers beside
 * it look like a form somebody had left half filled in.
 *
 * A fact with an `href` is a LINK. The indent and the material issue are the two documents
 * a desk reaches for on nearly every return, and they were being printed as bare numbers
 * beside a list that held the openable copy — so the quickest way to the most-wanted row
 * on the screen was to scroll past it and find it again.
 */
export function TrailFacts({ facts }: { facts: TrailFact[] }) {
  if (facts.length === 0) return null;
  return (
    <dl className="flex flex-col gap-y-3 px-5 py-3.5 sm:flex-row sm:flex-wrap sm:gap-x-0">
      {facts.map((fact, index) => (
        <div
          key={fact.label}
          className={`min-w-0 flex-1 sm:px-4 sm:first:pl-0 sm:last:pr-0 ${
            index > 0 ? "sm:border-l sm:border-line/70" : ""
          }`}
        >
          <dt className="text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">
            {fact.label}
          </dt>
          <dd
            className={`mt-0.5 break-words text-[13px] font-semibold leading-snug ${
              fact.mono ? "mono" : ""
            }`}
          >
            {fact.href ? (
              <a
                href={fact.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-baseline gap-1 text-ink underline-offset-2 transition-colors hover:text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 motion-reduce:transition-none"
              >
                {fact.value}
                <ExternalLink className="h-3 w-3 shrink-0 self-center text-muted" aria-hidden="true" />
              </a>
            ) : (
              <span className="text-ink">{fact.value}</span>
            )}
          </dd>
          {fact.note && (
            <p className="mt-0.5 break-words text-xs leading-snug text-muted">{fact.note}</p>
          )}
        </div>
      ))}
    </dl>
  );
}

/**
 * The fallback name for a row whose `doc_label` did not arrive — a payload served by a
 * backend older than this screen. The live name is SERVED on the row
 * (`returns/enums.py TRAIL_LABELS`), because the same document is named by the trail, by
 * the journey screen and by a print sheet, and three copies of that map is how one of them
 * ends up calling a consignment a dispatch.
 */
const TYPE_LABELS: Record<string, string> = {
  INTENT: "Intent",
  INDENT: "Indent",
  ALLOCATION: "Material Allocation",
  MATERIAL_REQUEST: "Material Request",
  REQUISITION: "Requisition",
  RFQ: "RFQ",
  QUOTATION: "Vendor Quotation",
  PO: "Purchase Order",
  DESPATCH_NOTE: "Vendor Despatch Note",
  GRN: "GRN / Receipt",
  QC: "QC Inspection",
  PUTAWAY: "Putaway",
  PICKLIST: "Picklist",
  MATERIAL_ISSUE: "Material Issue",
  QC_OUTWARD: "Outward QC",
  CONSIGNMENT: "Consignment",
  SHIPMENT: "Shipment",
  PURCHASE_RETURN: "Purchase Return",
};

export const documentLabel = (doc: RelatedDocument) => (
  doc.doc_label ?? TYPE_LABELS[doc.doc_type] ?? doc.doc_type
);

/**
 * One document on the trail.
 *
 * **The document number is the link.** It used to be plain text beside a row of three
 * labelled buttons — seventy-eight buttons across a full trail — which puts the reader's
 * target next to, rather than on, the thing they are aiming at. The number opens the
 * document now; the two actions not every row has stay as icons beside the status.
 *
 * A row with no address at all renders as text and nothing else, which is not an omission:
 * the intent is a claim the return makes rather than a document, the vendor's despatch
 * note is read on the GRN it prefills, and an indent named only by a snapshotted number
 * has no row left to open. Each still earns its place — a number a reviewer can quote
 * beats a gap — and `documentLinks.ts` is the one file that decides which is which.
 */
export function TrailRow({ doc, step }: { doc: RelatedDocument; step?: string }) {
  const { open, print, journey } = relatedDocumentLinks(doc);
  const label = doc.doc_no ?? doc.doc_type;
  const meta = [doc.warehouse_name, doc.vendor_name, doc.date, doc.note].filter(Boolean);

  return (
    <li className="group flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-line bg-content1 px-3 py-2.5 transition-colors hover:border-brand/40 hover:bg-brand-050/40 motion-reduce:transition-none">
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        {step && (
          <span aria-hidden="true" className="tabular w-7 shrink-0 text-[11px] font-bold text-muted">
            {step}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="rounded bg-content2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
              {documentLabel(doc)}
            </span>
            {open ? (
              <a
                href={open}
                target="_blank"
                rel="noopener noreferrer"
                className="mono inline-flex min-w-0 items-center gap-1 text-sm font-semibold text-ink underline-offset-2 transition-colors hover:text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 motion-reduce:transition-none"
                aria-label={`Open ${label}`}
              >
                <span className="truncate">{doc.doc_no ?? "—"}</span>
                <ExternalLink
                  className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </a>
            ) : (
              <span className="mono truncate text-sm font-semibold text-ink">
                {doc.doc_no ?? "—"}
              </span>
            )}
          </div>
          {meta.length > 0 && (
            /* The qualifier LAST, after the facts every row carries, so the column of
               dates stays a column. */
            <div className="mt-0.5 break-words text-xs leading-snug text-muted">
              {meta.join(" · ")}
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {doc.status && <StatusPill status={doc.status} />}
        {journey && (
          <IconLink
            href={journey}
            icon={<Route className="h-4 w-4" />}
            /* First where a document has one. The reviewer's question about the indent
               under a returned carton is almost never "what were its lines" — it is "how
               did this branch come to have these units, and where did that request get
               to", which is the stage-by-stage screen and not the document. */
            label={`The complete journey of ${label}, stage by stage`}
            tone="text-brand hover:bg-brand/10"
          />
        )}
        {print && (
          <IconLink
            href={print}
            icon={<FileText className="h-4 w-4" />}
            label={`${label} as a PDF`}
          />
        )}
      </div>
    </li>
  );
}

/**
 * One icon action on a trail row.
 *
 * Icon-only, keeping the 44px target the rest of the product uses — the label lives in
 * `aria-label` and in the native tooltip, so a row carries the two actions not every
 * document has without the trail turning into a wall of words. Always visible rather than
 * revealed on hover: half this desk works on a touch screen, where there is no hover.
 *
 * Opens in a NEW tab, because the trail is read with a decision half written somewhere
 * else on the screen and navigating away throws that away.
 */
export function IconLink({
  href, icon, label, tone = "text-muted hover:bg-content2 hover:text-brand",
}: {
  href: string;
  icon: ReactNode;
  label: string;
  tone?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className={`grid h-11 w-9 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 motion-reduce:transition-none ${tone}`}
    >
      {icon}
    </a>
  );
}
