import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { Card, PageHeader } from "@/shared/components";
import { indentApi } from "../api";

function dateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

export function IndentAcknowledgmentsPage() {
  const nav = useNavigate();
  const { data, isLoading } = useQuery({
    queryKey: ["indent-acknowledgments"],
    queryFn: () => indentApi.acknowledgments({ size: 100 }),
  });

  return (
    <>
      <PageHeader eyebrow="Material Requests" title="Acknowledgments" />
      <Card className="divide-y divide-line">
        {isLoading && <p className="p-5 text-sm text-muted">Loading acknowledgments…</p>}
        {data?.items.map((row) => (
          <button
            key={row.id}
            onClick={() => nav(`/indents/${row.indent_id}`)}
            className="flex w-full gap-3 p-4 text-left hover:bg-content2"
          >
            <span className="mt-0.5 rounded-full bg-ok-bg p-2 text-ok">
              <CheckCircle2 className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <strong className="mono text-sm text-ink">{row.indent_no}</strong>
                <span className="text-xs text-muted">{dateTime(row.acted_at)}</span>
              </span>
              <span className="mt-1 block text-sm text-body">
                {row.actor_name ?? "Workflow user"} · {row.action.replace(/_/g, " ").toLowerCase()}
                {row.stage_name ? ` at ${row.stage_name}` : ""}
              </span>
              {row.comments && <span className="mt-1 block text-xs text-muted">{row.comments}</span>}
            </span>
          </button>
        ))}
        {!isLoading && data?.items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted">No acknowledgments recorded yet.</p>
        )}
      </Card>
    </>
  );
}
