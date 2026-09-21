import { describe, expect, it } from "vitest";
import { roleOnly } from "../constants";

/**
 * The tracker shows the RANK a return is sitting with, not the person holding it — a rung
 * is a rank (CLAUDE.md rule 8) and a dot has ninety pixels of caption.
 *
 * This is a regex over strings the SERVER composes, which is exactly the kind of thing
 * that fails silently: widen it and a caption loses half its words, narrow it and the
 * tracker goes back to wrapping a full name over three lines. So every shape the journey
 * actually serves is pinned here.
 */
describe("roleOnly — the rank out of an approver label", () => {
  it("keeps the rank and drops the holder", () => {
    expect(roleOnly("MAHENDRA Y scm (SCM HEAD)")).toBe("SCM HEAD");
  });

  it("collapses two holders of one rank into that one rank", () => {
    expect(roleOnly("MAHENDRA Y scm (SCM HEAD), RAVI K (SCM HEAD)")).toBe("SCM HEAD");
  });

  it("keeps two different ranks, both of them", () => {
    expect(roleOnly("A B (Regional Manager), C D (SCM HEAD)"))
      .toBe("Regional Manager, SCM HEAD");
  });

  it("leaves a caption that names no approver exactly as served", () => {
    for (const caption of [
      "Raised",
      "10 Sep 2026",
      "1 signed",
      "Nothing to move",
      "Moves on the final approval",
      "Waiting for the decision desk",
      // The completed decision desk: a disposition, a name, and a send-back count, joined
      // with " · " and carrying no bracketed rank. Nothing here may be trimmed.
      "Scrap · MAHENDRA Y scm · sent back 2×",
      "TR-0012 — on the road",
    ]) {
      expect(roleOnly(caption)).toBe(caption);
    }
  });

  it("falls back to the desk's own name where no holder was resolved", () => {
    expect(roleOnly("Decision desk")).toBe("Decision desk");
  });

  it("is empty for nothing, never the string 'null'", () => {
    expect(roleOnly(null)).toBe("");
    expect(roleOnly(undefined)).toBe("");
    expect(roleOnly("")).toBe("");
  });
});
