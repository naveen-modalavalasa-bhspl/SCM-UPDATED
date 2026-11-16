import { api } from "./client";

/**
 * The signed-in person's own notifications (`sys_notifications`), read by `/api/notifications`.
 *
 * ONE module for two readers — the bell (`shared/layout/NotificationBell.tsx`) and the
 * full-page Alerts & Notifications screen (`modules/notifications`). SCM_0056: those
 * two used to read different things — the bell read every notification addressed to
 * the user, the page read a derived, indent-only subset that silently dropped
 * everything else the bell showed (an allocation, a PO, a requisition...). Hooking
 * both to this one file is what keeps them from drifting apart again.
 */

export interface NotificationRow {
  id: number;
  title: string;
  body?: string | null;
  entity_type?: string | null;
  entity_id?: number | null;
  deep_link?: string | null;
  /** Where a click goes, resolved by the server on read (SCM_0074/0075): the row's own
   *  document, with stale or generic links already corrected. */
  target?: string | null;
  is_read: boolean;
  created_at: string;
}

/** Where opening this notification goes. A row with no document behind it opens the
 *  Alerts & Notifications page focused on itself — never a click that does nothing. */
export const notificationHref = (row: NotificationRow): string =>
  row.target ?? row.deep_link ?? `/notifications?tab=all&focus=${row.id}`;

/** Does the row point at a document (true), or only at itself on the inbox (false)? */
export const hasDocument = (row: NotificationRow): boolean => !!(row.target ?? row.deep_link);

export type NotificationKind =
  | "indent" | "procurement" | "warehouse" | "transfer" | "allocation" | "stock"
  | "logistics" | "approval" | "update";

/** What the notification is about, from its entity type — drives the icon and label. */
export function notificationKind(row: NotificationRow): NotificationKind {
  const t = (row.entity_type ?? "").toUpperCase();
  if (t.startsWith("INDENT") || t === "MONTHLY_INDENT") return "indent";
  if (["PO", "RFQ", "QUOTATION", "REQUISITION", "CONSOLIDATION", "MR", "DESPATCH_NOTE"].includes(t)) return "procurement";
  if (["WH_ISSUE", "ISSUE", "OWN_STOCK_ISSUE", "FORWARD_ISSUE", "GRN", "RECEIPT", "DISPATCH", "PURCHASE_RETURN"].includes(t)) return "warehouse";
  if (t.startsWith("STOCK_TRANSFER") || t === "STOCK_MOVEMENT_ORDER") return "transfer";
  if (t.includes("ALLOCATION")) return "allocation";
  if (["STK_BALANCE", "STOCK_ADJUSTMENT", "STOCK_EDIT"].includes(t)) return "stock";
  if (t === "TRANSPORT_REQUEST") return "logistics";
  if (["REMINDER", "ESCALATION", "APPROVAL_QUEUE"].includes(t)) return "approval";
  return "update";
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export const notificationKeys = {
  list: (params: Record<string, unknown>) => ["notifications", "list", params] as const,
  unreadCount: ["notifications", "unread-count"] as const,
};

export const notificationsApi = {
  list: (params: { page?: number; size?: number; unread_only?: boolean; search?: string } = {}) =>
    api.get<Paginated<NotificationRow>>("/api/notifications", { params })
      .then((r) => r.data),
  unreadCount: () =>
    api.get<{ count: number }>("/api/notifications/unread-count")
      .then((r) => r.data.count),
  markRead: (id: number) =>
    api.post<NotificationRow>(`/api/notifications/${id}/read`).then((r) => r.data),
  markAllRead: () =>
    api.post<{ count: number }>("/api/notifications/read-all").then((r) => r.data),
};
