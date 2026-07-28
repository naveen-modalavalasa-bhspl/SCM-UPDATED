import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Card, StatusPill } from "@/shared/components";
import { indentApi, indentKeys, useIndentAccountCacheIsolation, useIndentAccountScope } from "../api";
import { IndentModuleHeader } from "../components/IndentModuleHeader";
import { formatIndentDateTime } from "../dateTime";

function IndentNotificationsContent() {
  const nav = useNavigate();
  const accountScope = useIndentAccountScope();
  useIndentAccountCacheIsolation(accountScope);
  const { data, isLoading } = useQuery({
    queryKey: indentKeys.notifications(accountScope),
    queryFn: () => indentApi.notifications({ size: 100 }),
  });

  return (
    <>
      <IndentModuleHeader title="Alert & Notification" showCreate={false} showFilters={false} />
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
                {formatIndentDateTime(note.created_at)}
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

export function IndentNotificationsPage() {
  return <IndentNotificationsContent />;
}
