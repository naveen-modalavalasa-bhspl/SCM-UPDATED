import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { ROOT, type Account } from "../../src/config.js";
import type { RunLogger } from "../../src/logger.js";

import { createIndent, submitForApproval } from "../../src/pages/indents.js";

/**
 * Shared plumbing for the Approvals module suite.
 *
 * The suite drives every action through the browser — that is what is being
 * tested. The API is used for two things only: to find out which configured
 * account currently owns a document (so the ladder can be reconfigured without
 * editing a test), and to probe the guards a UI cannot reach (self-approval, a
 * second decision on an already-decided document, a reminder for somebody
 * outside your team). Those probes read the raw status and body rather than
 * throwing, because "what did the server answer" IS the finding.
 */

export interface UsersFile {
  raiser: Account;
  approvers: Account[];
  admin?: Account;
  inventory?: Account;
}

export function users(): UsersFile {
  const path = resolve(ROOT, "users.json");
  if (!existsSync(path)) {
    throw new Error("playwright-tests/users.json is missing — copy users.example.json.");
  }
  return JSON.parse(readFileSync(path, "utf8")) as UsersFile;
}

/**
 * The account used to read a document's status back.
 *
 * Deliberately not the requester: a raiser can be left without `indent.view` on
 * their working position, and a status check that 403s tells you nothing about
 * the document. The status must be read by somebody who can always see it.
 */
export function reader(list: UsersFile): Account {
  return list.admin ?? list.inventory ?? list.approvers[0]!;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  body: string;
  json: any;
}

export interface PendingRow {
  instance_id: number;
  doc_type: string;
  doc_id: number;
  doc_no?: string | null;
  summary?: string | null;
  requested_by_name?: string | null;
  current_stage_name?: string | null;
  waiting_since?: string | null;
  due_at?: string | null;
  stage_sequence?: number;
  amount?: number | null;
}

export class ApprovalsApi {
  private readonly tokens = new Map<string, string>();

  constructor(readonly request: APIRequestContext) {}

  async token(account: Account): Promise<string> {
    const cached = this.tokens.get(account.employeeId);
    if (cached) return cached;
    // A dropped keep-alive connection (ECONNRESET) is a transport hiccup, not a
    // finding — retried once so it cannot abort a whole spec.
    let response;
    try {
      response = await this.request.post("/api/auth/login", {
        form: { username: account.employeeId, password: account.password },
      });
    } catch {
      response = await this.request.post("/api/auth/login", {
        form: { username: account.employeeId, password: account.password },
      });
    }
    if (!response.ok()) {
      throw new Error(`Login failed for ${account.label}: ${response.status()} ${await response.text()}`);
    }
    let token = ((await response.json()) as { access_token: string }).access_token;
    // Scope and permissions follow the ACTIVE position, not the person. An account
    // that names a position must carry it on every call, or an API probe answers
    // for a hat the run is not wearing.
    if (account.position) token = await this.switchPosition(token, account);
    this.tokens.set(account.employeeId, token);
    return token;
  }

