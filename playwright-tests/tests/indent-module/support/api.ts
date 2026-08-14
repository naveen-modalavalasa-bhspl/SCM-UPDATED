import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { Account } from "../../../src/config.js";

/**
 * A full-verb client for every endpoint the Indent module screens call.
 *
 * The browser drives the app; this exists to answer, independently, what the app
 * *should* be showing. Every filter assertion in this suite works the same way:
 * apply the filter by clicking, read the URL the app produced, ask this client
 * for the same query, and compare. A test that only checks "the list changed"
 * passes when the list changes to the wrong thing — this is what makes the
 * difference.
 *
 * It also returns raw responses on demand, because part of testing a screen is
 * what the server refuses when the screen is bypassed.
 */

export interface PageShape<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface IndentSnapshot {
  id: number;
  indent_no: string;
  status: string;
  priority?: string;
  required_date?: string | null;
  remarks?: string | null;
  office_id?: number | null;
  requested_by_id?: number;
  requested_by_name?: string | null;
  department_name?: string | null;
  position_name?: string | null;
  created_at?: string | null;
  total_items?: number;
  current_approver_name?: string | null;
  can_submit?: boolean;
  can_approve?: boolean;
  can_reject?: boolean;
  items: {
    id: number;
    item_id: number;
    item_code?: string | null;
    item_name?: string | null;
    uom_code?: string | null;
    quantity: number | string;
  }[];
}

export interface IndentStats {
  total: number;
  draft: number;
  awaiting_approval: number;
  approved_active: number;
  rejected: number;
  this_month: number;
  total_items: number;
  total_qty: number;
  approval_rate: number;
  by_status: Record<string, number>;
}

export interface ActivityRow {
  event_id?: string;
  indent_id: number;
  indent_no: string;
  event_type?: string | null;
  event_label?: string | null;
  result?: string | null;
  result_label?: string | null;
  occurred_at?: string | null;
  event_at?: string | null;
  quantity?: number | string | null;
  uom_code?: string | null;
  department_name?: string | null;
  office_name?: string | null;
  actor_name?: string | null;
  remarks?: string | null;
}

export interface NotificationRow {
  id: string | number;
  indent_id: number;
  indent_no: string;
  title: string;
  message: string;
  status: string;
  created_at: string;
}

export interface AcknowledgementLine {
  indent_item_id: number;
  item_code?: string | null;
  item_name?: string | null;
  uom_code?: string | null;
  approved_quantity: number;
  issued_quantity: number;
  dispatched_quantity: number;
  received_quantity: number;
  pending_with?: string | null;
}

export interface Acknowledgement {
  indent_id: number;
  indent_no: string;
  indent_date?: string | null;
  required_date?: string | null;
  status: string;
  project_name?: string | null;
  can_acknowledge: boolean;
  lines: AcknowledgementLine[];
}

export interface ReceiptAttachment {
  id: number;
  file_name: string;
  doc_category: string;
}

export interface JourneySnapshot {
  indent_no: string;
  status: string;
  current_stage_message?: string | null;
  stages: {
    sequence?: number;
    stage_type?: string;
    title?: string;
    status: string;
    is_current?: boolean;
    timestamp?: string | null;
    approver_name?: string | null;
    position_name?: string | null;
  }[];
  history?: { id: string | number; title: string; timestamp?: string | null }[];
  phases?: { key?: string; sequence?: number; state?: string }[];
}

export interface CatalogueItem {
  id: number;
  code: string;
  name: string;
  uom_code?: string | null;
}

