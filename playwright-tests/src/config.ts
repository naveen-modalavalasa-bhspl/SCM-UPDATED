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
}

interface Users {
  raiser: Account;
  approvers: Account[];
  inventory?: Account;
}

/**
 * Logins live in users.json, which is gitignored — no credential ever lands in a
 * committed file. The approver list is a pool, not an order: the run asks the API
 * who the document is actually waiting on at each rung, so re-configuring the
 * approval ladder does not mean editing a test.
 */
export function loadUsers(): Users {
  const path = resolve(ROOT, "users.json");
  if (!existsSync(path)) {
    throw new Error(
      "playwright-tests/users.json is missing. Copy users.example.json to users.json and fill in real logins.",
    );
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Users;
  if (!parsed.raiser?.employeeId) throw new Error("users.json: 'raiser' needs an employeeId and password.");
  if (!Array.isArray(parsed.approvers) || !parsed.approvers.length) {
    throw new Error("users.json: 'approvers' must list at least one account.");
  }
  return parsed;
}
