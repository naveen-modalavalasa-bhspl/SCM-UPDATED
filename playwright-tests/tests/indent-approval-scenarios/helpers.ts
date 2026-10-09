import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { Account } from "../../src/config.js";
import type { RunLogger } from "../../src/logger.js";
import { ApprovalsApi, signIn, type UsersFile } from "../approvals-module/helpers.js";

/**
 * Scenario helpers for the store-keeper → OE → DM → RM → SPH → COO ladder.
 *
 * Two rules shape everything here:
 *
 * 1. The ladder is never hardcoded. At each rung the run asks
 *    `/api/approvals/pending` which configured account actually holds the
 *    document, so re-configuring Approvals Config needs no test change.
 * 2. RBAC is not touched. When a rung's job profile has the approvals screens
 *    switched off, the browser cannot reach the review page — that is recorded
 *    as a finding and the rung is walked over the API instead, so the rungs
 *    ABOVE the blocked one still get exercised in the same run.
 */

export const REVIEW_URL = (id: number) => `/approvals?reviewIndent=${id}`;

/**
 * The confirm button of the open ConfirmModal.
 *
 * Addressed by its position in the modal footer, not by its label: the label is
 * the verb of the decision ("Approve", "Return for correction", …) and changes
 * with the copy. The footer holds Cancel first, confirm last.
 */
export const confirmButton = (page: Page) =>
  page.getByRole("dialog").getByRole("contentinfo").getByRole("button").last();

/**
 * The approved-quantity box on the review screen.
 *
 * Rendered as a plain input with an aria-label; whether the browser reports it
 * as a spinbutton or a textbox depends on the build, so both are accepted.
 */
export const approvedQuantityBox = (page: Page) =>
  page.getByRole("spinbutton", { name: /Approved quantity/i })
    .or(page.getByRole("textbox", { name: /Approved quantity/i }))
    .first();

export interface RungResult {
  label: string;
  employeeId: string;
  via: "ui" | "api" | "blocked";
  note?: string;
}

/** True when the approval review screen actually rendered for this indent. */
async function reviewScreenVisible(page: Page): Promise<boolean> {
  const heading = page.getByText("Approval review", { exact: false }).first();
  return heading.isVisible({ timeout: 12_000 }).catch(() => false);
}

/**
 * Approves the indent at whichever rung `holder` sits on.
 *
 * Drives the real screen: the three checklist boxes are mandatory, the Approve
 * button stays disabled until all three are ticked, and the decision is only
 * final after the confirm modal. Falls back to the API when RBAC has the
 * approvals screen switched off for that profile.
 */
export async function approveAsHolder(
  page: Page,
  api: ApprovalsApi,
  log: RunLogger,
  goto: (path: string, label?: string) => Promise<void>,
  holder: Account,
  indentId: number,
  opts: { quantities?: Record<number, number>; comment?: string } = {},
): Promise<RungResult> {
  await signIn(page, api, holder, log);
  await goto(REVIEW_URL(indentId), `review-${indentId}-${holder.employeeId}`);

  if (!(await reviewScreenVisible(page))) {
    const note = `Approvals review screen did not render for ${holder.label} — `
      + `RBAC has the approvals pages off for this job profile. Rung walked over the API.`;
    log.problem("assert", note, { url: page.url() });
    const via = await approveOverApi(api, log, holder, indentId, opts);
    return { label: holder.label, employeeId: holder.employeeId, via, note };
  }

  // Optional quantity edit before approving (the "reduce only" scenario).
  if (opts.quantities) {
    for (const [lineId, quantity] of Object.entries(opts.quantities)) {
      await approvedQuantityBox(page).fill(String(quantity));
      log.info(`Set approved quantity for line ${lineId} to ${quantity}`);
    }
  }

  const boxes = page.locator("input[type=checkbox]");
  const count = await boxes.count();
  for (let index = 0; index < count; index += 1) await boxes.nth(index).check();
  if (opts.comment) await page.locator("textarea").first().fill(opts.comment);

  const approve = page.getByRole("button", { name: /^Approve$/ }).first();
  await expect(approve).toBeEnabled({ timeout: 10_000 });
  await approve.click();

  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => new RegExp(`/api/approvals/indents/${indentId}/approve$`).test(new URL(r.url()).pathname),
      { timeout: 45_000 },
    ),
    confirmButton(page).click(),
  ]);
  if (!response.ok()) {
    throw new Error(`Approve by ${holder.label} rejected: ${response.status()} ${await response.text()}`);
  }
  log.info(`${holder.label} approved indent ${indentId} through the UI.`);
  return { label: holder.label, employeeId: holder.employeeId, via: "ui" };
}

