/**
 * Screenshot + element-geometry capture for the Indents user manual.
 *
 * Reads docs/manual/flows.yaml, signs in once, walks every screen and writes
 * for each one:
 *   docs/manual/raw/<slug>.png    full-page screenshot at 1440x900
 *   docs/manual/raw/<slug>.json   {label, role, x, y, width, height} per control
 *
 * The password is never stored in the repo: it is read from backend/.env at
 * run time and never printed.
 */
import { chromium } from "@playwright/test";
import * as yaml from "js-yaml";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANUAL = resolve(ROOT, "docs/manual");
const RAW = resolve(MANUAL, "raw");
mkdirSync(RAW, { recursive: true });

const flows = yaml.load(readFileSync(resolve(MANUAL, "flows.yaml"), "utf8"));

/* The one credential, straight out of backend/.env. */
function envValue(key) {
  const text = readFileSync(resolve(ROOT, "backend/.env"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\s*${key}\s*=\s*(.*)$`));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`${key} not found in backend/.env`);
}

/* ------------------------------------------------------------------ capture */

/**
 * Every control worth a number, in reading order, with document coordinates.
 *
 * Runs in the page so it can read layout directly. Coordinates are taken at
 * scrollY 0, where getBoundingClientRect() already returns document offsets —
 * which is what a full-page screenshot is measured in.
 */
const COLLECT = () => {
  const seen = [];
  const push = (el, role, priority) => {
    const r = el.getBoundingClientRect();
    if (r.width < 16 || r.height < 16) return;            // decorative
    if (r.width > 1400 && r.height > 700) return;         // page-sized wrapper
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return;
    if (el.getAttribute("aria-hidden") === "true") return;

    let label =
      (el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("title") ||
        el.innerText ||
        el.value ||
        "").replace(/\s+/g, " ").trim();
    if (label.length > 60) label = label.slice(0, 57) + "...";
    if (!label) return;

    // Drop a control already covered by one we kept (nested buttons/links).
    for (const s of seen) {
      if (Math.abs(s.x - r.left) < 4 && Math.abs(s.y - r.top) < 4) return;
    }
    seen.push({
      label, role, priority,
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
    });
  };

  const main = document.querySelector("main") || document.body;

  // Priority 1 — the actions and tabs a manual is written around.
  main.querySelectorAll("button, [role=tab], a[href][class*=btn], [role=button]")
      .forEach((el) => push(el, el.getAttribute("role") === "tab" ? "tab" : "button", 1));
  // Priority 2 — everything the user types into or chooses from.
  main.querySelectorAll("input, select, textarea, [role=combobox], [role=switch]")
      .forEach((el) => push(el, el.tagName.toLowerCase(), 2));
  // Priority 3 — KPI cards and status widgets, the things a dashboard is.
  main.querySelectorAll("[class*=stat], [class*=kpi], [class*=card]")
      .forEach((el) => push(el, "widget", 3));
  // Priority 4 — the first table row only; the rest repeat it.
  const firstRow = main.querySelector("tbody tr, [role=row]:not(:first-child)");
  if (firstRow) push(firstRow, "row", 4);
  // Priority 5 — remaining in-content links.
  main.querySelectorAll("a[href]").forEach((el) => push(el, "link", 5));

  return seen;
};

/** Reading order: banded into rows ~40px tall, then left to right within a band. */
const readingOrder = (a, b) =>
  Math.abs(a.y - b.y) > 40 ? a.y - b.y : a.x - b.x;

const run = async () => {
  const password = envValue(flows.auth.password_env);
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  /* ---- sign in; the session carries every screen until the account changes */
  let currentUser = null;
  const signIn = async (username) => {
    if (currentUser === username) return;
    await page.context().clearCookies();
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); })
              .catch(() => {});
    await page.goto(flows.base_url + flows.auth.path, { waitUntil: "networkidle" });
    await page.locator(flows.auth.username_field).first().fill(username);
    await page.locator(flows.auth.password_field).first().fill(password);
    await page.locator(flows.auth.submit).first().click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
    currentUser = username;
    console.log("signed in as", username);
  };
  await signIn(flows.auth.username);

  const results = [];
  for (const flow of flows.flows) {
    try {
      await page.goto(flows.base_url + flow.goto, { waitUntil: "networkidle", timeout: 45_000 });
      await page.waitForTimeout(1200);            // let charts and lists settle

      // Close anything floating over the screen before it is photographed.
      for (const sel of ['[aria-label="Close"]', ".toast button", "[data-dismiss]"]) {
        const c = page.locator(sel);
        if (await c.count()) await c.first().click({ timeout: 1500 }).catch(() => {});
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      if (new URL(page.url()).pathname.startsWith("/login")) {
        throw new Error("session lost - screen redirected to /login");
      }

      const elements = (await page.evaluate(COLLECT)).sort(readingOrder);
      await page.screenshot({ path: resolve(RAW, `${flow.slug}.png`), fullPage: true });
      writeFileSync(
        resolve(RAW, `${flow.slug}.json`),
        JSON.stringify({ ...flow, url: page.url(), elements }, null, 2)
      );
      console.log(`OK   ${flow.slug.padEnd(28)} ${elements.length} controls  (as ${currentUser})`);
      results.push({ slug: flow.slug, ok: true, count: elements.length, as: currentUser });
    } catch (err) {
      console.log(`FAIL ${flow.slug.padEnd(28)} ${err.message.split("\n")[0]}`);
      results.push({ slug: flow.slug, ok: false, error: err.message.split("\n")[0] });
    }
  }

  writeFileSync(resolve(RAW, "_results.json"), JSON.stringify(results, null, 2));
  await browser.close();
};

run();