export class IndentApi {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly request: APIRequestContext) {}

  /**
   * A token for the account, honouring its configured position.
   *
   * Scope follows the *active* position, not the person: the same login can be
   * blind to a document under one hat and own it under another. A run that never
   * switches is silently testing whichever position happened to be the default,
   * and its oracle would then disagree with the browser.
   */
  async token(account: Account): Promise<string> {
    const cacheKey = `${account.employeeId}@${account.position ?? "default"}`;
    const cached = this.tokens.get(cacheKey);
    if (cached) return cached;

    const response = await this.request.post("/api/auth/login", {
      form: { username: account.employeeId, password: account.password },
    });
    if (!response.ok()) {
      throw new Error(
        `Login failed for ${account.label} (${account.employeeId}): ${response.status()} ${await response.text()}`,
      );
    }
    let token = ((await response.json()) as { access_token: string }).access_token;

    if (account.position) {
      const me = await this.request.get("/api/auth/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!me.ok()) {
        throw new Error(`Could not read positions for ${account.label}: ${me.status()} ${await me.text()}`);
      }
      const body = (await me.json()) as {
        positions: { id: number; name: string }[];
        active_position?: { id: number; name: string } | null;
      };
      const wanted = account.position.toLowerCase();
      const position = body.positions.find((candidate) => candidate.name.toLowerCase().includes(wanted));
      if (!position) {
        throw new Error(
          `${account.label} has no position matching "${account.position}". `
            + `Available: ${body.positions.map((candidate) => candidate.name).join(", ") || "none"}.`,
        );
      }
      if (body.active_position?.id !== position.id) {
        const switched = await this.request.post("/api/auth/switch-position", {
          headers: { Authorization: `Bearer ${token}` },
          data: { position_id: position.id },
        });
        if (!switched.ok()) {
          throw new Error(
            `Could not switch ${account.label} to "${position.name}": ${switched.status()} ${await switched.text()}`,
          );
        }
        token = ((await switched.json()) as { access_token: string }).access_token;
      }
    }

    this.tokens.set(cacheKey, token);
    return token;
  }

  /** The raw response — status and body — with no success assumption. */
  async call(
    method: "get" | "post" | "put" | "delete",
    path: string,
    account: Account | null,
    data?: unknown,
  ): Promise<APIResponse> {
    const headers: Record<string, string> = {};
    if (account) headers.Authorization = `Bearer ${await this.token(account)}`;
    return this.request.fetch(path, { method, headers, ...(data === undefined ? {} : { data }) });
  }

  /** Status plus whatever message the app put in the body, never throwing. */
  async probe(
    method: "get" | "post" | "put" | "delete",
    path: string,
    account: Account | null,
    data?: unknown,
  ): Promise<{ status: number; body: string; error: string }> {
    const response = await this.call(method, path, account, data);
    const body = await response.text();
    let error = "";
    try {
      const parsed = JSON.parse(body) as { error?: string | { message?: string }; detail?: unknown };
      error = typeof parsed.error === "string"
        ? parsed.error
        : (parsed.error as { message?: string })?.message ?? JSON.stringify(parsed.detail ?? "");
    } catch {
      error = body.slice(0, 300);
    }
    return { status: response.status(), body: body.slice(0, 600), error };
  }

  private async json<T>(path: string, account: Account): Promise<T> {
    const response = await this.call("get", path, account);
    if (!response.ok()) {
      throw new Error(`GET ${path} as ${account.label}: ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  /* ------------------------------------------------------------ the oracle reads */

  /** `query` is a raw query string, so a test can pass exactly what the URL held. */
  list(query: string, as: Account) {
    return this.json<PageShape<IndentSnapshot>>(`/api/indents${query ? `?${query}` : ""}`, as);
  }

  stats(query: string, as: Account) {
    return this.json<IndentStats>(`/api/indents/stats${query ? `?${query}` : ""}`, as);
  }

  activity(query: string, as: Account) {
    return this.json<PageShape<ActivityRow>>(`/api/indents/activity${query ? `?${query}` : ""}`, as);
  }

  notifications(query: string, as: Account) {
    return this.json<PageShape<NotificationRow>>(`/api/indents/notifications${query ? `?${query}` : ""}`, as);
  }

  acknowledgements(query: string, as: Account) {
    return this.json<Acknowledgement[]>(`/api/warehouse/acknowledgements/mine${query ? `?${query}` : ""}`, as);
  }

  indent(id: number, as: Account) {
    return this.json<IndentSnapshot>(`/api/indents/${id}`, as);
  }

  journey(id: number, as: Account) {
    return this.json<JourneySnapshot>(`/api/indents/${id}/journey`, as);
  }

  attachments(indentId: number, as: Account) {
    return this.json<ReceiptAttachment[]>(`/api/indents/${indentId}/receipt-attachments`, as);
  }

  me(as: Account) {
    return this.json<{
      employee: { id: number; name?: string; code?: string; department_name?: string | null };
      active_position?: { id: number; name: string; office_id?: number | null } | null;
      permissions?: string[];
    }>("/api/auth/me", as);
  }

  async items(as: Account, size = 50): Promise<CatalogueItem[]> {
    const body = await this.json<PageShape<CatalogueItem>>(`/api/items?size=${size}`, as);
    return body.items ?? [];
  }

  /* ------------------------------------------------------------------- the writes */

  /** A draft raised straight through the API — setup, never the thing under test. */
  async createDraft(
    as: Account,
    itemId: number,
    quantity: number,
    extra: Record<string, unknown> = {},
  ): Promise<IndentSnapshot> {
    const response = await this.call("post", "/api/indents", as, {
      priority: "NORMAL",
      remarks: "Fixture raised by the indent-module run.",
      items: [{ item_id: itemId, quantity }],
      ...extra,
    });
    if (!response.ok()) {
      throw new Error(`Could not raise a fixture indent: ${response.status()} ${await response.text()}`);
    }
    return (await response.json()) as IndentSnapshot;
  }

  deleteIndent(id: number, as: Account) {
    return this.probe("delete", `/api/indents/${id}`, as);
  }
}
