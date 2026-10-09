import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Reporter } from "@playwright/test/reporter";
import { runDir } from "./logger.js";
import { config, ROOT } from "./config.js";
import type { BugVerdict } from "../tests/bug-sheet/support/verdict.js";

/**
 * The bug sheet's answer sheet.
 *
 * `summary.md` is the functional run report — everything the run touched. This is
 * a different document for a different reader: one line per bug id saying FIXED
 * or NOT FIXED, and nothing else at the top. It is written separately, and to a
 * stable path as well as the run folder, so the question "which of these are
 * actually fixed" can be answered by opening one file that is always in the same
 * place.
 *
 * Silent when a run produced no verdicts, so the other suites do not leave an
 * empty bug report behind.
 */
export default class BugStatusReporter implements Reporter {
  onEnd() {
    const path = resolve(runDir(), "bug-verdicts.jsonl");
    if (!existsSync(path)) return;

    const verdicts = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BugVerdict);
    if (!verdicts.length) return;

    // A retry re-verifies the same bug; the last word is the one that counts.
    const latest = new Map<string, BugVerdict>();
    for (const verdict of verdicts) latest.set(verdict.id.toUpperCase(), verdict);
    const rows = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

    const count = (verdict: BugVerdict["verdict"]) => rows.filter((row) => row.verdict === verdict).length;
    const MARK: Record<BugVerdict["verdict"], string> = {
      FIXED: "✅ FIXED",
      "NOT FIXED": "❌ NOT FIXED",
      "PARTIALLY FIXED": "⚠️ PARTIALLY FIXED",
      BLOCKED: "🚧 BLOCKED",
      "NOT VERIFIED": "❔ NOT VERIFIED",
    };

    const lines: string[] = [
      "# Bug sheet — verification status",
      "",
      `Run: \`${relative(ROOT, runDir())}\``,
      `Finished: ${new Date().toLocaleString()}`,
      `Against: ${config.baseURL} (API ${config.apiURL})`,
      "",
      "## Verdicts",
      "",
      `**${count("FIXED")} fixed · ${count("NOT FIXED")} not fixed · ${count("PARTIALLY FIXED")} partial`
        + ` · ${count("BLOCKED")} blocked · ${count("NOT VERIFIED")} not verified** — ${rows.length} bug(s) checked.`,
      "",
      "| Bug | Title | Module | Verdict | Sheet says | Symptoms passed |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows.map((row) => {
        const passed = row.checks.filter((check) => check.ok).length;
        const cell = (text?: string) => (text ?? "—").replace(/\|/g, "\\|").replace(/\n+/g, " ");
        return `| \`${row.id}\` | ${cell(row.title)} | ${cell(row.module)} | ${MARK[row.verdict]}`
          + ` | ${cell(row.sheetStatus)} | ${passed}/${row.checks.length} |`;
      }),
      "",
    ];

    // Where the sheet and the run disagree — the rows most worth a human's time,
    // in both directions: closed tickets that still reproduce, and open ones that
    // are already fixed and could be closed.
    const closedish = /^(fixed|closed|done|resolved|verified|complete)/i;
    const stillBroken = rows.filter((row) => closedish.test(row.sheetStatus ?? "") && row.verdict !== "FIXED");
    const quietlyFixed = rows.filter(
      (row) => row.sheetStatus && !closedish.test(row.sheetStatus) && row.verdict === "FIXED",
    );
    if (stillBroken.length || quietlyFixed.length) {
      lines.push("## Where the sheet and the run disagree", "");
      for (const row of stillBroken) {
        lines.push(`- \`${row.id}\` — the sheet says **${row.sheetStatus}**, but the run found it ${row.verdict}.`);
      }
      for (const row of quietlyFixed) {
        lines.push(`- \`${row.id}\` — the sheet says **${row.sheetStatus}**, but the run could not reproduce it. Closable.`);
      }
      lines.push("");
    }

    lines.push("## Detail", "");
    for (const row of rows) {
      lines.push(`### \`${row.id}\` — ${row.title}`, "", `**${MARK[row.verdict]}**`, "");
      const meta = [
        row.module && `Module: ${row.module}`,
        row.severity && `Severity: ${row.severity}`,
        row.sheetStatus && `Sheet status: ${row.sheetStatus}`,
        !row.fromSheet && "_Not matched to a row in `data/bugs.csv` — verified from the spec's own description._",
      ].filter(Boolean);
      if (meta.length) lines.push(meta.join(" · "), "");

      if (row.blockedReason) lines.push(`Could not be verified: ${row.blockedReason}`, "");
      for (const check of row.checks) {
        lines.push(`- ${check.ok ? "PASS" : "**FAIL**"} — ${check.name}`);
        if (!check.ok && check.detail) {
          lines.push("", "  ```", `  ${check.detail.replace(/\n/g, "\n  ")}`, "  ```", "");
        }
      }
      if (!row.checks.length) lines.push("- No symptom was asserted.");
      lines.push("");
      if (row.notes.length) {
        lines.push("Observed:", "", ...row.notes.map((note) => `- ${note}`), "");
      }
      if (row.evidence.length) {
        lines.push("Evidence:", "", ...row.evidence.map((item) => `- ${item}`), "");
      }
    }

    const runCopy = resolve(runDir(), "BUG-STATUS.md");
    // A stable path as well, because the person asking "are they fixed yet" should
    // not have to work out which timestamped folder was the last run.
    const stableCopy = resolve(config.reportsDir, "BUG-STATUS.md");
    const body = lines.join("\n");
    writeFileSync(runCopy, body, "utf8");
    writeFileSync(stableCopy, body, "utf8");
    writeFileSync(resolve(runDir(), "bug-status.json"), JSON.stringify(rows, null, 2), "utf8");

    console.log(`\nBug status: ${stableCopy}`);
    console.log(
      `  ${count("FIXED")} fixed, ${count("NOT FIXED")} not fixed, ${count("PARTIALLY FIXED")} partial, `
        + `${count("BLOCKED")} blocked.`,
    );
  }
}
