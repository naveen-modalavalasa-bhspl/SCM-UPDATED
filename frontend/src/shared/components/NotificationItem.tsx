import { forwardRef } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeftRight, Bell, BellRing, Check, ChevronRight, ClipboardList, Package, PackageCheck,
  ShoppingCart, TrendingDown, Truck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  hasDocument, notificationHref, notificationKind, type NotificationKind, type NotificationRow,
} from "@/shared/api/notifications";

/**
 * One notification, as the bell and the Alerts & Notifications page both draw it
 * (SCM_0074 / SCM_0075).
 *
 * It is a real LINK to the row's own document (`target`, resolved by the server), so a
 * click always goes somewhere and Ctrl / middle-click opens it in a new tab. A row with
 * no document behind it links to the inbox focused on itself. `onOpen` runs first — the
 * caller marks it read and closes whatever it sits in.
 */
const KIND: Record<NotificationKind, { label: string; icon: LucideIcon; tone: string }> = {
  indent: { label: "Indent", icon: ClipboardList, tone: "bg-info-bg text-info" },
  procurement: { label: "Procurement", icon: ShoppingCart, tone: "bg-brand/10 text-brand" },
  warehouse: { label: "Warehouse", icon: Package, tone: "bg-warn-bg text-warn" },
  transfer: { label: "Stock transfer", icon: ArrowLeftRight, tone: "bg-info-bg text-info" },
  allocation: { label: "Allocation", icon: PackageCheck, tone: "bg-ok-bg text-ok" },
  stock: { label: "Stock", icon: TrendingDown, tone: "bg-bad-bg text-bad" },
  logistics: { label: "Logistics", icon: Truck, tone: "bg-brand/10 text-brand" },
  approval: { label: "Approval", icon: BellRing, tone: "bg-warn-bg text-warn" },
  update: { label: "Update", icon: Bell, tone: "bg-content2 text-muted" },
};

export const timeAgo = (iso: string) => {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.floor(mins / 1440)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

export const NotificationItem = forwardRef<HTMLAnchorElement, {
  row: NotificationRow;
  /** `compact` for the bell's panel, `full` for the page. */
  variant?: "compact" | "full";
  /** Highlighted — the page was opened on this notification. */
  focused?: boolean;
  onOpen?: (row: NotificationRow) => void;
  /** Shown as a quiet "mark read" control on an unread row, without opening it. */
  onMarkRead?: (row: NotificationRow) => void;
}>(({ row, variant = "compact", focused = false, onOpen, onMarkRead }, ref) => {
  const kind = KIND[notificationKind(row)];
  const Icon = kind.icon;
  const opensDocument = hasDocument(row);
  const full = variant === "full";

  return (
    <div className="group relative">
      <Link
        ref={ref}
        to={notificationHref(row)}
        onClick={() => onOpen?.(row)}
        aria-label={`${row.title}${row.is_read ? "" : " (unread)"} — ${opensDocument ? `open the ${kind.label.toLowerCase()}` : "view details"}`}
        className={`flex w-full items-start gap-3 text-left outline-none transition-all focus-visible:ring-2 focus-visible:ring-brand/60 ${
          full
            ? `rounded-2xl border p-4 hover:-translate-y-px hover:shadow-md ${
              focused ? "border-brand bg-brand/5 ring-2 ring-brand/30"
                : row.is_read ? "border-line bg-content1 hover:border-brand/40"
                : "border-brand/30 bg-brand/[0.04] hover:border-brand/60"}`
            : `border-b border-line/60 px-4 py-3 hover:bg-content2 ${row.is_read ? "" : "bg-brand/[0.04]"}`
        }`}
      >
        <span className={`relative grid shrink-0 place-items-center rounded-xl ${full ? "h-10 w-10" : "h-9 w-9"} ${kind.tone}`}>
          <Icon className={full ? "h-5 w-5" : "h-4 w-4"} aria-hidden />
          {!row.is_read && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-content1" aria-hidden />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`min-w-0 flex-1 ${full ? "text-[15px]" : "text-sm"} ${
              row.is_read ? "font-medium text-body" : "font-semibold text-ink"} ${full ? "" : "line-clamp-2"}`}>
              {row.title}
            </span>
            <span className="shrink-0 text-[11px] text-muted" title={new Date(row.created_at).toLocaleString()}>
              {timeAgo(row.created_at)}
            </span>
          </span>
          {row.body && (
            <span className={`mt-0.5 block text-muted ${full ? "text-sm" : "line-clamp-2 text-xs"}`}>{row.body}</span>
          )}
          <span className="mt-1.5 flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${kind.tone}`}>
              {kind.label}
            </span>
            <span className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-brand opacity-70 transition-opacity group-hover:opacity-100">
              {opensDocument ? `Open ${kind.label === "Update" ? "" : kind.label.toLowerCase()}`.trim() : "View details"}
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </span>
          </span>
        </span>
      </Link>
      {onMarkRead && !row.is_read && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMarkRead(row); }}
          title="Mark as read"
          aria-label={`Mark "${row.title}" as read`}
          className={`absolute grid place-items-center rounded-lg border border-line bg-content1 text-muted opacity-0 shadow-sm transition-opacity hover:text-ok focus:opacity-100 group-hover:opacity-100 ${
            full ? "-right-2 -top-2 h-8 w-8" : "right-2 top-2 h-7 w-7"}`}
        >
          <Check className="h-4 w-4" />
        </button>
      )}
    </div>
  );
});
NotificationItem.displayName = "NotificationItem";
