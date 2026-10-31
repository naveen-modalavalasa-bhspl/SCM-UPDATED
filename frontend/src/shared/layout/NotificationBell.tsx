import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { ArrowRight, Bell, BellOff, CheckCheck } from "lucide-react";
import {
  notificationKeys, notificationsApi, type NotificationRow,
} from "@/shared/api/notifications";
import { NotificationItem } from "@/shared/components/NotificationItem";

/**
 * Unread alerts for the signed-in person, from `sys_notifications`.
 *
 * That table was being written to — inventory raises a row when stock drops under its
 * minimum, warehouse raises one when a document needs someone — with nowhere in the
 * app to read it. Rows accumulated and nobody ever saw them.
 *
 * Reads `shared/api/notifications`, which hits `/api/notifications` — scoped to the
 * caller and needs only a login. The warehouse module's copy of these routes is gated
 * on `stock.view`, so the shell cannot use it: a requester would get a 403 on their
 * own alerts. SCM_0056: the full Alerts & Notifications page (`modules/notifications`)
 * reads the exact same module, so a notification shown here is never invisible there.
 */

const KEY = notificationKeys.list({ size: 20 });
const COUNT_KEY = notificationKeys.unreadCount;

export function NotificationBell() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  // Polled rather than pushed: there is no websocket in this app and a minute-old
  // count is fine for a stock alert. Swap for a subscription if that changes.
  const { data: unread } = useQuery({
    queryKey: COUNT_KEY,
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Only fetched once the panel is opened — the badge alone needs just the count.
  const { data: rows = [], isLoading } = useQuery({
    queryKey: KEY,
    queryFn: () => notificationsApi.list({ size: 20 }).then((r) => r.items ?? []),
    enabled: open,
  });

  const refresh = () => {
    // Every list this module feeds — the bell's own 20 and the full page's — so
    // reading one here can never leave the other showing a stale unread flag.
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };

  const markRead = useMutation({
    mutationFn: notificationsApi.markRead,
    onSuccess: refresh,
  });
  const markAll = useMutation({
    mutationFn: notificationsApi.markAllRead,
    onSuccess: refresh,
  });

  // SCM_0075: the row is a link to its own document (or to the inbox focused on
  // itself), so a click always lands somewhere. This only marks it read and closes
  // the panel; the link does the navigating.
  const openRow = (row: NotificationRow) => {
    if (!row.is_read) markRead.mutate(row.id);
    setOpen(false);
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
      <PopoverContent className="w-[min(26rem,calc(100vw-2rem))] overflow-hidden p-0">
        <div className="flex w-full items-center justify-between gap-2 border-b border-line bg-gradient-to-r from-brand/[0.06] to-content1 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ink">Notifications</span>
            {count > 0 && (
              <span className="rounded-full bg-brand px-2 py-0.5 text-[11px] font-bold text-white">{count} new</span>
            )}
          </div>
          {count > 0 && (
            <button
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
              className="flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-brand hover:bg-brand/10 disabled:opacity-50"
            >
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          )}
        </div>

        <div className="max-h-[26rem] w-full overflow-y-auto">
          {isLoading && (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((k) => (
                <div key={k} className="flex gap-3">
                  <div className="h-9 w-9 animate-pulse rounded-xl bg-content2" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-3/4 animate-pulse rounded bg-content2" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-content2" />
                  </div>
                </div>
              ))}
            </div>
          )}
          {!isLoading && rows.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-content2 text-muted"><BellOff className="h-5 w-5" /></span>
              <p className="text-sm font-semibold text-ink">You're all caught up</p>
              <p className="text-xs text-muted">Approvals, orders and deliveries will show up here as they move.</p>
            </div>
          )}
          {rows.map((row) => (
            <NotificationItem
              key={row.id}
              row={row}
              variant="compact"
              onOpen={openRow}
              onMarkRead={(r) => markRead.mutate(r.id)}
            />
          ))}
        </div>

        {/* SCM_0056: the full inbox, same data as above — this panel only ever
            offered the newest 20 with no way to search or page through the rest. */}
        <button
          onClick={() => { setOpen(false); nav("/notifications"); }}
          className="flex w-full items-center justify-center gap-1.5 border-t border-line bg-content2/40 px-4 py-3 text-sm font-semibold text-brand hover:bg-content2"
        >
          View all notifications <ArrowRight className="h-4 w-4" />
        </button>
      </PopoverContent>
    </Popover>
  );
}
