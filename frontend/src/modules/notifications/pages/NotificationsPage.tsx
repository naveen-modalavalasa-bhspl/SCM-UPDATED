import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { Pagination } from "@heroui/react";
import {
  Button, Card, EmptyState, FilterBar, NotificationItem, PageHeader, SubNav,
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

/** "Today", "Yesterday", else the date — the headings the list is grouped under. */
const dayLabel = (iso: string) => {
  const day = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(new Date()) - start(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
};

export function NotificationsPage() {
  const qc = useQueryClient();
  const [urlParams, setUrlParams] = useSearchParams();
  const tab = urlParams.get("tab") === "all" ? "all" : "unread";
  const search = urlParams.get("search") ?? "";
  const page = Math.max(1, Number(urlParams.get("page")) || 1);
  // `?focus=<id>`: opened on one notification — one with no document behind it, from
  // the bell or from this list. It is highlighted and scrolled into view.
  const focusId = Number(urlParams.get("focus")) || null;
  const focusRef = useRef<HTMLAnchorElement>(null);
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

  // SCM_0074: each row is a link to its own document (resolved by the server), or to
  // this page focused on itself — a click always goes somewhere. Opening marks it read.
  const openRow = (row: NotificationRow) => {
    if (!row.is_read) markRead.mutate(row.id);
  };

  useEffect(() => {
    if (focusId && focusRef.current) focusRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusId, rows]);

  const groups = useMemo(() => {
    const out: { label: string; rows: NotificationRow[] }[] = [];
    for (const row of rows) {
      const label = dayLabel(row.created_at);
      const last = out[out.length - 1];
      if (last && last.label === label) last.rows.push(row);
      else out.push({ label, rows: [row] });
    }
    return out;
  }, [rows]);

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
        <div className={`space-y-6 transition-opacity ${isFetching ? "opacity-70" : ""}`}>
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h2 className="mb-2 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
                {group.label}
                <span className="h-px flex-1 bg-line" aria-hidden />
                <span className="normal-case tracking-normal">{group.rows.length}</span>
              </h2>
              <ul className="space-y-2.5">
                {group.rows.map((row) => (
                  <li key={row.id}>
                    <NotificationItem
                      ref={row.id === focusId ? focusRef : undefined}
                      row={row}
                      variant="full"
                      focused={row.id === focusId}
                      onOpen={openRow}
                      onMarkRead={(r) => markRead.mutate(r.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
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
