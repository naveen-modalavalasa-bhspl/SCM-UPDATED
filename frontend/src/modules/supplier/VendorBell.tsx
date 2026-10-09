import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { supplierApi } from "@/modules/procurement/api";
import type { VendorNotification } from "@/modules/procurement/types";

/**
 * What the company needed to tell this vendor.
 *
 * NEW 2026-08-21. Amending a purchase order reached the vendor through no channel at
 * all: the order dropped back to DRAFT, left their portal until somebody re-sent it,
 * and came back later carrying different numbers with no statement that it had changed
 * or why. `platform/notifications` could not be used — it is keyed on `employee_id` and
 * a vendor is not an employee — so `pro_vendor_notifications` and this bell exist.
 *
 * Mounted in BOTH shells, supplier and carrier. One component, because a carrier IS a
 * vendor and the messages come off the same table; `deep_link` is always a portal path,
 * so following one can never drop a vendor onto an internal screen.
 *
 * No polling. A vendor portal is opened to do a thing, not left running on a wall, and
 * a refetch on mount is what a page load already gives.
 */
export function VendorBell() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ["vendor-notifications"],
    queryFn: () => supplierApi.notifications({ size: 20 }),
  });

  const read = useMutation({
    mutationFn: (id: number) => supplierApi.readNotification(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-notifications"] }),
  });

  const rows = data?.items ?? [];
  const unread = rows.filter((r) => !r.is_read).length;

  const follow = (row: VendorNotification) => {
    if (!row.is_read) read.mutate(row.id);
    setOpen(false);
    if (row.deep_link) nav(row.deep_link);
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        onClick={() => setOpen((v) => !v)}
        className="relative flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-body"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away. A plain overlay rather than a focus trap: the panel is a list
              of links, and trapping focus in it makes the header unusable on a phone. */}
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-20 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line bg-content1 shadow-lg">
            <p className="border-b border-line px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
              Notifications
            </p>
            {rows.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">Nothing yet.</p>
            ) : (
              <ul className="max-h-80 divide-y divide-line overflow-y-auto">
                {rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => follow(row)}
                      className={`block w-full px-4 py-3 text-left hover:bg-surface-2 ${
                        row.is_read ? "" : "bg-brand/5"
                      }`}
                    >
                      <span className="block text-sm font-semibold text-ink">
                        {row.title}
                      </span>
                      {row.body && (
                        <span className="mt-0.5 block text-xs text-muted">
                          {row.body}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
