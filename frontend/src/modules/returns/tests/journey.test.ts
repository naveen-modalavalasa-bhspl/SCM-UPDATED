import { describe, expect, it } from "vitest";
import {
  RETURN_JOURNEY_TRACKS, buildJourneyTracks, journeySteps, journeyTrackKey,
} from "../journeyModel";
import type { JourneyPhase, ReturnJourney, ReturnJourneyStage } from "../types";

const stage = (over: Partial<ReturnJourneyStage>): ReturnJourneyStage => ({
  event_id: null,
  sequence: 0,
  title: "Step",
  status: "COMPLETED",
  is_current: false,
  approver_name: null,
  position_name: null,
  timestamp: null,
  comments: null,
  stage_type: "approval",
  reference_no: null,
  quantity_summary: null,
  ...over,
});

const phase = (key: string, state: JourneyPhase["state"]): JourneyPhase => ({
  key,
  label: key,
  sequence: 1,
  state,
  caption: null,
});

const journey = (over: Partial<ReturnJourney> = {}): ReturnJourney => ({
  status: "PENDING_APPROVAL",
  phases: [],
  current_sequence: 1,
  current_stage_message: null,
  stages: [],
  history: [],
  ...over,
});

describe("return journey legs", () => {
  it("groups every step under the return's own leg, never an indent's", () => {
    // The legs a RETURN travels. An indent stage type has no home here on purpose: this
    // screen draws the return's decision desk and sign-off, not the request's ladder.
    expect(RETURN_JOURNEY_TRACKS.map((track) => track.key)).toEqual([
      "request", "decision", "sign_off", "approval", "logistics", "movement",
      "acknowledgement",
    ]);
    expect(journeyTrackKey("decision")).toBe("decision");
    expect(journeyTrackKey("sign_off")).toBe("sign_off");
    expect(journeyTrackKey("allocation")).toBe("activity");
  });

  it("splits what happened from what is still owed", () => {
    const steps = journeySteps(journey({
      stages: [
        stage({ stage_type: "draft", timestamp: "2026-09-01T10:00:00+05:30", sequence: 100 }),
        stage({ stage_type: "approval", status: "PENDING", sequence: 410, approver_name: "R Rao" }),
        stage({
          stage_type: "decision", status: "APPROVED", sequence: 210,
          timestamp: "2026-09-02T09:00:00+05:30",
        }),
        stage({ stage_type: "acknowledgement", status: "PENDING", sequence: 700 }),
      ],
    }));
    expect(steps.occurred.map((row) => row.stage_type)).toEqual(["draft", "decision"]);
    expect(steps.upcoming.map((row) => row.stage_type)).toEqual([
      "approval", "acknowledgement",
    ]);
  });

  it("keeps an undated completed leg inside its own leg rather than at the top", () => {
    // "Nothing to move" on an outcome that never travels is a fact about the journey and
    // has no press behind it. Sorted on time alone it would jump the whole timeline.
    const steps = journeySteps(journey({
      stages: [
        stage({ stage_type: "draft", timestamp: "2026-09-01T10:00:00+05:30", sequence: 100 }),
        stage({ stage_type: "logistics", title: "Logistics", sequence: 500 }),
        stage({
          stage_type: "decision", sequence: 200, timestamp: "2026-09-02T09:00:00+05:30",
        }),
      ],
    }));
    expect(steps.occurred.map((row) => row.stage_type)).toEqual([
      "draft", "decision", "logistics",
    ]);
  });

  it("names the person a leg is waiting on", () => {
    const tracks = buildJourneyTracks(journey({
      phases: [phase("approvals", "current")],
      stages: [stage({
        stage_type: "approval", status: "PENDING", is_current: true, sequence: 410,
        title: "Regional Manager", approver_name: "R Rao",
      })],
    }));
    const approval = tracks.find((track) => track.key === "approval");
    expect(approval?.state).toBe("CURRENT");
    expect(approval?.summary).toBe("Waiting at Regional Manager · R Rao");
  });

  it("clears a send-back once the corrected return went back up", () => {
    const sent = journey({
      phases: [phase("submitted", "completed")],
      stages: [
        stage({
          stage_type: "submission", status: "SUBMITTED", sequence: 150,
          title: "Submitted for approval", timestamp: "2026-09-01T10:00:00+05:30",
        }),
        stage({
          stage_type: "submission", status: "RETURNED", sequence: 151,
          title: "Sent back for correction", timestamp: "2026-09-02T10:00:00+05:30",
        }),
      ],
    });
    expect(buildJourneyTracks(sent).find((t) => t.key === "request")?.state)
      .toBe("RETURNED");

    const corrected = journey({
      ...sent,
      stages: [...(sent.stages ?? []), stage({
        stage_type: "submission", status: "SUBMITTED", sequence: 152,
        title: "Resubmitted after correction", timestamp: "2026-09-03T10:00:00+05:30",
      })],
    });
    expect(buildJourneyTracks(corrected).find((t) => t.key === "request")?.state)
      .toBe("COMPLETED");
  });

  it("returns every leg, including the ones nothing has reached yet", () => {
    const tracks = buildJourneyTracks(journey({
      phases: [phase("draft", "completed"), phase("movement", "pending")],
      stages: [stage({ stage_type: "draft", timestamp: "2026-09-01T10:00:00+05:30" })],
    }));
    expect(tracks.map((track) => track.key)).toEqual(
      RETURN_JOURNEY_TRACKS.map((track) => track.key),
    );
    expect(tracks.find((track) => track.key === "movement")?.summary)
      .toBe("Not started yet");
  });
});
