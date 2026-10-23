import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Pagination } from "@heroui/react";
import {
  Button, Card, EmptyState, FilterBar, PageHeader, SubNav,
} from "@/shared/components";
import { useDebouncedValue } from "@/shared/hooks/useDebouncedValue";
import {
  notificationKeys, notificationsApi, type NotificationRow,
} from "@/shared/api/notifications";

/**
 * Alerts & Notifications — the signed-in person's own full inbox.
 *
 * SCM_0056: this used to be `/indents/notifications`, a screen derived from the
 * indents table itself (one row per indent, current status only) rather than the
 * actual notification log. It showed a bell icon on every row and still missed most
 * of what the bell icon it borrowed actually announced — an allocation, a PO, a
 * requisition, anything not literally an indent-status event. This reads the exact
 * same `shared/api/notifications` module the bell does, so nothing shown there can
 * be invisible here. Top-level now, not nested under Indents, for the same reason:
 * it was never only about indents.
 */

const TABS = [
  { key: "unread", label: "Unread" },
  { key: "all", label: "Everything" },
];

const SIZE = 20;

const ago = (iso: string) => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
};

export function NotificationsPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [urlParams, setUrlParams] = useSearchParams();
  const tab = urlParams.get("tab") === "all" ? "all" : "unread";
  const search = urlParams.get("search") ?? "";
  const page = Math.max(1, Number(urlParams.get("page")) || 1);
  const debouncedSearch = useDebouncedValue(search);

  const [localSearch, setLocalSearch] = useState(search);

  // One writer for every filter here, so switching tabs or searching never fights
  // the page number left over from a different filter's results.
  const set = (next: Record<string, string | undefined>) => {
    setUrlParams((prev) => {
      const out = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(next)) {
        if (value) out.set(key, value); else out.delete(key);
      }
      out.delete("page");
      return out;
    }, { replace: true });
  };
  const setPage = (next: number) => {
    setUrlParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next > 1) out.set("page", String(next)); else out.delete("page");
      return out;
    }, { replace: true });
  };

  const queryParams = {
    page, size: SIZE,
    unread_only: tab === "unread" || undefined,
    search: debouncedSearch || undefined,
  };

  const { data, isLoading, isFetching } = useQuery({
    queryKey: notificationKeys.list(queryParams),
    queryFn: () => notificationsApi.list(queryParams),
    placeholderData: (previous) => previous,
  });

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / SIZE));

  const refresh = () => qc.invalidateQueries({ queryKey: ["notifications"] });

  const markRead = useMutation({
    mutationFn: notificationsApi.markRead,
    onSuccess: refresh,
  });
  const markAll = useMutation({
    mutationFn: notificationsApi.markAllRead,
    onSuccess: refresh,
  });

  const openRow = (row: NotificationRow) => {
    if (!row.is_read) markRead.mutate(row.id);
    if (row.deep_link) nav(row.deep_link);
  };

  const changeTab = (next: string) => {
    set({ tab: next === "all" ? "all" : undefined });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Alerts"
        title="Alerts & Notifications"
        actions={
          <Button onClick={() => markAll.mutate()} disabled={markAll.isPending}>
            <CheckCheck className="h-4 w-4" /> Mark all read
          </Button>
        }
      />

      <SubNav label="Notifications" items={TABS} value={tab} onChange={changeTab} />

      <FilterBar
        search={localSearch}
        onSearch={(value) => {
          setLocalSearch(value);
          set({ search: value || undefined });
        }}
        searchPlaceholder="Search title or message…"
        active={search ? 1 : 0}
        onClear={() => {
          setLocalSearch("");
          set({ search: undefined });
        }}
      />

      {isLoading ? (
        <Card><p className="p-5 text-sm text-muted">Loading notifications…</p></Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title={tab === "unread" ? "Nothing unread" : "No notifications"}
          hint="Approvals, allocations, orders and deliveries raise a notification as your requests move — the same ones the bell shows."
        />
      ) : (
        <ul className={`space-y-2 transition-opacity ${isFetching ? "opacity-70" : ""}`}>
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => openRow(row)}
                className="block w-full text-left"
                disabled={!row.deep_link && row.is_read}
              >
                <Card className={`p-4 transition-colors ${row.is_read ? "" : "border-brand/40 bg-brand-050/40"}`}>
                  <div className="flex items-start gap-3">
                    <span className={`rounded-full p-2 ${row.is_read ? "bg-content2 text-muted" : "bg-info-bg text-info"}`}>
                      <Bell className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className={`text-sm ${row.is_read ? "font-medium text-body" : "font-semibold text-ink"}`}>
                        {row.title}
                      </span>
                      {row.body && <p className="mt-1 text-sm text-body">{row.body}</p>}
                      <p className="mt-1 text-xs text-muted">{ago(row.created_at)}</p>
                    </div>
                    {!row.is_read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />}
                  </div>
                </Card>
              </button>
            </li>
          ))}
        </ul>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex justify-center">
          <Pagination isCompact showControls color="primary" page={page}
                     total={totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  );
}
