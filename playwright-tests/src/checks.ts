import type { RunLogger } from "./logger.js";

/**
 * A soft assertion that records instead of aborting.
 *
 * A manual tester who finds a broken button does not stop testing — they write it
 * down and carry on. A normal `expect` does stop, so a run that hits one defect
 * reports one defect and leaves the other forty screens unvisited. Every check
 * here is caught, logged as a finding, and the run continues; at the end of the
 * test `assertAllPassed()` fails once, listing everything that broke.
 *
 * Use a plain `expect` only for a precondition the rest of the test cannot survive
 * (a failed login, a missing indent id) — there, stopping is the honest outcome.
 */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface Checker {
  /** Runs the assertions, records the outcome, never throws. */
  (name: string, body: () => Promise<void> | void): Promise<boolean>;
  readonly results: CheckResult[];
  /** Notes something observed that is not pass/fail — context for the report. */
  note(message: string, data?: unknown): void;
  /** Fails the test once, with every failed check in one message. */
  assertAllPassed(): void;
}

function firstLines(message: string, count = 6) {
  return message.split("\n").slice(0, count).join("\n").trim();
}

export function checker(log: RunLogger): Checker {
  const results: CheckResult[] = [];

  const run = async (name: string, body: () => Promise<void> | void) => {
    try {
      await body();
      results.push({ name, ok: true });
      log.record({ kind: "check", level: "info", message: `PASS — ${name}` });
      return true;
    } catch (error) {
      const detail = firstLines((error as Error).message ?? String(error));
      results.push({ name, ok: false, detail });
      log.record({ kind: "check", level: "error", message: `FAIL — ${name}`, data: { detail } });
      return false;
    }
  };

  return Object.assign(run, {
    results,
    note(message: string, data?: unknown) {
      log.record({ kind: "check", level: "info", message: `NOTE — ${message}`, data });
    },
    assertAllPassed() {
      const failed = results.filter((result) => !result.ok);
      const passed = results.length - failed.length;
      log.info(`Checks: ${passed} passed, ${failed.length} failed, ${results.length} total.`);
      if (!failed.length) return;
      throw new Error(
        `${failed.length} of ${results.length} checks failed in this scenario:\n\n`
          + failed
            .map((result, index) => `${index + 1}. ${result.name}\n   ${(result.detail ?? "").replace(/\n/g, "\n   ")}`)
            .join("\n\n"),
      );
    },
  });
}
