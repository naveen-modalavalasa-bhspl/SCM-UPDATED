import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { Bell, CheckCheck } from "lucide-react";
import { api } from "@/shared/api/client";

/**
 * Unread alerts for the signed-in person, from `sys_notifications`.
 *
 * That table was being written to — inventory raises a row when stock drops under its
 * minimum, warehouse raises one when a document needs someone — with nowhere in the
 * app to read it. Rows accumulated and nobody ever saw them.
 *
 * Reads `/api/notifications`, which is scoped to the caller and needs only a login.
 * The warehouse module's copy of these routes is gated on `stock.view`, so the shell
 * cannot use it: a requester would get a 403 on their own alerts.
 */

interface NotificationRow {
  id: number;
  title: string;
  body?: string | null;
  deep_link?: string | null;
  is_read: boolean;
  created_at: string;
}

const KEY = ["notifications"];
const COUNT_KEY = ["notifications", "unread-count"];

const ago = (iso: string) => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
};

export function NotificationBell() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  // Polled rather than pushed: there is no websocket in this app and a minute-old
  // count is fine for a stock alert. Swap for a subscription if that changes.
  const { data: unread } = useQuery({
    queryKey: COUNT_KEY,
    queryFn: () => api.get<{ count: number }>("/api/notifications/unread-count")
      .then((r) => r.data.count),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Only fetched once the panel is opened — the badge alone needs just the count.
  const { data: rows = [], isLoading } = useQuery({
    queryKey: KEY,
    queryFn: () => api.get<{ items: NotificationRow[] }>("/api/notifications", {
      params: { size: 20 },
    }).then((r) => r.data.items ?? []),
    enabled: open,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: KEY });
    qc.invalidateQueries({ queryKey: COUNT_KEY });
  };

  const markRead = useMutation({
    mutationFn: (id: number) => api.post(`/api/notifications/${id}/read`),
    onSuccess: refresh,
  });
  const markAll = useMutation({
    mutationFn: () => api.post("/api/notifications/read-all"),
    onSuccess: refresh,
  });

  const openRow = (row: NotificationRow) => {
    if (!row.is_read) markRead.mutate(row.id);
    setOpen(false);
    if (row.deep_link) nav(row.deep_link);
  };

  const count = unread ?? 0;

  return (
    <Popover isOpen={open} onOpenChange={setOpen} placement="bottom-end">
      <PopoverTrigger>
        <button
          aria-label={count ? `Notifications, ${count} unread` : "Notifications"}
          className="relative flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-content2 hover:text-ink"
        >
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold text-white">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex w-full items-center justify-between border-b border-line px-4 py-3">
          <span className="font-semibold text-ink">Notifications</span>
          {count > 0 && (
            <button
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
              className="flex items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          )}
        </div>

        <div className="max-h-96 w-full overflow-y-auto">
          {isLoading && <p className="px-4 py-6 text-sm text-muted">Loading…</p>}
          {!isLoading && rows.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">Nothing to catch up on.</p>
          )}
          {rows.map((row) => (
            <button
              key={row.id}
              onClick={() => openRow(row)}
              className={`flex w-full flex-col items-start gap-0.5 border-b border-line/60 px-4 py-3 text-left last:border-0 hover:bg-content2 ${
                row.is_read ? "" : "bg-brand/5"
              }`}
            >
              <div className="flex w-full items-start gap-2">
                {!row.is_read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />}
                <span className={`flex-1 text-sm ${row.is_read ? "text-body" : "font-semibold text-ink"}`}>
                  {row.title}
                </span>
              </div>
              {row.body && <span className="text-xs text-muted">{row.body}</span>}
              <span className="text-[11px] text-muted">{ago(row.created_at)}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
