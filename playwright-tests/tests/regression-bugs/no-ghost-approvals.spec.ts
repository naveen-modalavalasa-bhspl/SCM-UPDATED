import { expect, test } from "@playwright/test";
import { Api, reader, users } from "./helpers.js";

/**
 * A task in someone's approval queue points at a document that is still alive.
 *
 * On 2026-08-05 WHI/2026-27/00027 was CANCELLED yet still sat in MAHENDRA's
 * "Waiting on you" as a two-day-old task. Opening it from the queue lands on a
 * cancelled document with nothing but a Back button — a dead end the approver
 * cannot clear, and a permanent +1 on every approval count and KPI.
 *
 * Cause: warehouse.service.cancel_issue() sets the document status and stops.
 * It never closes the wf_instances row behind it, so the engine keeps handing the
 * task out. The same hole exists wherever a document is cancelled out from under
 * a running workflow.
 */

const DEAD = new Set(["CANCELLED", "REJECTED", "CLOSED"]);

interface PendingItem { doc_type: string; doc_id: number; doc_no?: string | null }
interface Doc { id: number; status: string }

test("no approval task points at a cancelled or rejected document", async ({ request }) => {
  const api = new Api(request);
  const list = users();
  const pool = [list.raiser, ...list.approvers, ...(list.inventory ? [list.inventory] : [])];

  // One read of each document set, keyed by id, so the join below is free.
  const statuses: Record<string, Map<number, string>> = {
    WH_ISSUE: new Map(
      (await api.all<Doc>("/api/warehouse/issues", reader())).map((r) => [r.id, r.status]),
    ),
    ALLOCATION: new Map(
      (await api.all<Doc>("/api/allocations", reader())).map((r) => [r.id, r.status]),
    ),
    INDENT: new Map(
      (await api.all<Doc>("/api/indents", reader())).map((r) => [r.id, r.status]),
    ),
  };

  const ghosts: Array<Record<string, unknown>> = [];
  for (const account of pool) {
    let pending: PendingItem[] = [];
    try {
      pending = (await api.get<{ items: PendingItem[] }>(
        "/api/approvals/pending?page=1&size=200", account,
      )).items ?? [];
    } catch {
      continue; // No approvals permission — nothing this account can hold.
    }
    for (const item of pending) {
      const status = statuses[item.doc_type]?.get(item.doc_id);
      if (status && DEAD.has(status)) {
        ghosts.push({
          approver: account.label,
          document: item.doc_no ?? `${item.doc_type} ${item.doc_id}`,
          status,
        });
      }
    }
  }

  expect(
    ghosts,
    "Approval tasks still queued against documents that are already dead.\n" +
      "The approver cannot clear them and every count they feed is overstated.\n" +
      JSON.stringify(ghosts, null, 2),
  ).toEqual([]);
});
