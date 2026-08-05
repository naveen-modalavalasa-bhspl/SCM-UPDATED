import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { ROOT, type Account } from "../../src/config.js";

/**
 * Read-side helpers for the invariant regression suite.
 *
 * Every spec beside this file asserts one BUSINESS INVARIANT that live data broke
 * during the 2026-08-05 QA pass. They are written to fail while the defect is
 * present and pass once it is fixed, so a red run here is the expected state
 * until the fixes land. Nothing here writes to the application — the suite reads
 * the whole document set through the API and checks the rule across all of it.
 *
 * Deliberately NOT scripted: defects already proven by reading the source
 * (auth/service.py's undefined PermissionError_, unscoped Home KPI counts, the
 * empty-reason Reject button). A test there restates what the code already says
 * and only adds maintenance.
 */

interface UsersFile {
  raiser: Account;
  approvers: Account[];
  inventory?: Account;
  /** Any login that can read every module — needed for cross-module count checks. */
  admin?: Account;
}

export function users(): UsersFile {
  const path = resolve(ROOT, "users.json");
  if (!existsSync(path)) {
    throw new Error("playwright-tests/users.json is missing — copy users.example.json.");
  }
  return JSON.parse(readFileSync(path, "utf8")) as UsersFile;
}

/**
 * The account the invariant specs read with. It must see every warehouse and every
 * project: an invariant checked through a scoped login proves nothing about the
 * documents that login cannot see.
 */
export function reader(): Account {
  const list = users();
  const who = list.admin ?? list.inventory;
  if (!who) {
    throw new Error(
      "users.json needs an 'admin' (or at least 'inventory') account — these specs " +
        "check a rule across every document, so they need an unscoped reader.",
    );
  }
  return who;
}

export interface PagedBody<T> { items: T[]; total: number }

export class Api {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly request: APIRequestContext) {}

  async token(account: Account): Promise<string> {
    const cached = this.tokens.get(account.employeeId);
    if (cached) return cached;
    const response = await this.request.post("/api/auth/login", {
      form: { username: account.employeeId, password: account.password },
    });
    if (!response.ok()) {
      throw new Error(`Login failed for ${account.label}: ${response.status()} ${await response.text()}`);
    }
    const token = ((await response.json()) as { access_token: string }).access_token;
    this.tokens.set(account.employeeId, token);
    return token;
  }

  /** Unchecked response, for a spec that asserts on a status code rather than a body. */
  async raw(method: "get" | "post", path: string, as: Account, data?: unknown) {
    const headers = { Authorization: `Bearer ${await this.token(as)}` };
    return method === "get"
      ? this.request.get(path, { headers })
      : this.request.post(path, { headers, data: data ?? {} });
  }

  async get<T>(path: string, as: Account): Promise<T> {
    const response = await this.request.get(path, {
      headers: { Authorization: `Bearer ${await this.token(as)}` },
    });
    if (!response.ok()) {
      throw new Error(`GET ${path} as ${as.label}: ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  /** Walks every page: a "one per indent" rule has to be checked against the whole set. */
  async all<T>(path: string, as: Account, size = 200): Promise<T[]> {
    const join = path.includes("?") ? "&" : "?";
    const out: T[] = [];
    for (let page = 1; page < 100; page += 1) {
      const body = await this.get<PagedBody<T>>(`${path}${join}page=${page}&size=${size}`, as);
      const items = body.items ?? [];
      out.push(...items);
      if (!items.length || out.length >= (body.total ?? 0)) break;
    }
    return out;
  }
}

/** Groups rows by a key, keeping only the groups that hold more than one row. */
export function duplicatesBy<T>(
  rows: T[], key: (row: T) => string | number | null | undefined,
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    if (value === null || value === undefined || value === "") continue;
    const bucket = groups.get(String(value)) ?? [];
    bucket.push(row);
    groups.set(String(value), bucket);
  }
  return [...groups.entries()].filter(([, bucket]) => bucket.length > 1);
}
