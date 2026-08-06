import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { eventsFile, runDir, type LogEvent } from "./logger.js";
import { ROOT } from "./config.js";

/**
 * Turns the raw event stream into one page a human reads instead of a tester's
 * verbal report: what the run did, what broke functionally, and every
 * non-functional complaint the browser made along the way.
 */
export default class SummaryReporter implements Reporter {
  private readonly results: { title: string; status: string; duration: number; error?: string }[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    this.results.push({
      title: test.title,
      status: result.status,
      duration: result.duration,
      error: result.error?.message?.split("\n").slice(0, 6).join("\n"),
    });
  }

  /** Every check the run made, grouped by the scenario that made it. */
  private checkRoster(checks: LogEvent[]): string[] {
    if (!checks.length) return ["No checks were recorded."];
    const byTest = new Map<string, LogEvent[]>();
    for (const event of checks) {
      byTest.set(event.test, [...(byTest.get(event.test) ?? []), event]);
    }
    const lines: string[] = [];
    for (const [title, events] of byTest) {
      const failed = events.filter((event) => event.level === "error").length;
      lines.push(`### ${title} — ${events.length - failed} passed, ${failed} failed`, "");
      let step: string | null | undefined;
      for (const event of events) {
        if (event.step !== step) {
          step = event.step;
          if (step) lines.push(`**${step}**`, "");
        }
        const outcome = event.level === "error" ? "FAIL" : "PASS";
        lines.push(`- \`${outcome}\` ${event.message.replace(/^(PASS|FAIL) — /, "")}`);
      }
      lines.push("");
    }
    return lines;
  }

  onEnd() {
    const path = eventsFile();
    const events: LogEvent[] = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as LogEvent)
      : [];

    const by = (kind: LogEvent["kind"]) => events.filter((event) => event.kind === kind);
    const failures = this.results.filter((r) => r.status !== "passed");

    const section = (title: string, rows: LogEvent[], render: (event: LogEvent) => string) =>
      rows.length
        ? [`### ${title} (${rows.length})`, "", ...rows.map((event) => `- ${render(event)}`), ""].join("\n")
        : `### ${title}\n\nNone.\n`;

    const checks = by("check").filter((event) => !event.message.startsWith("NOTE"));
    const failedChecks = checks.filter((event) => event.level === "error");
    const notes = by("check").filter((event) => event.message.startsWith("NOTE"));

    const lines = [
      "# Functional run report",
      "",
      `Run directory: \`${relative(ROOT, runDir())}\``,
      `Finished: ${new Date().toLocaleString()}`,
      "",
      "## Result",
      "",
      checks.length
        ? `**Checks: ${checks.length - failedChecks.length} passed, ${failedChecks.length} failed** (of ${checks.length}).`
        : "",
      "",
      ...this.results.map((r) =>
        `- **${r.status === "passed" ? "PASS" : "FAIL"}** — ${r.title} (${Math.round(r.duration / 1000)}s)`
        + (r.error ? `\n  \`\`\`\n  ${r.error.replace(/\n/g, "\n  ")}\n  \`\`\`` : ""),
      ),
      "",
      "## What the run did",
      "",
      ...by("step")
        .filter((event) => event.message.startsWith("✓") || event.message.startsWith("✗"))
        .map((event) => `- ${event.message}${event.durationMs ? ` _(${event.durationMs}ms)_` : ""}`),
      "",
      // Every check, passed and failed, grouped by scenario. A list of failures
      // alone tells you what broke but not what was actually covered, and "what
      // was covered" is the question a green run has to be able to answer.
      "## Every check, by scenario",
      "",
      ...this.checkRoster(checks),
      "",
      "## Findings",
      "",
      section("Failed functional checks", failedChecks, (e) =>
        `**${e.test}** › ${e.step ?? "-"} — ${e.message}`
        + `\n  \`\`\`\n  ${String((e.data as { detail?: string })?.detail ?? "").replace(/\n/g, "\n  ")}\n  \`\`\``),
      section("Observations", notes, (e) => `**${e.test}** — ${e.message.replace(/^NOTE — /, "")}`),
      section("JavaScript errors on the page", by("pageerror"), (e) => `${e.message} — \`${e.url}\``),
      section("Console errors and warnings", by("console"), (e) => `[${e.level}] ${e.message} — \`${e.url}\``),
      section("Failed API calls", [...by("http-error"), ...by("request-failed")], (e) =>
        `${e.message}${e.data && (e.data as { body?: string }).body ? `\n  > ${(e.data as { body: string }).body}` : ""}`),
      section("Slow responses", by("slow-request"), (e) => e.message),
      section("Slow screens", by("slow-page"), (e) => e.message),
      section("Accessibility violations", by("a11y"), (e) =>
        `${e.message} — \`${e.url}\`${e.data ? ` — ${(e.data as { nodes?: string[] }).nodes?.join(", ") ?? ""}` : ""}`),
      "",
      "## Screens captured",
      "",
      ...by("screenshot").map((e) => `- \`screens/${(e.data as { file: string }).file}\` — ${e.message}`),
      "",
    ];

    const summaryPath = resolve(runDir(), "summary.md");
    writeFileSync(summaryPath, lines.join("\n"), "utf8");

    const errorCount = events.filter((e) => e.level === "error").length;
    const warnCount = events.filter((e) => e.level === "warn").length;
    console.log(`\nReport: ${summaryPath}`);
    console.log(`  ${failures.length} failed test(s), ${errorCount} error event(s), ${warnCount} warning(s).`);
  }
}
