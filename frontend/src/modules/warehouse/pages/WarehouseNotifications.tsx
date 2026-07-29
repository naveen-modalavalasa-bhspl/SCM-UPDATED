import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck } from "lucide-react";
import { Button, Card, PageHeader, SubNav } from "@/shared/components";
import { EmptyState, ErrorBanner } from "../components/Feedback";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "../api";
import { fmtDateTime } from "../format";

/**
 * Warehouse notifications.
 *
 * Opening one marks it read and follows its `deep_link` — a notification you have to
 * read and then go and find is a notification people stop opening.
 */

const TABS = [
  { key: "unread", label: "Unread" },
  { key: "all", label: "Everything" },
];

export default function WarehouseNotifications() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState("unread");

  const { data, isLoading, error } = useQuery({
    queryKey: ["wh-notifications", tab],
    queryFn: () => listNotifications(tab === "unread"),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["wh-notifications"] });

  const readOne = useMutation({ mutationFn: (id: number) => markNotificationRead(id), onSuccess: invalidate });
  const readAll = useMutation({ mutationFn: () => markAllNotificationsRead(), onSuccess: invalidate });

  const rows = data?.items ?? [];
  const unread = rows.filter((n) => !n.is_read).length;

  return (
    <div>
      <PageHeader
        eyebrow="Warehouse"
        title="Notifications"
        actions={
          unread > 0 ? (
            <Button variant="subtle" onClick={() => readAll.mutate()} disabled={readAll.isPending}>
              <CheckCheck className="h-4 w-4" /> Mark all read
            </Button>
          ) : undefined
        }
      />

      <SubNav label="Notifications" items={TABS} value={tab} onChange={setTab} />

      <ErrorBanner error={error ?? readOne.error ?? readAll.error} />

      {isLoading ? (
        <div className="py-16 text-center text-muted">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={tab === "unread" ? "Nothing unread" : "No notifications"}
          hint="Receipts, inspections and dispatches raise a notification when they need someone."
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => {
                  if (!n.is_read) readOne.mutate(n.id);
                  if (n.deep_link) nav(n.deep_link);
                }}
                className="block w-full text-left"
              >
                <Card className={`p-4 transition-colors ${n.is_read ? "" : "border-brand/40 bg-brand-050/40"}`}>
                  <div className="flex items-start gap-3">
                    <Bell className={`mt-0.5 h-4 w-4 shrink-0 ${n.is_read ? "text-muted" : "text-brand"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className={`text-sm ${n.is_read ? "font-medium text-body" : "font-semibold text-ink"}`}>
                          {n.title}
                        </span>
                        <span className="text-[11px] text-muted">{fmtDateTime(n.created_at)}</span>
                      </div>
                      {n.body && <p className="mt-0.5 text-xs text-muted">{n.body}</p>}
                    </div>
                    {!n.is_read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />}
                  </div>
                </Card>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
