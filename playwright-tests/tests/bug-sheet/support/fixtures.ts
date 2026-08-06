import type {
  APIRequestContext, APIResponse, PlaywrightTestArgs, PlaywrightTestOptions,
  PlaywrightWorkerArgs, PlaywrightWorkerOptions,
} from "@playwright/test";
import { test as base, expect, type Fixtures } from "../../../src/fixtures.js";
import { config, loadTester, type Account } from "../../../src/config.js";
import { loginAs } from "../../../src/pages/login.js";
import { bugRow } from "./bugs.js";
import { BugTracker } from "./verdict.js";

/**
 * The bug-sheet suite's harness.
 *
 * Deliberately thinner than `tests/indent-module/support/fixtures.ts`: that suite
 * seeds two dozen indents because it sweeps a module, while a bug verification
 * should set up the least state that makes the defect visible and no more. Bugs
 * live on different screens under different accounts; a shared dataset would be
 * wrong for most of them and slow for all of them.
 */

export interface BugFixtures {
  bug: BugTracker;
  tester: Account;
  /**
   * Named `backend`, not `api`: the base fixture already publishes an `api` — the
   * journey suites' read-side client — and overriding it here would change what
   * that name means depending on which folder a spec sits in.
   */
  backend: RawApi;
  signedIn: void;
}

/**
 * The API as the signed-in tester, unfiltered.
 *
 * Several bug rows are about what the *server* returns — a total that ignores a
 * filter, a status that never moves, a 500 on a valid payload. Reproducing those
 * through the browser only tells you the screen is wrong; asking the endpoint
 * directly says whether the fix belongs in `frontend/` or in `backend/`, and the
 * verdict log is more useful when it says which.
 */
export class RawApi {
  private token?: string;

  constructor(private readonly request: APIRequestContext, private readonly account: Account) {}

  private async auth() {
    if (this.token) return this.token;
    const response = await this.request.post("/api/auth/login", {
      form: { username: this.account.employeeId, password: this.account.password },
    });
    if (!response.ok()) {
      throw new Error(`Login failed for ${this.account.label}: ${response.status()} ${await response.text()}`);
    }
    this.token = ((await response.json()) as { access_token: string }).access_token;
    return this.token;
  }

  private async headers() {
    return { Authorization: `Bearer ${await this.auth()}` };
  }

  /** The raw response — status included, so a spec can assert on a 4xx/5xx. */
  async raw(method: "get" | "post" | "put" | "patch" | "delete", path: string, data?: unknown): Promise<APIResponse> {
    const options = { headers: await this.headers(), ...(data === undefined ? {} : { data }) };
    return this.request[method](path, options);
  }

  /** The parsed body, insisting the call succeeded. For setting a scenario up. */
  async json<T>(path: string): Promise<T> {
    const response = await this.raw("get", path);
    if (!response.ok()) throw new Error(`GET ${path}: ${response.status()} ${await response.text()}`);
    return (await response.json()) as T;
  }

  async me() {
    return this.json<{ permissions?: string[]; menu?: unknown[]; employee_id?: string }>("/api/auth/me");
  }
}

export const test = base.extend<BugFixtures>({
  tester: async ({}, use) => {
    await use(loadTester());
  },

  backend: async ({ playwright, tester }, use) => {
    const context = await playwright.request.newContext({ baseURL: config.apiURL });
    await use(new RawApi(context, tester));
    await context.dispose();
  },

  // Teardown writes the record, so a scenario that throws mid-way is still in the
  // log — as BLOCKED, which is the honest answer, rather than absent.
  bug: async ({ log }, use) => {
    const tracker = new BugTracker(log);
    try {
      await use(tracker);
    } finally {
      tracker.flush();
    }
  },

  signedIn: [async ({ page, tester, log }, use) => {
    await loginAs(page, tester, log);
    await use();
  }, { auto: true }],
});

/**
 * Everything a bug scenario is handed. Spelled out rather than inferred from
 * `test`, whose call signature is overloaded — inference there picks the
 * `TestDetails` overload and collapses the argument to `never`.
 */
export type BugArgs = PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs
  & PlaywrightWorkerOptions & Fixtures & BugFixtures;

/**
 * Declares one scenario per bug sheet row.
 *
 * The id and the fallback title are the spec's; everything else — module,
 * severity, the reporter's steps, the status the sheet claims — is pulled from
 * `data/bugs.csv` when it is there. The title is repeated in the spec rather than
 * read from the sheet alone so that the test list stays readable without the CSV,
 * and so a renamed row does not silently detach a spec from its bug.
 *
 * Any error escaping the body is recorded as BLOCKED before it is re-thrown: a
 * setup that fell over is a thing the reader must see, not a missing line.
 */
export function bugSpec(id: string, title: string, body: (args: BugArgs) => Promise<void>) {
  test(`${id} — ${title}`, async (args) => {
    const { bug } = args;
    bug.about(bugRow(id, title));
    try {
      await body(args);
    } catch (error) {
      // An assertion the spec chose to make hard, or a crash. Either way the run
      // never reached a verdict of its own.
      if (bug.verdict === "NOT VERIFIED" || bug.verdict === "FIXED") {
        bug.blocked((error as Error).message.split("\n").slice(0, 4).join(" "));
      }
      throw error;
    }
    bug.assertFixed();
  });
}

export { expect };
