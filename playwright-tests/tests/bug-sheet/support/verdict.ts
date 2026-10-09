import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { checker, type CheckResult, type Checker } from "../../../src/checks.js";
import type { RunLogger } from "../../../src/logger.js";
import { runDir } from "../../../src/logger.js";
import type { Bug } from "./bugs.js";

/**
 * One bug, one verdict.
 *
 * The question this suite answers is not "does the app work" — the other suites
 * ask that. It is "is bug X still there", asked of each row of the bug sheet, and
 * the answer has to be legible to somebody who will never open a Playwright
 * report. So every scenario writes a single record, and a reporter turns the
 * records into one list of ids against FIXED / NOT FIXED.
 *
 * The distinctions matter more than they look:
 *
 * - **NOT FIXED** — the defect reproduced. The check that reproduced it is named.
 * - **PARTIALLY FIXED** — some of the reported symptoms are gone, some are not.
 *   A bug sheet row is usually several complaints in one sentence; collapsing
 *   that to a single boolean is how "fixed" gets claimed too early.
 * - **BLOCKED** — the run could not get far enough to tell. This is *not* a pass.
 *   The commonest way a regression suite lies is by failing to set up, catching
 *   the error, and reporting green.
 * - **NOT VERIFIED** — a spec exists but asserted nothing. Visible on purpose, so
 *   a placeholder cannot be mistaken for coverage.
 */
export type Verdict = "FIXED" | "NOT FIXED" | "PARTIALLY FIXED" | "BLOCKED" | "NOT VERIFIED";

export interface BugVerdict {
  ts: string;
  id: string;
  title: string;
  module?: string;
  severity?: string;
  /** What the sheet claims the state is, so the log can flag disagreement. */
  sheetStatus?: string;
  fromSheet: boolean;
  verdict: Verdict;
  checks: CheckResult[];
  notes: string[];
  blockedReason?: string;
  evidence: string[];
}

export const verdictsFile = () => resolve(runDir(), "bug-verdicts.jsonl");

/**
 * Records the outcome of verifying one bug.
 *
 * Checks are soft — the same reasoning as `src/checks.ts`. A bug sheet row often
 * lists three symptoms; stopping at the first one that still reproduces would
 * leave the other two unknown, and "unknown" is exactly what the person reading
 * the log is trying to get rid of.
 */
export class BugTracker {
  private bug: Bug | null = null;
  private readonly notes: string[] = [];
  private readonly evidence: string[] = [];
  private blockedReason?: string;
  private checks: Checker;

  constructor(private readonly log: RunLogger) {
    this.checks = checker(log);
  }

  /** Names the bug this scenario is about. Called by `bugSpec`. */
  about(bug: Bug) {
    this.bug = bug;
    this.log.info(`Verifying ${bug.id} — ${bug.title}`, {
      module: bug.module,
      severity: bug.severity,
      sheetStatus: bug.status,
      fromSheet: bug.fromSheet,
    });
    if (bug.steps) this.log.info(`Reported steps: ${bug.steps}`);
    if (bug.expected) this.log.info(`Reported expectation: ${bug.expected}`);
  }

  /**
   * One symptom from the bug report, asserted.
   *
   * Phrase `name` as the fixed behaviour, not the defect — the log reads
   * "PASS — a draft cannot be submitted twice", which says what is true now. A
   * name like "double submit bug" reads as a pass for the bug still existing.
   */
  check(name: string, body: () => Promise<void> | void) {
    return this.checks(name, body);
  }

  /** Context for the log that is not pass/fail — a count, an id, a status seen. */
  note(message: string, data?: unknown) {
    this.notes.push(message);
    this.checks.note(message, data);
  }

  /** A screenshot, response body or URL worth keeping next to the verdict. */
  attach(description: string) {
    this.evidence.push(description);
  }

  /** The run could not reach the point where the bug would show. */
  blocked(reason: string) {
    this.blockedReason = reason;
    this.log.problem("assert", `BLOCKED — ${this.bug?.id ?? "bug"}: ${reason}`);
  }

  get verdict(): Verdict {
    if (this.blockedReason) return "BLOCKED";
    const results = this.checks.results;
    if (!results.length) return "NOT VERIFIED";
    const failed = results.filter((result) => !result.ok).length;
    if (!failed) return "FIXED";
    return failed === results.length ? "NOT FIXED" : "PARTIALLY FIXED";
  }

  /**
   * Writes the record. Runs in fixture teardown, so a scenario that throws
   * halfway still leaves a verdict behind — a crashed spec must appear in the log
   * as BLOCKED, never as a gap.
   */
  flush() {
    if (!this.bug) return;
    const record: BugVerdict = {
      ts: new Date().toISOString(),
      id: this.bug.id,
      title: this.bug.title,
      module: this.bug.module,
      severity: this.bug.severity,
      sheetStatus: this.bug.status,
      fromSheet: this.bug.fromSheet,
      verdict: this.verdict,
      checks: this.checks.results,
      notes: this.notes,
      blockedReason: this.blockedReason,
      evidence: this.evidence,
    };
    appendFileSync(verdictsFile(), `${JSON.stringify(record)}\n`, "utf8");
    this.log.info(`Verdict for ${record.id}: ${record.verdict}`);
  }

  /**
   * Fails the scenario unless the bug is gone.
   *
   * A still-present bug is a red test, not a quiet line in a file — otherwise
   * `npm test` stays green while the sheet fills up, and nobody looks at the log.
   */
  assertFixed() {
    const verdict = this.verdict;
    if (verdict === "FIXED") return;
    const id = this.bug?.id ?? "bug";
    if (verdict === "BLOCKED") {
      throw new Error(`${id} could not be verified — ${this.blockedReason}`);
    }
    if (verdict === "NOT VERIFIED") {
      throw new Error(`${id} has a spec but it asserted nothing, so nothing is known about it.`);
    }
    const failed = this.checks.results.filter((result) => !result.ok);
    throw new Error(
      `${id} is ${verdict} — ${failed.length} of ${this.checks.results.length} symptom(s) still reproduce:\n\n`
        + failed
          .map((result, index) => `${index + 1}. ${result.name}\n   ${(result.detail ?? "").replace(/\n/g, "\n   ")}`)
          .join("\n\n"),
    );
  }
}
