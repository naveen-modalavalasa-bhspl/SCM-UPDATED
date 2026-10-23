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
  is_read: boolean;
  created_at: string;
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
