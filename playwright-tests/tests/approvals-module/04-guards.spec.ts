import { test, expect } from "../../src/fixtures.js";
import { ApprovalsApi, pendingIndent, reader, users, signIn } from "./helpers.js";

/**
 * N5–N7 and N9 — the guards that stop the wrong person, the wrong moment and the
 * second click.
 *
 * These are probed through the API as well as the screen: a hidden button is not
 * security, and the only way to prove the backend refuses is to ask it directly.
 * Every refusal is checked for a *readable* answer — a 500 or a NameError here is
 * the defect, not the refusal itself.
 */

const list = users();
const readable = (response: { status: number; body: string }) =>
  response.status < 500 && !/Traceback|NameError|is not defined/i.test(response.body);

test.describe("Approvals — authority and race guards", () => {

  test("N5–N6 · self-approval and a stranger's approval are both refused", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    const target = await pendingIndent(api, page, log, goto, list, "Raised for the approvals authority-guard run.");

    // ---- N5 · the requester cannot decide their own request --------------------
    await log.runStep("N5 · the raiser cannot approve, reject or return their own indent", async () => {
      const detail = await api.raw("get", `/api/approvals/indents/${target.id}`, list.raiser);
      expect.soft(detail.status, `The raiser could open their own indent for approval (${detail.status}).`).toBeGreaterThanOrEqual(400);
      expect.soft(readable(detail), `GET as the raiser answered unreadably: ${detail.status} ${detail.body.slice(0, 300)}`).toBe(true);
      log.info(`Raiser GET /api/approvals/indents/${target.id} → ${detail.status} ${detail.body.slice(0, 200)}`);

      for (const [action, payload] of [
        ["approve", { items: [{ line_id: 1, approved_quantity: 1 }], comments: "self" }],
        ["reject", { comments: "self reject attempt" }],
        ["return", { comments: "self return attempt" }],
      ] as const) {
        const response = await api.raw("post", `/api/approvals/indents/${target.id}/${action}`, list.raiser, payload);
        expect.soft(response.status, `The raiser's own ${action} answered ${response.status}; it must be refused.`).toBeGreaterThanOrEqual(400);
        expect.soft(readable(response), `Self-${action} answered unreadably: ${response.status} ${response.body.slice(0, 300)}`).toBe(true);
        log.info(`Raiser ${action} → ${response.status} ${response.body.slice(0, 200)}`);
      }

      const after = await api.indent(target.id, reader(list));
      expect.soft(after.status, `${target.indentNo} changed status after the raiser's own attempts (${after.status}).`).toBe("PENDING_APPROVAL");
    });

    await log.runStep("N5 · the raiser sees a message, not a blank screen or a raw error", async () => {
      await signIn(page, api, list.raiser, log);
      await goto(`/approvals?reviewIndent=${target.id}`, "raiser-opens-own-indent");
      await page.waitForTimeout(250);
      const text = await page.locator("body").innerText();
      expect.soft(text.trim().length, "The raiser's attempt rendered an empty page.").toBeGreaterThan(20);
      expect.soft(/Traceback|Internal Server Error|\{"success"/i.test(text),
        `A raw error body was shown to the raiser: ${text.slice(0, 250)}`).toBe(false);
      await capture("raiser-refused");
    });

    // ---- N6 · an approver who does not hold the document -----------------------
    await log.runStep("N6 · an approver who does not hold this indent is refused", async () => {
      const stranger = list.approvers.find((account) => account.employeeId !== target.approver.employeeId);
      test.skip(!stranger, "users.json has only one approver — cannot test a stranger's access.");

      const detail = await api.raw("get", `/api/approvals/indents/${target.id}`, stranger!);
      expect.soft(detail.status, `${stranger!.label} does not hold ${target.indentNo} but read it anyway (${detail.status}).`)
        .toBeGreaterThanOrEqual(400);
      expect.soft(readable(detail), `A stranger's read answered unreadably: ${detail.status} ${detail.body.slice(0, 300)}`).toBe(true);

      const approveAttempt = await api.raw("post", `/api/approvals/indents/${target.id}/approve`, stranger!, {
        items: [{ line_id: 1, approved_quantity: 1 }], comments: "not my document",
      });
      expect.soft(approveAttempt.status, `${stranger!.label} approved a document that is not theirs (${approveAttempt.status}).`)
        .toBeGreaterThanOrEqual(400);
      expect.soft(readable(approveAttempt), `A stranger's approve answered unreadably: ${approveAttempt.status} ${approveAttempt.body.slice(0, 300)}`).toBe(true);
      log.info(`Stranger (${stranger!.label}) approve → ${approveAttempt.status} ${approveAttempt.body.slice(0, 200)}`);

      await signIn(page, api, stranger!, log);
      await goto(`/approvals?reviewIndent=${target.id}`, "stranger-opens-indent");
      await page.waitForTimeout(250);
      const buttons = await page.getByRole("button", { name: "Approve", exact: true }).count();
      expect.soft(buttons, "A stranger was shown a working Approve button for somebody else's document.").toBe(0);
      await capture("stranger-refused");
    });

    await context.dispose();
  });

  test("N7 · a second decision on an already-decided indent is refused, not crashed", async ({ page, log, goto, capture, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);

    const target = await pendingIndent(api, page, log, goto, list, "Raised for the approvals double-decision run.");

    const decided = await log.runStep("N7 · decide it once", async () => {
      const detail = await api.raw("get", `/api/approvals/indents/${target.id}`, target.approver);
      expect(detail.ok, `The holder cannot read their own task: ${detail.status} ${detail.body}`).toBe(true);
      const items = (detail.json.items ?? []).map((line: any) => ({
        line_id: line.id, approved_quantity: line.requested_quantity,
      }));
      const first = await api.raw("post", `/api/approvals/indents/${target.id}/approve`, target.approver, {
        items, comments: "First decision from the automated run.",
      });
      expect(first.ok, `The first approval failed: ${first.status} ${first.body}`).toBe(true);
      return items;
    });

    await log.runStep("N7 · the same approval sent twice answers a clean 4xx and changes nothing", async () => {
      const before = await api.indent(target.id, reader(list));

      const second = await api.raw("post", `/api/approvals/indents/${target.id}/approve`, target.approver, {
        items: decided, comments: "Second decision — must be refused.",
      });
      // Which 4xx depends on where the document went. A one-rung ladder leaves it
      // no longer PENDING_APPROVAL (422); a deeper one hands it to the next rung,
      // so the same approver is simply no longer at the current stage (403).
      // Both are correct refusals; a 2xx or a 5xx is not.
      expect.soft(second.status, `A repeated approval answered ${second.status}; it must be refused with a 4xx.`)
        .toBeGreaterThanOrEqual(400);
      expect.soft(second.status, "A repeated approval must never reach a 5xx.").toBeLessThan(500);
      expect.soft(readable(second), `A repeated approval answered unreadably: ${second.status} ${second.body.slice(0, 300)}`).toBe(true);
      log.info(`Repeat approve → ${second.status} ${second.body.slice(0, 250)}`);

      const reject = await api.raw("post", `/api/approvals/indents/${target.id}/reject`, target.approver, {
        comments: "Rejecting a document that was already approved.",
      });
      expect.soft(reject.status, `A late reject answered ${reject.status}; expected a 4xx.`).toBeGreaterThanOrEqual(400);
      expect.soft(reject.status, "A late reject must never reach a 5xx.").toBeLessThan(500);
      expect.soft(readable(reject), `A late reject answered unreadably: ${reject.status} ${reject.body.slice(0, 300)}`).toBe(true);

      const after = await api.indent(target.id, reader(list));
      expect.soft(after.status, `The refused second decision still moved ${target.indentNo} from ${before.status} to ${after.status}.`)
        .toBe(before.status);
    });

    await log.runStep("N7 · re-opening the decided document in the browser shows a message", async () => {
      await signIn(page, api, target.approver, log);
      await goto(`/approvals?reviewIndent=${target.id}`, "stale-review-screen");
      await page.waitForTimeout(300);
      const text = await page.locator("body").innerText();
      expect.soft(text.trim().length, "Re-opening a decided document rendered an empty page.").toBeGreaterThan(20);
      expect.soft(/Traceback|Internal Server Error|\{"success"/i.test(text),
        `A raw error body was shown for a decided document: ${text.slice(0, 250)}`).toBe(false);
      const approve = page.getByRole("button", { name: "Approve", exact: true });
      expect.soft(await approve.count(), "A decided document still offers an Approve button.").toBe(0);
      await capture("stale-document-reopened");
    });

    await context.dispose();
  });

  test("N9 · permission gating on the approvals endpoints", async ({ log, playwright }) => {
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL || "http://localhost:8000" });
    const api = new ApprovalsApi(context);
    const approver = list.approvers[0]!;

    await log.runStep("N9 · reminding an approver outside your reporting team is refused", async () => {
      const response = await api.raw("post", "/api/approvals/team-queue/999999/remind", approver);
      expect.soft(response.status, `Reminding a stranger answered ${response.status}; expected a 4xx.`).toBeGreaterThanOrEqual(400);
      expect.soft(readable(response), `Remind answered unreadably: ${response.status} ${response.body.slice(0, 300)}`).toBe(true);
      log.info(`Remind 999999 → ${response.status} ${response.body.slice(0, 250)}`);

      for (const bad of ["0", "-1", "abc"]) {
        const answer = await api.raw("post", `/api/approvals/team-queue/${bad}/remind`, approver);
        expect.soft(answer.status, `Remind with id "${bad}" answered ${answer.status} — a 5xx is a defect.`).toBeLessThan(500);
      }
    });

    await log.runStep("N9 · an account without the approval permission is refused by the backend", async () => {
      const outsider = list.inventory ?? list.raiser;
      const pending = await api.pending(approver).catch(() => []);
      const someIndent = pending.find((row) => row.doc_type === "INDENT");
      if (!someIndent) {
        log.info("No pending indent to probe the permission with — skipped.");
        return;
      }
      const response = await api.raw("get", `/api/approvals/indents/${someIndent.doc_id}`, outsider);
      expect.soft(response.status, `${outsider.label} read somebody else's approval task (${response.status}).`).toBeGreaterThanOrEqual(400);
      expect.soft(readable(response), `The permission refusal was unreadable: ${response.status} ${response.body.slice(0, 300)}`).toBe(true);
      log.info(`${outsider.label} GET approvals/indents/${someIndent.doc_id} → ${response.status} ${response.body.slice(0, 200)}`);
    });

    await context.dispose();
  });
});
