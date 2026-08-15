import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Rows3, Timer } from "lucide-react";
import {
  Card, EmptyState, ErrorBanner, ResponsiveList, StatCard, type Column,
} from "@/shared/components";
import { integrationsApi } from "../api";
import type { CallLog } from "../types";

const when = (v?: string | null) => (v ? new Date(v).toLocaleString() : "—");

/** Every call this application made, kept or refused — where "why is it failing?" is
 *  answered. The log lives in the server's memory, not a table, so it starts empty
 *  after a restart; the screen says so rather than implying a permanent record. */
export function UsagePanel({ clientCode }: { clientCode: string }) {
  const [page, setPage] = useState(1);
  const [errorsOnly, setErrorsOnly] = useState(false);

  const usage = useQuery({
    queryKey: ["apis", "usage", clientCode],
    queryFn: () => integrationsApi.usage(clientCode),
  });

  const logs = useQuery({
    queryKey: ["apis", "logs", clientCode, { page, errorsOnly }],
    queryFn: () => integrationsApi.logs(clientCode, { page, size: 20, errors_only: errorsOnly }),
  });

  const totalPages = Math.max(1, Math.ceil((logs.data?.total ?? 0) / (logs.data?.size || 20)));

  const columns: Column<CallLog>[] = [
    {
      key: "at",
      header: "When",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{when(row.at)}</div>
          <div className="text-xs text-muted">{row.ip_address ?? ""}</div>
        </div>
      ),
    },
    {
      key: "slug",
      header: "Endpoint",
      render: (row) => (
        <div className="text-sm">
          <div className="font-mono text-ink">{row.slug ?? "—"}</div>
          <div className="text-xs text-muted">{row.key_prefix ?? ""}</div>
        </div>
      ),
    },
    {
      key: "result",
      header: "Result",
      render: (row) => (
        <div className="text-sm">
          <span className={row.status_code >= 400 ? "text-bad" : "text-ok"}>
            {row.status_code}
          </span>
          <div className="text-xs text-muted">
            {row.row_count ?? 0} rows · {row.duration_ms ?? 0} ms
          </div>
        </div>
      ),
    },
    {
      key: "error",
      header: "Message",
      hideOnNarrow: true,
      render: (row) => <span className="text-xs text-muted">{row.error ?? ""}</span>,
    },
  ];

  return (
    <div>
      {usage.error && <ErrorBanner error="Usage could not be loaded." />}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Calls" value={usage.data?.calls ?? 0}
                  icon={<Activity className="h-4 w-4" />} />
        <StatCard label="Rows served" value={usage.data?.rows ?? 0}
                  icon={<Rows3 className="h-4 w-4" />} />
        <StatCard label="Failures" value={usage.data?.errors ?? 0}
                  tone={(usage.data?.errors ?? 0) > 0 ? "text-bad" : "text-ink"}
                  icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard label="Last call"
                  value={<span className="text-base">{when(usage.data?.last_called_at)}</span>}
                  icon={<Timer className="h-4 w-4" />} />
      </div>

      <Card className="mb-4 p-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-body">
          <input type="checkbox" className="h-4 w-4" checked={errorsOnly}
                 onChange={(e) => {
                   setErrorsOnly(e.target.checked);
                   setPage(1);
                 }} />
          Show refusals and failures only
        </label>
        <p className="mt-1 text-xs text-muted">
          Counted since the server last started. The console keeps no table of its own,
          so this is a rolling window, not an archive.
        </p>
      </Card>

      <ResponsiveList
        data={logs.data?.items ?? []}
        columns={columns}
        keyOf={(row) => `${row.at}-${row.slug}-${row.status_code}`}
        loading={logs.isLoading}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        empty={
          <EmptyState
            title="Nothing has called yet"
            hint="Calls appear here the moment the application uses its key — including the ones that were refused."
          />
        }
        renderCard={(row) => (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-sm text-ink">{row.slug ?? "—"}</span>
              <span className={row.status_code >= 400 ? "text-bad" : "text-ok"}>
                {row.status_code}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted">
              {when(row.at)} · {row.row_count ?? 0} rows · {row.duration_ms ?? 0} ms
            </div>
            {row.error && <div className="mt-1 text-xs text-bad">{row.error}</div>}
          </div>
        )}
      />
    </div>
  );
}
