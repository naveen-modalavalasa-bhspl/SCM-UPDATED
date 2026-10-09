import { test as base, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { config } from "./config.js";
import { RunLogger } from "./logger.js";
import { ApiClient } from "./api.js";

/**
 * Attaches the non-functional listeners to a page. Everything the browser
 * complains about — console errors, uncaught exceptions, failed or slow requests,
 * 4xx/5xx responses — lands in the same event log as the functional steps, so one
 * file answers both "did it work" and "was it healthy while it worked".
 */
function watch(page: Page, log: RunLogger) {
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    // React Router future-flag notices and Vite HMR chatter are noise, not defects.
    const text = message.text();
    if (/React Router Future Flag|\[vite\]/i.test(text)) return;
    log.record({
      kind: "console",
      level: type === "error" ? "error" : "warn",
      message: text,
      url: page.url(),
      data: { location: message.location() },
    });
  });

  page.on("pageerror", (error) => {
    log.problem("pageerror", `Uncaught ${error.name}: ${error.message}`, {
      url: page.url(),
      data: { stack: error.stack },
    });
  });

  page.on("requestfailed", (request) => {
    log.problem("request-failed", `${request.method()} ${request.url()} failed: ${request.failure()?.errorText}`, {
      url: page.url(),
    });
  });

  page.on("response", async (response) => {
    const request = response.request();
    const timing = request.timing();
    const durationMs = timing.responseEnd > 0 ? Math.round(timing.responseEnd) : undefined;
    const status = response.status();

    if (status >= 400) {
      // The API error body is the single most useful thing in a failed run, so it
      // is captured rather than just the status line.
      let body = "";
      try {
        body = (await response.text()).slice(0, 800);
      } catch {
        body = "<unavailable>";
      }
      log.problem("http-error", `${status} ${request.method()} ${response.url()}`, {
        url: page.url(),
        durationMs,
        data: { body },
      });
      return;
    }

    if (durationMs !== undefined && durationMs > config.slowRequestMs && /\/api\//.test(response.url())) {
      log.warn("slow-request", `${durationMs}ms — ${request.method()} ${response.url()}`, {
        url: page.url(),
        durationMs,
      });
    }
  });
}

export interface Fixtures {
  log: RunLogger;
  api: ApiClient;
  /** Screenshot + optional accessibility scan of whatever is on screen now. */
  capture: (label: string) => Promise<void>;
  /** Navigate, wait for the app shell, then capture. Logs the load time. */
  goto: (path: string, label?: string) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  log: async ({}, use, testInfo) => {
    const log = new RunLogger(testInfo);
    await use(log);
    log.writeTestSummary();
    const errors = log.events.filter((e) => e.level === "error");
    // A test that clicked through happily while the console threw is not a pass.
    // Reported as an attachment rather than a hard failure so one broken widget
    // does not hide the rest of the flow's results.
    if (errors.length) {
      await testInfo.attach("non-functional-findings.json", {
        body: JSON.stringify(errors, null, 2),
        contentType: "application/json",
      });
    }
  },

  api: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: config.apiURL });
    await use(new ApiClient(context));
    await context.dispose();
  },

  page: async ({ page, log }, use) => {
    // Wired here, not in `goto`, so a page is watched from its very first byte —
    // an error thrown during the initial render still gets recorded.
    watch(page, log);
    await use(page);
  },

  capture: async ({ page, log }, use, testInfo) => {
    const scan = async (label: string) => {
      if (config.screenshotEveryStep || testInfo.status === "failed") {
        const { path, name } = log.screenshotPath(label);
        await page.screenshot({ path, fullPage: true });
        log.record({ kind: "screenshot", level: "info", message: label, url: page.url(), data: { file: name } });
      }
      if (!config.a11y) return;
      try {
        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .analyze();
        for (const violation of results.violations) {
          log.warn("a11y", `${violation.id} (${violation.impact}) — ${violation.help}`, {
            url: page.url(),
            data: {
              helpUrl: violation.helpUrl,
              nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(" ")),
            },
          });
        }
      } catch (error) {
        log.info(`Accessibility scan skipped: ${(error as Error).message}`);
      }
    };
    await use(scan);
  },

  goto: async ({ page, log, capture }, use) => {
    const navigate = async (path: string, label = path) => {
      const started = Date.now();
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const elapsed = Date.now() - started;
      log.record({ kind: "navigation", level: "info", message: `Opened ${path}`, url: page.url(), durationMs: elapsed });
      if (elapsed > config.slowPageMs) {
        log.warn("slow-page", `${path} took ${elapsed}ms to become idle`, { url: page.url(), durationMs: elapsed });
      }
      await capture(label);
    };
    await use(navigate);
  },
});

export { expect };
