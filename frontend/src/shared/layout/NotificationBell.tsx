import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { notificationHref, pinUrgent } from "@/shared/api/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@heroui/react";
import { ArrowRight, Bell, BellOff, BellRing, CheckCheck, MonitorSmartphone } from "lucide-react";
import {
  notificationKeys, notificationsApi, type NotificationRow,
} from "@/shared/api/notifications";
import { NotificationItem } from "@/shared/components/NotificationItem";
import {
  arrivals, desktopActive, desktopBatch, desktopSupported,
  needsInteraction, setDesktopPref, shouldOpenPanel,
} from "./notificationArrivals";


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
  // Rows that arrived since the page last looked, drawn with a "New" ring.
  const [fresh, setFresh] = useState<number[]>([]);
  // Rings from an arrival until the panel is looked at and closed.
  const [ringing, setRinging] = useState(false);
  const [desktopOn, setDesktopOn] = useState(desktopActive);
  const [blocked, setBlocked] = useState(() => desktopSupported() && Notification.permission === "denied");
  const seenUpTo = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const lastCount = useRef<number | null>(null);

  // Polled rather than pushed: there is no websocket in this app. Every 10 s, and on
  // returning to the tab — the count only; the list is read when it goes up.
  const { data: unread } = useQuery({
    queryKey: COUNT_KEY,
    queryFn: notificationsApi.unreadCount,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
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


  // The count went up (or this is the first read): read the list and see what is new.
  useEffect(() => {
    if (unread === undefined) return;
    const before = lastCount.current;
    lastCount.current = unread;
    if (before !== null && unread <= before) return;
    let live = true;
    qc.fetchQuery({
      queryKey: KEY, staleTime: 0,
      queryFn: () => notificationsApi.list({ size: 20 }).then((r) => r.items ?? []),
    }).then((list) => {
      if (!live) return;
      const result = arrivals(list, seenUpTo.current);
      seenUpTo.current = result.seenUpTo;
      if (!result.fresh.length) return;
      setFresh((f) => [...new Set([...result.fresh, ...f])]);
      const newRows = list.filter((r) => result.fresh.includes(r.id));
      // Both speak on every arrival: the panel in the app, and — when switched on — a
      // pop-up on the desktop, whether or not this tab is in front.
      if (desktopActive()) {
        for (const pop of desktopBatch(newRows)) {
          try {
            const n = new Notification(pop.title, {
              body: pop.body, tag: `scm-${pop.id}`, icon: "/favicon.ico",
              requireInteraction: !!pop.row && needsInteraction([pop.row], [pop.row.id]),
            });
            n.onclick = () => {
              window.focus();
              if (pop.row) { if (!pop.row.is_read) markRead.mutate(pop.row.id); nav(notificationHref(pop.row)); }
              else setOpen(true);
              n.close();
            };
          } catch { /* a browser that refuses page-made notifications */ }
        }
      }
      // Opens the moment it arrives — over a dialog too — and stays until closed.
      if (shouldOpenPanel({ fresh: result.fresh.length })) {
        setRinging(true);
        setOpen(true);
      }
    }).catch(() => { /* the next poll tries again */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);


  const toggleDesktop = async () => {
    if (!desktopSupported()) return;
    if (desktopOn) { setDesktopPref(false); setDesktopOn(false); return; }
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    setBlocked(permission === "denied");
    if (permission === "granted") {
      setDesktopPref(true); setDesktopOn(true);
      try { new Notification("Desktop alerts are on", { body: "You'll get a pop-up here the moment something arrives.", tag: "scm-desktop-on" }); }
      catch { /* fine */ }
    }
  };

  // SCM_0075: the row is a link to its own document (or to the inbox focused on
  // itself), so a click always lands somewhere. This only marks it read and closes
  // the panel; the link does the navigating.
  const openRow = (row: NotificationRow) => {
    if (!row.is_read) markRead.mutate(row.id);
    setOpen(false);
  };
  // Opened over a dialog, the panel lands in a layer the dialog has hidden from screen
  // readers (aria-hidden on everything outside it). Mark it as a top layer and lift the
  // flag, so it is read and reachable like the dialog itself.
  useEffect(() => {
    if (!open) return;
    const lift = () => {
      let el: HTMLElement | null = panelRef.current;
      while (el && el.parentElement && el.parentElement !== document.body) el = el.parentElement;
      if (el && el.parentElement === document.body) {
        el.setAttribute("data-react-aria-top-layer", "true");
        if (el.getAttribute("aria-hidden") === "true") el.removeAttribute("aria-hidden");
      }
    };
    const t = window.setTimeout(lift, 0);
    const t2 = window.setTimeout(lift, 120);
    return () => { window.clearTimeout(t); window.clearTimeout(t2); };
  }, [open]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) { setFresh([]); setRinging(false); }
  };

  const count = unread ?? 0;

  return (
    <Popover isOpen={open} onOpenChange={onOpenChange} placement="bottom-end">
      <PopoverTrigger>
        <button
          aria-label={count ? `Notifications, ${count} unread` : "Notifications"}
          className={`relative flex h-11 w-11 items-center justify-center rounded-lg hover:bg-content2 hover:text-ink ${ringing ? "text-brand" : "text-muted"}`}
        >
          {ringing
            ? <BellRing className="h-5 w-5 origin-top animate-[bell-ring_1s_ease-in-out_infinite]" />
            : <Bell className="h-5 w-5" />}
          {ringing && <span className="absolute inset-1 animate-ping rounded-lg bg-brand/20" aria-hidden />}
          {count > 0 && (
            <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-bold text-white">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(26rem,calc(100vw-2rem))] overflow-hidden p-0">
        <div ref={panelRef} className="contents" />
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
          {pinUrgent(rows).map((row) => (
            <div key={row.id} className={fresh.includes(row.id) && !row.is_read
              ? "relative bg-brand/[0.04] shadow-[inset_3px_0_0] shadow-brand" : undefined}>
              {fresh.includes(row.id) && !row.is_read && (
                <span className="absolute right-3 top-2 z-10 rounded-full bg-brand px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">Just in</span>
              )}
              <NotificationItem
                row={row}
                variant="compact"
                onOpen={openRow}
                onMarkRead={(r) => markRead.mutate(r.id)}
              />
            </div>
          ))}
        </div>

        {/* Desktop pop-ups: per browser, the person's own choice (2026-11-23). */}
        {desktopSupported() && (
          <div className="flex w-full items-center gap-2.5 border-t border-line px-4 py-2.5">
            <MonitorSmartphone className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-ink">Desktop pop-ups</p>
              <p className="text-[11px] leading-4 text-muted">
                {blocked ? "Blocked for this site — allow notifications in the browser's site settings."
                  : desktopOn ? "On — a pop-up appears on your computer the moment one arrives."
                  : "Get a pop-up on your computer even while you work in another window."}
              </p>
            </div>
            <button type="button" role="switch" aria-checked={desktopOn} aria-label="Desktop pop-ups"
                    disabled={blocked} onClick={toggleDesktop}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${desktopOn ? "bg-brand" : "bg-content3"}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${desktopOn ? "left-[1.375rem]" : "left-0.5"}`} />
            </button>
          </div>
        )}

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
