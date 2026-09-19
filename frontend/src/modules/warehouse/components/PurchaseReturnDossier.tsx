import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight, ClipboardList, CornerUpLeft, FileCheck2, FileText, IndianRupee,
  PackageCheck, ReceiptText, Send, ShieldCheck, ShoppingCart, Truck, Undo2,
} from "lucide-react";
import { EmptyState, StatusPill } from "@/shared/components";
import { fmtDate, fmtDateTime } from "../format";
import type {
  PurchaseReturnJourneyLeg, PurchaseReturnTimelineEvent, PurchaseReturnTrailDoc,
} from "../types";

/**
 * The two halves of a purchase return's dossier: the PAPER TRAIL behind it and the
 * HISTORY of what has happened to it.
 *
 * Both render rows the server shaped (`GET /warehouse/returns/{id}/dossier`) and work
 * nothing out of their own — which document types exist, what each row's facts are,
 * what order they come in and where each one lives in the app are all decisions taken
 * once in `warehouse.service._dossier_documents`. A screen that re-derived any of that
 * would drift from the register the day either changed.
 *
 * WHY A SPINE AND NOT A TABLE. A purchase return raised off a branch consignment sits
 * at the join of two stories — how the material was bought, and how it came back — and
 * a flat table of eleven documents makes the reader reconstruct that join from the
 * document numbers. The rail draws it: one continuous line, three labelled legs, and
 * the return itself as the station where the two meet.
 */

/* --------------------------------------------------------------- paper trail -- */

const DOC_ICONS: Record<string, typeof FileText> = {
  INDENT: FileText,
  REQUISITION: ClipboardList,
  RFQ: Send,
  QUOTATION: FileCheck2,
  PO: ShoppingCart,
  GRN: PackageCheck,
  VENDOR_INVOICE: ReceiptText,
  QC: ShieldCheck,
  BRANCH_RETURN: Undo2,
  TRANSPORT_REQUEST: Truck,
  PURCHASE_RETURN: CornerUpLeft,
  DISPATCH: Send,
  CREDIT_NOTE: IndianRupee,
};

/**
 * The three legs, in the order the material actually moved, each with its own accent.
 *
 * The accents are the semantic tokens (`info`, `brand`, `ok`) and not new hexes: this
 * screen has a dark theme and a hardcoded colour here would be the one thing on it
 * that does not follow the toggle.
 */
const LEGS: { key: string; title: string; caption: string; accent: string; dot: string }[] = [
  {
    key: "PURCHASE",
    title: "How it was bought",
    caption: "The purchase this return is argued against",
    accent: "text-info",
    dot: "bg-info-bg text-info ring-info/25",
  },
  {
    key: "RETURN",
    title: "How it came back",
    caption: "The material's journey back to this warehouse",
    accent: "text-brand",
    dot: "bg-brand-050 text-brand ring-brand/25",
  },
  {
    key: "DOCUMENT",
    title: "This document, and what leaves on it",
    caption: "The purchase return itself",
    accent: "text-ok",
    dot: "bg-ok-bg text-ok ring-ok/25",
  },
];

