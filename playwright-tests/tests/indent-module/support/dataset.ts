import type { Account } from "../../../src/config.js";
import type { RunLogger } from "../../../src/logger.js";
import type { CatalogueItem, IndentApi } from "./api.js";

/**
 * The known data every assertion in this suite is measured against.
 *
 * Without it the run reads whatever the database happens to hold, and a filter
 * test degenerates into "something changed". Worse, on a thin database whole
 * controls go unverified: an earlier run of this suite reported *"the list holds
 * 1 indent — paging forward could not be exercised"*, which is a pagination test
 * that tested nothing and still went green.
 *
 * So the run raises its own spread first:
 *
 * | Axis         | Spread                                   | What it lets a filter prove |
 * | ------------ | ---------------------------------------- | --------------------------- |
 * | count        | `SEED_COUNT` (24) — more than one page    | Page 2 exists and is real   |
 * | priority     | every 4th URGENT, the rest NORMAL         | Priority both keeps and drops rows |
 * | required by  | today / +5 days / +40 days, round-robin   | Today, Next 7, Next 30 each cut differently |
 * | quantity     | 1..n, all different                       | A line reads back as itself |
 * | item         | rotates over the first three catalogue items | Item-specific rows are distinguishable |
 *
 * Everything is a DRAFT owned by the testing account, so teardown can delete all
 * of it. Nothing is ever submitted: a submitted indent cannot be deleted and would
 * park itself in a real person's approval queue, which is not a test's to do.
 */

/** The page size every Indent list screen uses. Seed past it or page 2 never exists. */
export const LIST_PAGE_SIZE = 20;

export interface SeededIndent {
  id: number;
  indentNo: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  quantity: number;
  priority: "NORMAL" | "URGENT";
  requiredDate: string;
  /** Days from today, so a required-by preset's expected partition is computable. */
  requiredInDays: number;
}

export interface Dataset {
  runId: string;
  drafts: SeededIndent[];
  ids: Set<number>;
  indentNos: Set<string>;
  urgent: SeededIndent[];
  normal: SeededIndent[];
  items: CatalogueItem[];
  /** Who raised them — the name the main list's search matches on. */
  requesterName: string;
  departmentName: string;
}

/** Required-by offsets, chosen so each preset window holds a different subset. */
const REQUIRED_IN_DAYS = [0, 5, 40] as const;

export function isoDate(daysFromToday: number, now = new Date()) {
  const value = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function seedDataset(
  api: IndentApi,
  account: Account,
  log: RunLogger,
  count: number,
): Promise<Dataset> {
  return log.runStep(`Seed ${count} draft indents as ${account.label}`, async () => {
    const runId = Date.now().toString(36);
    const catalogue = await api.items(account);
    if (!catalogue.length) {
      throw new Error(
        "The item catalogue is empty, so nothing can be seeded and no Indent screen can be tested honestly.",
      );
    }
    const items = catalogue.slice(0, 3);

    const drafts: SeededIndent[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = items[index % items.length];
      const priority = index % 4 === 0 ? "URGENT" : "NORMAL";
      const requiredInDays = REQUIRED_IN_DAYS[index % REQUIRED_IN_DAYS.length];
      const quantity = index + 1;
      const created = await api.createDraft(account, item.id, quantity, {
        priority,
        required_date: isoDate(requiredInDays),
        remarks: `[E2E:${runId}] seeded draft ${index + 1} of ${count}`,
      });
      drafts.push({
        id: created.id,
        indentNo: created.indent_no,
        itemId: item.id,
        itemCode: item.code,
        itemName: item.name,
        quantity,
        priority,
        requiredDate: isoDate(requiredInDays),
        requiredInDays,
      });
    }

    // Read one back rather than trusting the create response: the requester and
    // department names are snapshotted server-side, and the main list searches
    // those exact strings. Guessing them would make the search test a lie.
    const sample = await api.indent(drafts[0].id, account);

    log.info(
      `Seeded ${drafts.length} drafts (${drafts[0].indentNo} … ${drafts[drafts.length - 1].indentNo}) `
        + `for ${sample.requested_by_name ?? "unknown requester"} / ${sample.department_name ?? "no department"}.`,
    );

    return {
      runId,
      drafts,
      ids: new Set(drafts.map((draft) => draft.id)),
      indentNos: new Set(drafts.map((draft) => draft.indentNo)),
      urgent: drafts.filter((draft) => draft.priority === "URGENT"),
      normal: drafts.filter((draft) => draft.priority === "NORMAL"),
      items,
      requesterName: (sample.requested_by_name ?? "").trim(),
      departmentName: (sample.department_name ?? "").trim(),
    };
  });
}

/**
 * Deletes everything the run raised.
 *
 * Runs in fixture teardown so it happens on a red run too — a suite that leaves
 * two dozen drafts behind every time it fails is worse than no suite. Anything
 * that refuses to delete is named in the report rather than swallowed.
 */
export async function teardownDataset(
  api: IndentApi,
  account: Account,
  dataset: Dataset,
  log: RunLogger,
) {
  let deleted = 0;
  const stubborn: string[] = [];
  for (const draft of dataset.drafts) {
    const result = await api.deleteIndent(draft.id, account);
    if (result.status === 204 || result.status === 200) deleted += 1;
    else stubborn.push(`${draft.indentNo} (${result.status} ${result.error})`);
  }
  log.info(`Teardown: deleted ${deleted}/${dataset.drafts.length} seeded drafts.`);
  if (stubborn.length) {
    log.warn("assert", `Seeded indents left behind and needing manual cleanup: ${stubborn.join(", ")}`);
  }
}
