import { test as base, expect } from "../../../src/fixtures.js";
import { checker, type Checker } from "../../../src/checks.js";
import { config, loadTester, type Account } from "../../../src/config.js";
import { loginAs } from "../../../src/pages/login.js";
import { IndentApi } from "./api.js";
import { seedDataset, teardownDataset, type Dataset } from "./dataset.js";

/**
 * One account, one dataset, one soft-check recorder.
 *
 * **One account.** This suite sweeps a module's own screens; it is not the
 * approval journey, which lives in `tests/indent-approval-flow/` and needs a
 * ladder's worth of logins. Hand it any single login and every expectation is
 * recomputed from what *that* account can see, so the same run is correct for a
 * store keeper and for an administrator.
 *
 * **Soft checks.** A manual tester who finds a broken button writes it down and
 * carries on; a hard `expect` stops, so a run that meets one defect reports one
 * defect and leaves the other five screens unvisited. Every check here records
 * and continues, and the scenario fails once at the end with all of them listed.
 * Hard `expect` is kept for preconditions the rest of the test cannot survive.
 */

export interface IndentFixtures {
  checks: Checker;
  indents: IndentApi;
  tester: Account;
  /** Signs the tester in once per test and leaves the app on the Indent module. */
  signedIn: void;
  /** The permission codes the account holds, so a screen missing a button can be explained. */
  granted: Set<string>;
}

export const test = base.extend<IndentFixtures>({
  tester: async ({}, use) => {
    await use(loadTester());
  },

  checks: async ({ log }, use) => {
    await use(checker(log));
  },

  indents: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: config.apiURL });
    await use(new IndentApi(context));
    await context.dispose();
  },

  granted: async ({ indents, tester }, use) => {
    const me = await indents.me(tester);
    await use(new Set(me.permissions ?? []));
  },

  signedIn: [async ({ page, tester, log }, use) => {
    await loginAs(page, tester, log);
    await use();
  }, { auto: true }],
});

/**
 * Adds the seeded dataset.
 *
 * Separate from `test` so the two scenarios that must run against untouched data
 * — the empty states, and anything counting what already exists — can opt out.
 * Teardown runs even when the test fails, so a red run does not leave two dozen
 * drafts behind.
 */
export const seededTest = test.extend<{ dataset: Dataset }>({
  dataset: async ({ indents, tester, log }, use) => {
    const dataset = await seedDataset(indents, tester, log, config.seedCount);
    try {
      await use(dataset);
    } finally {
      await teardownDataset(indents, tester, dataset, log);
    }
  },
});

export { expect };