  private async switchPosition(token: string, account: Account): Promise<string> {
    const me = await this.request.get("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
    const positions = (((await me.json()) as any)?.positions ?? []) as Array<{ id: number; name: string }>;
    const wanted = positions.find((position) =>
      String(position.name ?? "").toUpperCase().includes(account.position!.toUpperCase()));
    if (!wanted) {
      throw new Error(
        `${account.label} has no position matching "${account.position}". `
        + `Available: ${positions.map((p) => p.name).join(", ") || "none"}.`,
      );
    }
    const switched = await this.request.post("/api/auth/switch-position", {
      headers: { Authorization: `Bearer ${token}` },
      data: { position_id: wanted.id },
    });
    if (!switched.ok()) {
      throw new Error(`Switching ${account.label} to ${account.position} failed: ${switched.status()} ${await switched.text()}`);
    }
    return ((await switched.json()) as { access_token: string }).access_token;
  }

  private static async wrap(response: { status(): number; ok(): boolean; text(): Promise<string> }): Promise<RawResponse> {
    const body = await response.text();
    let json: any = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return { status: response.status(), ok: response.ok(), body: body.slice(0, 1200), json };
  }

  /** Never throws — the status and body are the observation. */
  async raw(method: "get" | "post" | "put", path: string, as: Account, data?: unknown): Promise<RawResponse> {
    const token = await this.token(as);
    const options = { headers: { Authorization: `Bearer ${token}` }, ...(data === undefined ? {} : { data }) };
    const response = method === "get"
      ? await this.request.get(path, options)
      : method === "post"
        ? await this.request.post(path, options)
        : await this.request.put(path, options);
    return ApprovalsApi.wrap(response);
  }

  async ok<T>(path: string, as: Account): Promise<T> {
    const response = await this.raw("get", path, as);
    if (!response.ok) throw new Error(`GET ${path} as ${as.label}: ${response.status} ${response.body}`);
    return response.json as T;
  }

  /** The whole approvals inbox for an account, unpaginated. */
  async pending(as: Account): Promise<PendingRow[]> {
    const body = await this.ok<{ items: PendingRow[]; total: number }>(
      "/api/approvals/pending?page=1&size=500", as);
    return body.items ?? [];
  }

  async decisions(as: Account): Promise<any[]> {
    const body = await this.ok<{ items: any[] }>("/api/approvals/my-decisions?page=1&size=500", as);
    return body.items ?? [];
  }

  async indent(id: number, as: Account) {
    return this.ok<{ id: number; indent_no: string; status: string; current_approver_name?: string | null }>(
      `/api/indents/${id}`, as);
  }

  /** Which configured account currently holds this indent in their approvals inbox. */
  async whoHasIndent(indentId: number, pool: Account[]): Promise<Account | null> {
    for (const account of pool) {
      const rows = await this.pending(account).catch(() => [] as PendingRow[]);
      if (rows.some((row) => row.doc_id === indentId && row.doc_type.toUpperCase() === "INDENT")) return account;
    }
    return null;
  }

  /** The first configured approver who has anything at all waiting on them. */
  async firstApproverWithWork(pool: Account[]): Promise<{ account: Account; rows: PendingRow[] } | null> {
    for (const account of pool) {
      const rows = await this.pending(account).catch(() => [] as PendingRow[]);
      if (rows.length) return { account, rows };
    }
    return null;
  }
}

/**
 * Puts an identity on the page without driving the login form.
 *
 * Driving the form costs ~10 seconds a time and this suite changes identity two
 * dozen times; the login screen is not what these specs are testing. The token
 * is fetched over the API — through the same endpoint the form posts to, so a
 * broken login still fails the run — switched to the requested position, and
 * written into localStorage before the app boots.
 */
export async function signIn(
  page: Page,
  api: ApprovalsApi,
  account: Account,
  log: RunLogger,
): Promise<void> {
  await log.runStep(`Sign in as ${account.label} (${account.employeeId})`, async () => {
    // token() already carries the account's working position, so the browser and
    // the API probes are always wearing the same hat.
    const token = await api.token(account);
    await page.addInitScript((value) => window.localStorage.setItem("token", value), token);
    await page.goto("/");
    await page.evaluate((value) => window.localStorage.setItem("token", value), token);
  });
}

/** Raises a brand-new indent through the UI and pushes it into the ladder. */
export async function raiseIndent(
  api: ApprovalsApi,
  page: Page,
  log: RunLogger,
  goto: (path: string, label?: string) => Promise<void>,
  raiser: Account,
  remarks: string,
): Promise<{ id: number; indentNo: string }> {
  await signIn(page, api, raiser, log);
  await goto("/indents/new", "new-indent-form");
  const created = await createIndent(page, log, { quantity: 6, remarks });
  await submitForApproval(page, log, created.id);
  return { id: created.id, indentNo: created.indentNo };
}

/**
 * An indent already waiting in some configured approver's inbox.
 *
 * Used by the validation specs, which never confirm a decision — reusing a live
 * document there is safe and leaves no throwaway data behind.
 */
export async function anyPendingIndent(
  api: ApprovalsApi,
  list: UsersFile,
): Promise<{ approver: Account; id: number; indentNo: string } | null> {
  for (const approver of list.approvers) {
    const rows = await api.pending(approver).catch(() => [] as PendingRow[]);
    const indent = rows.find((row) => row.doc_type.toUpperCase() === "INDENT");
    if (indent) {
      return { approver, id: indent.doc_id, indentNo: indent.doc_no ?? `#${indent.doc_id}` };
    }
  }
  return null;
}

/**
 * A freshly raised indent sitting in some configured approver's inbox, for the
 * specs that actually decide a document and must not consume real work.
 */
export async function pendingIndent(
  api: ApprovalsApi,
  page: Page,
  log: RunLogger,
  goto: (path: string, label?: string) => Promise<void>,
  list: UsersFile,
  remarks: string,
): Promise<{ approver: Account; id: number; indentNo: string }> {
  const raised = await raiseIndent(api, page, log, goto, list.raiser, remarks);
  const approver = await api.whoHasIndent(raised.id, list.approvers);
  if (!approver) {
    throw new Error(
      `${raised.indentNo} was submitted but no configured approver has it in /api/approvals/pending. `
      + `Add the holder to users.json.`,
    );
  }
  log.info(`${raised.indentNo} (id ${raised.id}) is waiting on ${approver.label}.`);
  return { approver, id: raised.id, indentNo: raised.indentNo };
}

/** Reads the number rendered inside a StatCard by its label. */
export async function statCard(page: Page, label: string): Promise<string> {
  const value = page.getByText(label, { exact: true }).first()
    .locator("xpath=../..").locator(".text-3xl").first();
  return (await value.innerText()).trim();
}

/**
 * Data rows currently rendered by a ResponsiveList (desktop table body).
 *
 * An empty HeroUI table still renders one row holding the empty-state message,
 * so counting `tr` alone reports 1 for a list showing nothing.
 */
export function listRows(page: Page) {
  return page.locator("table tbody tr").filter({ hasNot: page.locator('td[colspan]') });
}
