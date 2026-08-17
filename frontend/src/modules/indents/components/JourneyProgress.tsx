import { Check, Circle, Clock, Undo2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { INDENT_JOURNEY_TRACKS } from "../journeyModel";
import type { JourneyTrack, JourneyTrackState } from "../journeyModel";

/**
 * How far the indent has actually travelled, in one glance.
 *
 * `buildJourneyTracks` already returns EVERY leg — including the ones nothing has
 * happened in yet — but the timeline below only draws the legs with recorded steps,
 * so a reader could see where a request had been and never where it still had to go.
 * This is the other half: six fixed legs, one of them lit, so "where is it now" is
 * answered before anyone scrolls.
 *
 * Deliberately not a second timeline. It carries a state and a one-line summary per
 * leg and nothing else — the evidence, the actors and the timestamps stay in the
 * timeline, which is the thing that has room for them.
 */

const SHORT_LABEL: Record<string, string> = {
  request: "Raised",
  approvals: "Approved",
  allocation: "Allocated",
  warehouse: "Warehouse",
  delivery: "Dispatched",
  acknowledgement: "Received",
};

interface StateStyle {
  Icon: LucideIcon;
  /** The dot itself. */
  node: string;
  /** The rail arriving at this dot from the leg before it. */
  rail: string;
  label: string;
}

const STATE_STYLE: Record<JourneyTrackState, StateStyle> = {
  COMPLETED: {
    Icon: Check,
    node: "border-ok bg-ok text-white",
    rail: "bg-ok",
    label: "text-body",
  },
  CURRENT: {
    Icon: Clock,
    node: "border-brand bg-brand text-white ring-4 ring-brand/20",
    rail: "bg-ok",
    label: "text-ink font-bold",
  },
  PENDING: {
    Icon: Circle,
    node: "border-line bg-content2 text-muted",
    rail: "bg-line",
    label: "text-muted",
  },
  REJECTED: {
    Icon: X,
    node: "border-bad bg-bad text-white",
    rail: "bg-bad",
    label: "text-bad font-bold",
  },
  RETURNED: {
    Icon: Undo2,
    node: "border-warn bg-warn text-white",
    rail: "bg-warn",
    label: "text-warn font-bold",
  },
};

/** The headline over the rail: which leg holds it, or how it ended. */
function headline(tracks: JourneyTrack[]) {
  const stopped = tracks.find((track) => track.state === "REJECTED");
  if (stopped) return { text: `Stopped at ${stopped.label}`, tone: "text-bad" };
  const returned = tracks.find((track) => track.state === "RETURNED");
  if (returned) return { text: `Sent back at ${returned.label}`, tone: "text-warn" };
  const current = tracks.findIndex((track) => track.state === "CURRENT");
  if (current >= 0) {
    return {
      text: `Step ${current + 1} of ${tracks.length} · ${tracks[current].label}`,
      tone: "text-brand",
    };
  }
  const done = tracks.filter((track) => track.state === "COMPLETED").length;
  if (done === tracks.length) return { text: "Complete", tone: "text-ok" };
  return { text: `${done} of ${tracks.length} legs done`, tone: "text-muted" };
}

export function JourneyProgress({ tracks }: { tracks: JourneyTrack[] }) {
  // The catch-all "Other recorded activity" leg is not a stage of the flow — it is
  // where anything the contract grows later lands, and it must never draw a seventh
  // dot that no indent can ever reach.
  const known = new Set(INDENT_JOURNEY_TRACKS.map((track) => track.key));
  const legs = tracks.filter((track) => known.has(track.key));
  if (legs.length === 0) return null;

  const live = legs.find((track) => (
    track.state === "CURRENT" || track.state === "REJECTED" || track.state === "RETURNED"
  ));
  const { text, tone } = headline(legs);

  return (
    <section
      className="rounded-xl border border-line bg-content1 p-5 shadow-sm"
      aria-label="Indent progress"
    >
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Where this indent has reached
        </h2>
        <p className={`text-sm font-semibold ${tone}`}>{text}</p>
      </div>

      {/* Desktop: one rail, six dots. */}
      <ol className="hidden md:flex md:items-start">
        {legs.map((track, index) => {
          const style = STATE_STYLE[track.state];
          // A rail is lit by the leg it arrives AT: the segment left of this dot is
          // this leg's, the segment right of it belongs to the next one. Colouring
          // both from the current leg ran the tint one step past where the indent is.
          const railTo = (leg?: JourneyTrack) =>
            !leg || leg.state === "PENDING" ? "bg-line" : STATE_STYLE[leg.state].rail;
          return (
            <li
              key={track.key}
              className="flex min-w-0 flex-1 flex-col items-center text-center"
              title={track.caption}
            >
              <div className="flex w-full items-center">
                {/* Two half-rails per dot rather than one between each pair: it keeps
                    every leg the same width, so the labels line up under their dots. */}
                <span
                  className={`h-1 flex-1 rounded-full ${
                    index === 0 ? "bg-transparent" : railTo(track)}`}
                  aria-hidden
                />
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 transition ${style.node}`}
                >
                  <style.Icon className="h-4 w-4" />
                </span>
                <span
                  className={`h-1 flex-1 rounded-full ${
                    index === legs.length - 1
                      ? "bg-transparent"
                      : railTo(legs[index + 1])}`}
                  aria-hidden
                />
              </div>
              <p className={`mt-2 break-words px-1 text-xs leading-tight ${style.label}`}>
                {SHORT_LABEL[track.key] ?? track.label}
              </p>
            </li>
          );
        })}
      </ol>

      {/* The one line that says what is actually being waited on. */}
      {live && (
        <p className="mt-3 hidden break-words border-t border-line pt-3 text-center text-sm text-body md:block">
          {live.summary}
        </p>
      )}

      {/* Under 768px a horizontal rail is unreadable, so the same six legs stack. */}
      <ol className="space-y-2 md:hidden">
        {legs.map((track) => {
          const style = STATE_STYLE[track.state];
          return (
            <li key={track.key} className="flex items-start gap-3">
              <span
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 ${style.node}`}
              >
                <style.Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className={`break-words text-sm leading-tight ${style.label}`}>
                  {track.label}
                </p>
                <p className="break-words text-xs text-muted">{track.summary}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
