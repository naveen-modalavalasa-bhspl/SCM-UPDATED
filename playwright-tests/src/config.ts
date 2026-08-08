import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: resolve(ROOT, ".env") });

const num = (key: string, fallback: number) => {
  const raw = process.env[key];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (key: string, fallback: boolean) => {
  const raw = process.env[key];
  return raw === undefined ? fallback : /^(1|true|yes)$/i.test(raw);
};

export const config = {
  baseURL: process.env.BASE_URL || "http://localhost:5173",
  apiURL: process.env.API_URL || "http://localhost:8000",
  slowRequestMs: num("SLOW_REQUEST_MS", 1500),
  slowPageMs: num("SLOW_PAGE_MS", 3000),
  a11y: bool("A11Y", true),
  // Pauses between actions so a headed run is watchable at human speed.
  slowMo: num("SLOW_MO", 0),
  screenshotEveryStep: bool("SCREENSHOT_EVERY_STEP", true),
  reportsDir: resolve(ROOT, "reports"),

  /* ---------------------------------------------- indent-module suite settings */

  /**
   * How many drafts the Indent suite raises before it starts.
   *
   * Must exceed the list page size (20) or "page 2" is a control the run can
   * never touch, and every pagination assertion becomes decoration.
   */
  seedCount: num("SEED_COUNT", 24),

  /**
   * Whether the run may actually confirm a delivery.
   *
   * Confirming receipt writes `received_qty` and can close a real indent — it is
   * the one irreversible thing in the module. Off by default: the run still opens
   * the modal, checks its arithmetic, uploads and deletes a photo, and proves the
   * no-photo rule by letting the server refuse the confirm. Turn it on only
   * against a database you are willing to change.
   */
  allowDeliveryConfirm: bool("ALLOW_DELIVERY_CONFIRM", false),
};

export interface Account {
  employeeId: string;
  password: string;
  label: string;
  /**
   * Which of the employee's positions to work as. One person can hold several —
   * an Assistant Manager at one warehouse and an Inventory Manager at another —
   * and scope and permissions follow the *active* position, not the person. Left
   * out, the run uses whatever the login defaults to. Matched on the name shown in
   * the "Working as" switcher; a substring is enough.
   */
  position?: string;
  /**
   * Every hat this person must sign under, in ladder order. A post-based ladder
   * asks one person for one signature per post, so a run has to switch between
   * them; a single `position` is not enough to express that.
   */
  hats?: string[];
}

interface Users {
  /** The single account the Indent module suite drives. Optional; falls back to `raiser`. */
  tester?: Account;
  raiser: Account;
  approvers: Account[];
  inventory?: Account;
  /** Unscoped reader/writer for specs that configure rather than transact. */
  admin?: Account;
  /** One real reporting line, bottom-up: storekeeper first, then each rung above
   *  them. The cascade spec walks it in order, so the ARRAY ORDER is the ladder. */
  cascadeChain?: Account[];
}

/**
 * The one login the Indent module suite runs as.
 *
 * That suite is a functional sweep of a module's own screens, not a journey
 * across an approval ladder, so it needs exactly one identity — whichever one you
 * hand it. Everything it asserts is derived from what *that* account can see:
 * the dataset is raised under it, and every expectation is recomputed from the
 * API as the same account, so the run is correct for a store keeper, a manager or
 * an administrator without a line of it changing.
 */
export function loadTester(): Account {
  const account = readUsersFile().tester ?? readUsersFile().raiser;
  if (!account?.employeeId || !account.password) {
    throw new Error(
      "playwright-tests/users.json needs a 'tester' (or 'raiser') entry with an employeeId and password. "
        + "The Indent module suite runs as one account and needs nothing else.",
    );
  }
  return account;
}

function readUsersFile(): Users {
  const path = resolve(ROOT, "users.json");
  if (!existsSync(path)) {
    throw new Error(
      "playwright-tests/users.json is missing. Copy users.example.json to users.json and fill in real logins.",
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Users;
}

/**
 * Logins live in users.json, which is gitignored — no credential ever lands in a
 * committed file. The approver list is a pool, not an order: the run asks the API
 * who the document is actually waiting on at each rung, so re-configuring the
 * approval ladder does not mean editing a test.
 *
 * Only the cross-login journey suites need this. A single-module sweep should use
 * `loadTester()`, which asks for one account and nothing more.
 */
export function loadUsers(): Users {
  const parsed = readUsersFile();
  if (!parsed.raiser?.employeeId) throw new Error("users.json: 'raiser' needs an employeeId and password.");
  if (!Array.isArray(parsed.approvers) || !parsed.approvers.length) {
    throw new Error("users.json: 'approvers' must list at least one account.");
  }
  return parsed;
}
