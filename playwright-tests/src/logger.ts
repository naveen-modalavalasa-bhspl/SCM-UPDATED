import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TestInfo } from "@playwright/test";
import { config } from "./config.js";

/**
 * Every kind of finding a run can produce. "functional" ones come from the steps
 * and assertions; the rest are the non-functional signals a manual tester never
 * reports — console noise, dead requests, slow pages, accessibility breaks.
 */
export type EventKind =
  | "step"
  | "info"
  | "assert"
  | "navigation"
  | "console"
  | "pageerror"
  | "request-failed"
  | "http-error"
  | "slow-request"
  | "slow-page"
  | "a11y"
  | "screenshot";

export type Level = "info" | "warn" | "error";

export interface LogEvent {
  ts: string;
  test: string;
  step: string | null;
  kind: EventKind;
  level: Level;
  message: string;
  url?: string;
  durationMs?: number;
  data?: unknown;
}

/**
 * Tests run in worker processes and the reporter runs in the main one, so the run
 * folder cannot be a module-load constant — each process would mint its own and
 * the reporter would summarise an empty file. `globalSetup` stamps PW_RUN_ID into
 * the environment the workers inherit; this resolves it lazily off that.
 */
let cachedRunDir: string | null = null;

export function runDir(): string {
  if (cachedRunDir) return cachedRunDir;
  const id = process.env.PW_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
  process.env.PW_RUN_ID = id;
  cachedRunDir = resolve(config.reportsDir, `run-${id}`);
  mkdirSync(resolve(cachedRunDir, "screens"), { recursive: true });
  return cachedRunDir;
}

export const eventsFile = () => resolve(runDir(), "events.jsonl");

const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "step";

export class RunLogger {
  private step: string | null = null;
  private counter = 0;
  readonly events: LogEvent[] = [];

  constructor(private readonly testInfo: TestInfo) {}

  get currentStep() {
    return this.step;
  }

  record(event: Omit<LogEvent, "ts" | "test" | "step">) {
    const full: LogEvent = {
      ts: new Date().toISOString(),
      test: this.testInfo.title,
      step: this.step,
      ...event,
    };
    this.events.push(full);
    appendFileSync(eventsFile(), `${JSON.stringify(full)}\n`, "utf8");
    // Errors surface in the terminal too, so a failing run is readable without
    // opening a file.
    if (full.level === "error") console.error(`  ✗ [${full.kind}] ${full.message}`);
  }

  info(message: string, data?: unknown) {
    this.record({ kind: "info", level: "info", message, data });
  }

  problem(kind: EventKind, message: string, extra: Partial<LogEvent> = {}) {
    this.record({ kind, level: "error", message, ...extra });
  }

  warn(kind: EventKind, message: string, extra: Partial<LogEvent> = {}) {
    this.record({ kind, level: "warn", message, ...extra });
  }

  /** Names a stretch of work so every event inside it is attributed to that step. */
  async runStep<T>(name: string, body: () => Promise<T>): Promise<T> {
    const previous = this.step;
    this.step = name;
    const started = Date.now();
    this.record({ kind: "step", level: "info", message: `▶ ${name}` });
    try {
      const result = await body();
      this.record({
        kind: "step",
        level: "info",
        message: `✓ ${name}`,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      this.record({
        kind: "step",
        level: "error",
        message: `✗ ${name}: ${(error as Error).message}`,
        durationMs: Date.now() - started,
      });
      throw error;
    } finally {
      this.step = previous;
    }
  }

  /** Screenshot path for the current step, numbered so the reel reads in order. */
  screenshotPath(label: string) {
    this.counter += 1;
    const name = `${String(this.counter).padStart(3, "0")}-${slug(label)}.png`;
    return { path: resolve(runDir(), "screens", name), name };
  }

  writeTestSummary() {
    const errors = this.events.filter((e) => e.level === "error");
    const warnings = this.events.filter((e) => e.level === "warn");
    writeFileSync(
      resolve(runDir(), `${slug(this.testInfo.title)}.json`),
      JSON.stringify(
        { test: this.testInfo.title, status: this.testInfo.status, errors, warnings, events: this.events },
        null,
        2,
      ),
      "utf8",
    );
  }
}
