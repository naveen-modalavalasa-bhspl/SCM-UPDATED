import type { APIRequestContext } from "@playwright/test";
import type { Account } from "./config.js";

export interface PendingItem {
  instance_id: number;
  doc_type: string;
  doc_id: number;
  doc_no?: string | null;
}

export interface IndentSnapshot {
  id: number;
  indent_no: string;
  status: string;
  current_approver_name?: string | null;
  items: { item_id: number; quantity: number }[];
}

/**
 * A thin read-side client over the backend.
 *
 * The browser drives every action — that is the point of the run. The API is used
 * only to answer questions the UI cannot answer cheaply: what status is the
 * document in now, and which of the configured accounts is the ladder actually
 * waiting on. That keeps the test independent of the approval configuration: add
 * a rung in Settings > Approvals Config and the same test still walks it.
 */
export class ApiClient {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly request: APIRequestContext) {}

  async login(account: Account): Promise<string> {
    const cached = this.tokens.get(account.employeeId);
    if (cached) return cached;
    const response = await this.request.post("/api/auth/login", {
      form: { username: account.employeeId, password: account.password },
    });
    if (!response.ok()) {
      throw new Error(
        `Login failed for ${account.label} (${account.employeeId}): ${response.status()} ${await response.text()}`,
      );
    }
    const token = ((await response.json()) as { access_token: string }).access_token;
    this.tokens.set(account.employeeId, token);
    return token;
  }

  private async get<T>(path: string, account: Account): Promise<T> {
    const token = await this.login(account);
    const response = await this.request.get(path, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok()) {
      throw new Error(`GET ${path} as ${account.label}: ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  indent(indentId: number, as: Account) {
    return this.get<IndentSnapshot>(`/api/indents/${indentId}`, as);
  }

  async pending(as: Account): Promise<PendingItem[]> {
    const body = await this.get<{ items: PendingItem[] }>("/api/workflow/pending", as);
    return body.items ?? [];
  }

  async allocationsFor(indentId: number, as: Account) {
    const body = await this.get<{ items: { id: number; allocation_no: string; status: string }[] }>(
      `/api/allocations?indent_id=${indentId}&size=50`,
      as,
    );
    return body.items ?? [];
  }

  history(docType: string, docId: number, as: Account) {
    return this.get<{ items: { actor_name: string; action: string; stage_name: string }[] }>(
      `/api/workflow/history/${docType}/${docId}`,
      as,
    );
  }

  /** Which configured account currently owns this document's approval, if any. */
  async whoIsItWaitingOn(indentId: number, pool: Account[]): Promise<Account | null> {
    for (const account of pool) {
      const items = await this.pending(account).catch(() => [] as PendingItem[]);
      if (items.some((item) => item.doc_id === indentId && item.doc_type.toUpperCase() === "INDENT")) {
        return account;
      }
    }
    return null;
  }
}