async function approveOverApi(
  api: ApprovalsApi,
  log: RunLogger,
  holder: Account,
  indentId: number,
  opts: { quantities?: Record<number, number>; comment?: string },
): Promise<"api" | "blocked"> {
  const detail = await api.raw("get", `/api/approvals/indents/${indentId}`, holder);
  const items = (detail.json?.items ?? []).map((line: any) => ({
    line_id: line.id,
    approved_quantity: opts.quantities?.[line.id] ?? line.approved_quantity ?? line.requested_quantity,
  }));
  const response = await api.raw("post", `/api/approvals/indents/${indentId}/approve`, holder, {
    items, comments: opts.comment ?? "Approved via API (screen blocked by RBAC).",
  });
  if (!response.ok) {
    log.problem("assert", `API approve for ${holder.label} answered ${response.status}: ${response.body}`);
    return "blocked";
  }
  log.info(`${holder.label} approved indent ${indentId} over the API.`);
  return "api";
}

/**
 * The Delivery location control of the indent form.
 *
 * Rendered by `Field` as a caption span next to the control, so it has no
 * accessible name of its own — it is found through its caption.
 */
export const deliveryControl = (page: Page) =>
  page.getByText("Delivery location", { exact: true }).first()
    .locator("xpath=..").locator("input, select, button").first();

/** True when the control is unusable: `disabled`, or ARIA-disabled, or readonly. */
export async function isLocked(control: ReturnType<typeof deliveryControl>): Promise<{ locked: boolean; how: string }> {
  const disabled = await control.isDisabled().catch(() => null);
  const aria = await control.getAttribute("aria-disabled").catch(() => null);
  const readonly = await control.getAttribute("readonly").catch(() => null);
  return {
    locked: disabled === true || aria === "true" || readonly !== null,
    how: `disabled=${disabled} aria-disabled=${aria} readonly=${readonly !== null}`,
  };
}

/**
 * Polls the indent until it reaches one of `wanted`, or gives up.
 *
 * Used instead of waiting on a named endpoint: the screen's decision buttons have
 * moved between endpoints across builds, and what matters to the business is the
 * status the document ends up in, not the URL that carried it there.
 */
export async function waitForStatus(
  api: ApprovalsApi,
  indentId: number,
  readAs: Account,
  wanted: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = "";
  while (Date.now() < deadline) {
    status = (await api.indent(indentId, readAs)).status;
    if (wanted.includes(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return status;
}

/** Walks every remaining rung of the ladder, whoever the backend says holds it. */
export async function walkLadder(
  page: Page,
  api: ApprovalsApi,
  log: RunLogger,
  goto: (path: string, label?: string) => Promise<void>,
  list: UsersFile,
  indentId: number,
  maxRungs = 8,
): Promise<{ rungs: RungResult[]; finalStatus: string; stranded: Account | null }> {
  const rungs: RungResult[] = [];
  const readAs = list.admin ?? list.approvers[0]!;
  for (let rung = 0; rung < maxRungs; rung += 1) {
    const status = (await api.indent(indentId, readAs)).status;
    if (status !== "PENDING_APPROVAL" && status !== "SUBMITTED") {
      return { rungs, finalStatus: status, stranded: null };
    }
    const holder = await api.whoHasIndent(indentId, list.approvers);
    if (!holder) {
      log.problem("assert",
        `Indent ${indentId} is ${status} but no configured approver has it in /api/approvals/pending. `
        + `The rung's job profile is unconfigured, or the holder is missing from users.json.`);
      return { rungs, finalStatus: status, stranded: null };
    }
    const result = await approveAsHolder(page, api, log, goto, holder, indentId);
    rungs.push(result);
    if (result.via === "blocked") {
      return { rungs, finalStatus: status, stranded: holder };
    }
  }
  const finalStatus = (await api.indent(indentId, readAs)).status;
  return { rungs, finalStatus, stranded: null };
}
