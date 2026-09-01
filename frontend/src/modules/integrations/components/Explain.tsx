import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { ArrowRight, Check, ChevronRight, Sparkles } from "lucide-react";
import { Card, TONES, type Tone } from "@/shared/components";

/**
 * The two teaching surfaces this console was missing.
 *
 * Everything on these screens — application, endpoint, key, scope, webhook — is a
 * word from the integration trade, and the screen used none of its space to say what
 * any of them mean. An admin who has never built an API against SCM landed on a table
 * of codes and key counts and had to guess both the vocabulary and the ORDER of the
 * work. What the console does is not complicated; it was simply never stated.
 *
 * The first version stated it in prose: a paragraph, a `SCM → them` chip, and three
 * numbered boxes. Correct, and read by nobody — a wall of grey sentences at the top of
 * a screen is the thing a reader scrolls past to reach the table. So the fact the
 * paragraph carries is now DRAWN:
 *
 *   `FlowExplainer` — the two systems as two chips with a live wire between them, the
 *   packets travelling the way the data actually travels, and the CHECK that stands in
 *   the middle of that wire (the columns you ticked; the signature) drawn as the gate
 *   it is. Which way the arrow points and what the gate refuses are the only two facts
 *   that separate an application from a webhook, and both are legible in a glance
 *   without reading a word.
 *
 *   `Steps` — the order of the work, on a rail. Three numbers still, but joined, so
 *   they read as one job with three moves rather than three unrelated cards; the rail
 *   fills in as the moves are done, which is what makes the same component useful on
 *   a detail screen where the ticks are real.
 *
 * Both are read-outs. Nothing here fetches, decides or gates — they can be deleted
 * without changing what the console does, which is the test a teaching surface has to
 * pass.
 *
 * Motion: the packets are SVG `<animate>`, not CSS, so this module adds no keyframes
 * to the shared stylesheet (rule 4 — only the lead edits `src/shared` and `index.css`).
 * They stop dead for a reader who has asked the OS for less motion; the diagram is
 * drawn to be readable frozen, and the arrowheads carry the direction on their own.
 */

/** Has this reader asked their OS for less motion? The packets are decoration on top
 *  of a diagram that already reads without them, so the honest answer is to stop. */
