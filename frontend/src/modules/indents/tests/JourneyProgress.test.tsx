import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JourneyProgress } from "../components/JourneyProgress";
import { INDENT_JOURNEY_TRACKS } from "../journeyModel";
import type { JourneyTrack, JourneyTrackState } from "../journeyModel";

/** The six legs, with a state per leg — the shape `buildJourneyTracks` returns. */
function tracksWith(states: Partial<Record<string, JourneyTrackState>>): JourneyTrack[] {
  return INDENT_JOURNEY_TRACKS.map((definition) => ({
    ...definition,
    state: states[definition.key] ?? "PENDING",
    summary: `${definition.label} summary`,
    occurred: [],
    upcoming: [],
  }));
}

describe("JourneyProgress", () => {
  // The whole point of the strip: the timeline only draws legs something happened
  // in, so a reader could never see how far the request still had to travel.
  it("draws every leg, including the ones nothing has happened in yet", () => {
    render(<JourneyProgress tracks={tracksWith({
      request: "COMPLETED", approvals: "COMPLETED", allocation: "CURRENT",
    })} />);

    INDENT_JOURNEY_TRACKS.forEach((track) => {
      expect(screen.getAllByText(track.label).length).toBeGreaterThan(0);
    });
  });

  it("names the leg holding the indent, and how far along it is", () => {
    render(<JourneyProgress tracks={tracksWith({
      request: "COMPLETED", approvals: "COMPLETED", allocation: "COMPLETED",
      warehouse: "CURRENT",
    })} />);

    expect(screen.getByText("Step 4 of 6 · Warehouse")).toBeInTheDocument();
    // Once on the desktop rail's live line, once in the stacked mobile list: the
    // two layouts are both in the DOM and CSS picks between them.
    expect(screen.getAllByText("Warehouse summary")).toHaveLength(2);
  });

  it("reports a finished journey as complete rather than as a step", () => {
    const done = Object.fromEntries(
      INDENT_JOURNEY_TRACKS.map((track) => [track.key, "COMPLETED" as JourneyTrackState]),
    );
    render(<JourneyProgress tracks={tracksWith(done)} />);

    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  // A setback is not "step 2 of 6" — it is the flow stopping, and the strip has to
  // say so instead of pointing at whichever leg happens to be current.
  it("says where a rejected indent stopped", () => {
    render(<JourneyProgress tracks={tracksWith({
      request: "COMPLETED", approvals: "REJECTED",
    })} />);

    expect(screen.getByText("Stopped at Indent approvals")).toBeInTheDocument();
  });

  it("says where a returned indent was sent back", () => {
    render(<JourneyProgress tracks={tracksWith({
      request: "COMPLETED", approvals: "RETURNED",
    })} />);

    expect(screen.getByText("Sent back at Indent approvals")).toBeInTheDocument();
  });

  // `buildJourneyTracks` appends a catch-all leg for anything the contract grows
  // later. It is not a stage of the flow and must never draw a seventh dot.
  it("leaves the catch-all activity leg out of the rail", () => {
    const tracks: JourneyTrack[] = [
      ...tracksWith({ request: "COMPLETED" }),
      {
        key: "activity", label: "Other recorded activity", caption: "",
        stageTypes: [], phaseTitles: [], state: "COMPLETED",
        summary: "1 step recorded", occurred: [], upcoming: [],
      },
    ];
    render(<JourneyProgress tracks={tracks} />);

    expect(screen.queryByText("Other recorded activity")).not.toBeInTheDocument();
  });
});