function TrailStation({ doc }: { doc: PurchaseReturnTrailDoc }) {
  const Icon = DOC_ICONS[doc.doc_type] ?? FileText;
  const leg = LEGS.find((l) => l.key === doc.leg) ?? LEGS[0];

  const body = (
    <div className="min-w-0 flex-1 rounded-xl border border-line/70 bg-content1 p-3 transition
                    group-hover:border-brand/40 group-hover:shadow-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`text-[10px] font-bold uppercase tracking-widest ${leg.accent}`}>
          {doc.doc_label}
        </span>
        {doc.status && <StatusPill status={doc.status} />}
        {/* Said on the ROW, not once at the top: on a return raised off a branch
            consignment the buying leg is read off the stock and the return leg is the
            document's own, and the reader has to see which is which. */}
        {doc.traced && (
          <span className="rounded-full bg-warn-bg px-2 py-0.5 text-[10px] font-semibold uppercase
                           tracking-wider text-warn">
            traced
          </span>
        )}
        {doc.route && (
          <ArrowUpRight className="ml-auto h-4 w-4 shrink-0 text-muted opacity-0 transition
                                   group-hover:opacity-100" />
        )}
      </div>

      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3">
        <span className="font-mono text-sm font-semibold text-ink">{doc.doc_no ?? "—"}</span>
        {doc.doc_date && (
          <span className="text-xs text-muted">{fmtDate(doc.doc_date)}</span>
        )}
        {doc.party && <span className="truncate text-xs text-body">{doc.party}</span>}
      </div>

      {doc.facts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {doc.facts.map(([label, value]) => (
            <span key={label}
                  className="rounded-md bg-content2 px-2 py-1 text-[11px] leading-none text-body">
              <span className="text-muted">{label} </span>
              <span className="font-medium text-ink">{value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <li className="group relative flex gap-3 pb-3 last:pb-0">
      <span className={`relative z-10 mt-1 flex h-8 w-8 shrink-0 items-center justify-center
                        rounded-full ring-4 ring-content1 ${leg.dot}`}>
        <Icon className="h-4 w-4" />
      </span>
      {doc.route
        ? <Link to={doc.route} className="flex min-w-0 flex-1">{body}</Link>
        : body}
    </li>
  );
}

export function PurchaseReturnTrail({ documents, note }: {
  documents: PurchaseReturnTrailDoc[];
  note?: string | null;
}) {
  if (documents.length === 0) {
    return (
      <EmptyState
        title="No trail behind this return"
        hint="Nothing links this document to a purchase yet. Use Edit to pick the Purchase Invoice / PO it was bought on."
      />
    );
  }

  return (
    <div>
      {note && (
        <p className="mb-4 rounded-xl border border-warn/30 bg-warn-bg px-3 py-2 text-xs text-warn">
          {note}
        </p>
      )}
      <div className="space-y-6">
        {LEGS.map((leg) => {
          const rows = documents.filter((doc) => doc.leg === leg.key);
          if (rows.length === 0) return null;
          return (
            <section key={leg.key}>
              <div className="mb-2 flex items-baseline gap-2">
                <h4 className={`text-xs font-bold uppercase tracking-widest ${leg.accent}`}>
                  {leg.title}
                </h4>
                <span className="text-[11px] text-muted">{leg.caption}</span>
              </div>
              {/* The rail: one line down the middle of the dots, drawn behind them.
                  A real element rather than a `before:` pseudo — the dots sit at
                  z-10 over it, and an element is one less Tailwind variant to be
                  wrong about. */}
              <ol className="relative">
                <span aria-hidden
                      className="absolute left-4 top-3 bottom-3 w-px bg-line" />
                {rows.map((doc, index) => (
                  <TrailStation key={`${doc.doc_type}-${doc.doc_id ?? doc.doc_no ?? index}`}
                                doc={doc} />
                ))}
              </ol>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- journey -- */

/**
 * THE JOURNEY — where this return has got to, leg by leg.
 *
 * A vertical timeline rather than the horizontal chip rail the leg band draws, and
 * deliberately a different shape: the rail answers "roughly where is this" at a glance
 * above the action, and this answers "what happened at each step, when, and who did it"
 * for somebody who came to the document to find out.
 *
 * EVERY LEG IS DRAWN, including the ones this particular return will never reach — a
 * refund never travels, and that leg says so rather than being dropped. A tracker that
 * hid steps per document would describe a different process on every screen.
 *
 * The legs, their order, their wording and their state are all SERVED. Nothing here
 * decides what the flow is.
 */
const JOURNEY_TONE: Record<string, { dot: string; text: string; ring: string }> = {
  completed: { dot: "bg-ok", text: "text-body", ring: "ring-ok/30" },
  current: { dot: "bg-warn", text: "text-body font-semibold", ring: "ring-warn/40" },
  rejected: { dot: "bg-bad", text: "text-bad", ring: "ring-bad/30" },
  cancelled: { dot: "bg-line", text: "text-muted", ring: "ring-line" },
  pending: { dot: "bg-line", text: "text-muted", ring: "ring-line" },
};

export function PurchaseReturnJourney({ legs, message, sequence }: {
  legs: PurchaseReturnJourneyLeg[];
  message?: string | null;
  sequence?: number;
}) {
  if (legs.length === 0) {
    return (
      <EmptyState
        title="No journey yet"
        hint="Once this return is sent to the vendor, every step it takes appears here."
      />
    );
  }
  return (
    <div className="space-y-4">
      {message && (
        <p className="rounded-xl border border-line bg-content2/60 px-4 py-3 text-sm
                      text-body">
          <span className="font-semibold">
            Step {sequence ?? 1} of {legs.length}
          </span>{" "}
          — {message}
        </p>
      )}
      <ol className="relative space-y-0 border-l border-line pl-6">
        {legs.map((leg) => {
          const tone = JOURNEY_TONE[leg.state] ?? JOURNEY_TONE.pending;
          return (
            <li key={leg.key} className="relative pb-5 last:pb-0">
              <span
                aria-hidden
                className={`absolute -left-[30px] top-1 h-3 w-3 rounded-full ring-4
                            ring-content1 ${tone.dot}`}
              />
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className={`text-sm ${tone.text} ${
                  leg.state === "cancelled" ? "line-through" : ""}`}>
                  {leg.label}
                </p>
                {leg.at && (
                  <span className="text-xs text-muted">{fmtDateTime(leg.at)}</span>
                )}
              </div>
              {leg.detail && (
                <p className="mt-0.5 text-xs text-muted">{leg.detail}</p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {leg.actor_name && (
                  <span className="rounded-full bg-content2 px-2 py-0.5 text-[11px]
                                   text-body">
                    {leg.actor_name}
                  </span>
                )}
                {leg.reference_no && (
                  <span className="rounded-full border border-line px-2 py-0.5
                                   text-[11px] font-medium text-body">
                    {leg.reference_no}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------- history -- */

/** Which document an event happened on, so a merged trail still reads as several. */
const ENTITY_LABELS: Record<string, { label: string; className: string }> = {
  pro_returns: { label: "This return", className: "bg-ok-bg text-ok" },
  inv_sto: { label: "Branch return", className: "bg-brand-050 text-brand" },
  lgs_transport_requests: { label: "Consignment", className: "bg-info-bg text-info" },
  wf_actions: { label: "Approval", className: "bg-warn-bg text-warn" },
};

/** Initials for the actor's chip. Two letters, never more — it is a 28px circle. */
const initials = (name?: string | null) =>
  (name ?? "?")
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

const dayKey = (at?: string | null) => (at ? at.slice(0, 10) : "");

export function PurchaseReturnHistory({ events }: {
  events: PurchaseReturnTimelineEvent[];
}) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="Nothing recorded yet"
        hint="Every approval, dispatch and signature on this return and on the return that caused it will appear here."
      />
    );
  }

  // Grouped by day, oldest first — the order the server sent them in. A run of eleven
  // events inside two minutes is normal here (a gate-out fires several at once), so
  // the day heading carries the date and each row carries only the time.
  const days: { day: string; rows: PurchaseReturnTimelineEvent[] }[] = [];
  for (const event of events) {
    const key = dayKey(event.at);
    const last = days[days.length - 1];
    if (last && last.day === key) last.rows.push(event);
    else days.push({ day: key, rows: [event] });
  }

  return (
    <div className="space-y-5">
      {days.map(({ day, rows }) => (
        <section key={day || "undated"}>
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-full bg-content2 px-2.5 py-1 text-[11px] font-semibold text-body">
              {day ? fmtDate(day) : "Undated"}
            </span>
            <span className="h-px flex-1 bg-line" />
            <span className="text-[11px] text-muted">{rows.length} event(s)</span>
          </div>

          <ol className="relative space-y-3 border-l border-line pl-6">
            {rows.map((event, index) => {
              const entity = ENTITY_LABELS[event.entity]
                ?? { label: event.entity, className: "bg-content2 text-body" };
              return (
                <li key={`${event.entity}-${event.at}-${index}`} className="relative">
                  <span className="absolute -left-[31px] flex h-7 w-7 items-center justify-center
                                   rounded-full bg-content2 text-[10px] font-bold text-body
                                   ring-4 ring-content1">
                    {initials(event.actor_name)}
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold text-ink">{event.title}</span>
                    {event.status_to && <StatusPill status={event.status_to} />}
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase
                                      tracking-wider ${entity.className}`}>
                      {entity.label}
                    </span>
                    <span className="ml-auto whitespace-nowrap text-[11px] text-muted">
                      {event.at ? fmtDateTime(event.at) : "—"}
                    </span>
                  </div>
                  <div className="text-xs text-muted">
                    {[event.actor_name ?? "—", event.doc_no].filter(Boolean).join(" · ")}
                  </div>
                  {event.detail && (
                    <p className="mt-1 break-words text-xs text-body">{event.detail}</p>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------- small shared bits -- */

/** One labelled value. The dash is deliberate: a blank reads as a rendering fault. */
export function Fact({ label, children, wide = false }: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-0.5 break-words text-sm text-ink">{children ?? "—"}</div>
    </div>
  );
}

/** A titled cluster of facts. Grouping is what keeps a thirty-field screen readable. */
export function FactGroup({ title, icon, children }: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line/70 bg-content1 p-4">
      <h4 className="mb-3 flex items-center gap-1.5 text-[11px] font-bold uppercase
                     tracking-widest text-muted">
        {icon}
        {title}
      </h4>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">{children}</div>
    </section>
  );
}