function useStill() {
  const [still, setStill] = useState(
    () => typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setStill(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return still;
}

/** One end of the wire. Deliberately plain: a glyph, who it is, and one example, so
 *  "their system" stops being an abstraction and becomes the billing package the
 *  reader already has an opinion about. */
export interface FlowEnd {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** The line under the name — what kind of thing this actually is, in the reader's
   *  words rather than the trade's. */
  note: string;
}

function EndChip({ end, accent }: { end: FlowEnd; accent: boolean }) {
  const { icon: Icon } = end;
  return (
    <div
      className={`flex w-[5.5rem] shrink-0 flex-col items-center gap-1.5 rounded-2xl
                  border px-2 py-3 text-center sm:w-28 ${
        accent ? "border-brand/30 bg-brand-050/60" : "border-line/80 bg-content1"}`}
    >
      <span className={`grid h-9 w-9 place-items-center rounded-xl ${
        accent ? "bg-brand text-white" : "bg-content2 text-muted"}`}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="text-[11px] font-bold leading-tight text-ink">{end.label}</span>
      <span className="text-[10px] leading-tight text-muted">{end.note}</span>
    </div>
  );
}

/**
 * One half of the wire, with the packets on it.
 *
 * `forward` is the direction the DATA travels, which is not always the direction the
 * call is made in — an application dials SCM and the rows come back the other way, and
 * drawing the call rather than the payload is exactly the confusion this diagram
 * exists to end. The thin dotted line underneath is that other direction, drawn quiet
 * because it is the half nobody has to configure.
 */
function Wire({ forward, still }: { forward: boolean; still: boolean }) {
  // Three packets, evenly staggered over one trip, so the wire reads as a stream
  // rather than as a single dot somebody is watching cross an empty screen.
  const packets = [0, 1, 2];
  const trip = 2.4;
  return (
    <svg viewBox="0 0 120 34" className="h-9 w-full min-w-6 flex-1" role="presentation"
         preserveAspectRatio="none">
      <defs>
        <marker id="flow-head" markerWidth="6" markerHeight="6" refX="4" refY="3"
                orient="auto">
          <path d="M0 0 L6 3 L0 6 z" className="fill-brand" />
        </marker>
      </defs>
      {/* The lane the packets run in. Dashed, because a solid wire would be a claim
          that something is always crossing it — an integration called twice a day is
          the normal case here. */}
      <line x1={forward ? 2 : 118} y1="11" x2={forward ? 116 : 4} y2="11"
            className="stroke-brand/35" strokeWidth="2" strokeDasharray="5 4"
            strokeLinecap="round" markerEnd="url(#flow-head)" />
      {!still && packets.map((index) => (
        <circle key={index} cy="11" r="3.5" className="fill-brand">
          <animate attributeName="cx" values={forward ? "2;116" : "118;4"}
                   dur={`${trip}s`} begin={`${(index * trip) / 3}s`}
                   repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;1;1;0" dur={`${trip}s`}
                   begin={`${(index * trip) / 3}s`} repeatCount="indefinite" />
        </circle>
      ))}
      {/* The answer coming back. No packets on it: it is the half of the conversation
          this screen never asks anybody to set up. */}
      <line x1={forward ? 116 : 4} y1="24" x2={forward ? 4 : 116} y2="24"
            className="stroke-muted/40" strokeWidth="1.5" strokeDasharray="2 5"
            strokeLinecap="round" />
    </svg>
  );
}

/** The check standing in the middle of the wire — the one thing on this screen that
 *  decides whether a call or a push is allowed through, and the whole reason either
 *  kind of integration is safe to hand to an outsider. */
export interface FlowGate {
  icon: ComponentType<{ className?: string }>;
  label: string;
}

export interface FlowExplainerProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  /** Left of the wire. */
  from: FlowEnd;
  /** Right of the wire. */
  to: FlowEnd;
  /** True when the DATA travels left → right. False draws the whole wire the other
   *  way, arrowheads included. */
  forward: boolean;
  gate: FlowGate;
  /** The one sentence a reader who has never built an integration needs, in ordinary
   *  words. Drawn as the loudest line in the card on purpose. */
  plainly: string;
  /** The precise version, for the reader who is about to do the work. */
  children: ReactNode;
  tone?: Tone;
  /** The three moves. Rendered on the rail in the footer of this same card, because
   *  "what is it" and "what do I do" are one thought and were two boxes. */
  steps: Step[];
}

export function FlowExplainer({
  icon: Icon, title, from, to, forward, gate, plainly, children,
  tone = "brand", steps,
}: FlowExplainerProps) {
  const still = useStill();
  const { icon: GateIcon } = gate;

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="grid gap-x-6 gap-y-5 p-4 sm:p-5
                      lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)]">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl
                              ${TONES[tone]}`}>
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold leading-tight text-ink">
                {title}
              </h2>
              {/* The direction in words, beside the title, for the reader who scans
                  headings and never looks to the right of one. */}
              <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]
                               font-semibold uppercase tracking-wide text-muted">
                {forward ? from.label : to.label}
                <ArrowRight className="h-3 w-3 text-brand" />
                {forward ? to.label : from.label}
              </span>
            </div>
          </div>

          {/* The plain-words line. It is the only sentence on this screen written for
              somebody who does not work in software, so it gets the accent rule and
              the larger type instead of being buried inside the paragraph. */}
          <p className="mt-4 flex gap-2.5 border-l-2 border-signal/60 pl-3
                        font-display text-[15px] font-semibold leading-snug text-ink">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
            <span>{plainly}</span>
          </p>

          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-body">{children}</p>
        </div>

        {/* The same fact, drawn. */}
        <div className="min-w-0 rounded-2xl border border-line/70 bg-content2/40 p-3">
          <div className="flex items-center gap-1">
            <EndChip end={from} accent={forward} />
            <Wire forward={forward} still={still} />
            {/* The gate sits ON the wire, not beside it: everything crossing this
                diagram is checked here, and a badge in the corner would have read as
                a feature rather than as a barrier. */}
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full
                             border border-brand/40 bg-content1 text-brand shadow-sm">
              <GateIcon className="h-4 w-4" />
            </span>
            <Wire forward={forward} still={still} />
            <EndChip end={to} accent={!forward} />
          </div>
          <p className="mt-2.5 text-center text-[11px] leading-snug text-muted">
            <span className="font-semibold text-ink">{gate.label}</span>
            {" — everything else is refused."}
          </p>
        </div>
      </div>

      {/* Three moves, on the rail, inside the card that has just said what they are
          for: the reader's eye finishes the explanation and lands on the first thing
          to do without crossing a gap. */}
      <div className="border-t border-line/70 bg-content2/30 p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="font-display text-sm font-bold text-ink">
            Setting one up takes three moves
          </h3>
          <span className="text-xs text-muted">
            until all three are done it is not usable
          </span>
        </div>
        <Steps steps={steps} />
      </div>
    </Card>
  );
}

export interface Step {
  title: string;
  note: string;
  /** Drawn as done when known. Omitted entirely on a screen that lists many rows,
   *  where there is no single thing to be part-way through. */
  done?: boolean;
}

/**
 * The order of the work, on a rail.
 *
 * On a detail screen the ticks are real — they read the application's own counts — so
 * the rail doubles as "what is left to do here", and the connector between two done
 * steps is drawn in the done colour, so how far along a setup is can be read off the
 * shape without counting anything.
 */
export function Steps({ steps, className = "" }: { steps: Step[]; className?: string }) {
  // Only a rail that knows about doneness gets a counter. On the list screens every
  // step is unticked because there is no single row to be part-way through, and
  // "0 of 3 done" there would be a false statement about the whole console.
  const tracked = steps.some((step) => step.done !== undefined);
  const done = steps.filter((step) => step.done).length;

  return (
    <div className={className}>
      {tracked && (
        <div className="mb-3">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1
                            text-[11px] font-bold ${
            done === steps.length ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
            {done === steps.length && <Check className="h-3 w-3" />}
            {done} of {steps.length} done
          </span>
        </div>
      )}
      {/* `pb-5 sm:pb-0` leaves the phone layout room for the chevron that hangs off
          the bottom of each tile; on a wide screen the chevrons hang off the sides
          instead and the row needs no extra height. */}
      <ol className="grid gap-3 pb-5 sm:grid-cols-3 sm:pb-0">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          // The connector belongs to the step BEFORE it and takes the colour of the
          // crossing: green only once both of its ends are done, so a half-finished
          // setup never draws a rail that looks complete.
          const joined = step.done && steps[index + 1]?.done;
          return (
            <li
              key={step.title}
              className={`group relative rounded-2xl border p-3.5 transition-all
                          duration-200 sm:hover:-translate-y-0.5 ${
                step.done
                  ? "border-ok/30 bg-ok-bg/40"
                  : "border-line/70 bg-content1 shadow-[0_1px_2px_rgba(14,20,36,0.04)]"
                    + " sm:hover:border-brand/40"
                    + " sm:hover:shadow-[0_8px_20px_-12px_rgba(62,99,221,0.45)]"}`}
            >
              {/* A wash that only appears under the cursor. It is the whole hover
                  state: the tile warms, it does not jump colour. */}
              {!step.done && (
                <span aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-2xl
                                 bg-gradient-to-br from-brand-050 to-transparent
                                 opacity-0 transition-opacity duration-200
                                 group-hover:opacity-60" />
              )}

              <div className="relative flex items-start gap-3">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full
                                  text-xs font-bold text-white ring-4 transition-colors ${
                  step.done
                    ? "bg-gradient-to-br from-ok to-ok/80 ring-ok-bg"
                    : "bg-gradient-to-br from-brand to-brand-600 ring-brand-050"}`}>
                  {step.done ? <Check className="h-4 w-4" /> : index + 1}
                </span>
                <span className="min-w-0">
                  {/* The rung, said in two characters. It is what makes a tile read as
                      part of a sequence once the connectors are gone on a phone. */}
                  <span className={`block text-[10px] font-bold uppercase tracking-[0.14em] ${
                    step.done ? "text-ok" : "text-brand/70"}`}>
                    Step {index + 1}
                  </span>
                  <span className="mt-0.5 block font-display text-[15px] font-bold
                                   leading-tight text-ink">
                    {step.title}
                  </span>
                  <span className="mt-1.5 block text-xs leading-relaxed text-muted">
                    {step.note}
                  </span>
                </span>
              </div>

              {/* The connector, drawn as a chevron sitting IN the gap rather than as
                  a hairline behind the tiles: the gap is the only place a line could
                  go without cutting through the words, and a chevron there says
                  "then" in a way a rule cannot.

                  Two elements, one per breakpoint, rather than one that rotates:
                  the mobile chevron hangs off the BOTTOM and the desktop one off the
                  SIDE, and a single element would have needed two conflicting
                  translate utilities whose winner is decided by stylesheet order
                  rather than by the class list. */}
              {!last && (
                <>
                  <span aria-hidden
                        className={`absolute left-1/2 top-full z-10 -mt-1.5 grid h-6 w-6
                                    -translate-x-1/2 place-items-center rounded-full
                                    border bg-content1 shadow-sm sm:hidden ${
                          joined ? "border-ok/40 text-ok" : "border-line text-muted"}`}>
                    <ChevronRight className="h-3.5 w-3.5 rotate-90" />
                  </span>
                  <span aria-hidden
                        className={`absolute left-full top-1/2 z-10 -ml-1.5 hidden h-6 w-6
                                    -translate-y-1/2 place-items-center rounded-full
                                    border bg-content1 shadow-sm sm:grid ${
                          joined ? "border-ok/40 text-ok" : "border-line text-muted"}`}>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
