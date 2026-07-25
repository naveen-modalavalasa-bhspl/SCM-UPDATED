import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Card, PageHeader, StatusPill } from "@/shared/components";
import { indentApi } from "../api";

export function IndentNotificationsPage() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["indent-notifications"],
    queryFn: () => indentApi.notifications({ size: 100 }),
  });

  return (
    <>
      <PageHeader eyebrow="Material Requests" title="Notifications" />
      <Card className="divide-y divide-line">
        {isLoading && <p className="p-5 text-sm text-muted">Loading notifications…</p>}
        {data?.items.map((note) => (
          <button
            key={note.id}
            onClick={() => nav(`/indents/${note.indent_id}`)}
            className="flex w-full items-start gap-3 p-4 text-left hover:bg-content2"
          >
            <span className="rounded-full bg-info-bg p-2 text-info"><Bell className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm text-ink">{note.title}</strong>
                <StatusPill status={note.status} />
              </span>
              <span className="mt-1 block text-sm text-body">{note.message}</span>
              <span className="mt-1 block text-xs text-muted">
                {new Date(note.created_at).toLocaleString()}
              </span>
            </span>
          </button>
        ))}
        {!isLoading && data?.items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted">No status notifications yet.</p>
        )}
      </Card>
    </>
  );
}
