import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Rows3, Timer } from "lucide-react";
import {
  EmptyState, ErrorBanner, FilterBar, FilterToggle, ResponsiveList, StatCard,
  type Column,
} from "@/shared/components";
import { fmtDateTime, fmtRelative } from "@/shared/datetime";
import { integrationsApi } from "../api";
import type { CallLog } from "../types";

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
  const failures = usage.data?.errors ?? 0;

  const columns: Column<CallLog>[] = [
    {
      key: "at",
      header: "When",
      render: (row) => (
        <div className="text-sm">
          <div className="text-ink">{fmtDateTime(row.at)}</div>
          <div className="text-xs text-muted">{row.ip_address ?? ""}</div>
        </div>
      ),
    },
    {
      key: "slug",
      header: "API",
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
          {/* The number AND the word. A storekeeper reading this screen does not know
              what 403 means, and the whole reason to open Usage is to find out why a
              call is not working. */}
          <span className={row.status_code >= 400 ? "text-bad" : "text-ok"}>
            {row.status_code} {row.status_code >= 400 ? "refused" : "served"}
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
      render: (row) => (
        <span className={`text-xs ${row.error ? "text-bad" : "text-muted"}`}>
          {row.error ?? ""}
        </span>
      ),
    },
  ];

  return (
    <div>
      {usage.error && <ErrorBanner error="Usage could not be loaded." />}

      <div className="mb-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Calls" value={usage.data?.calls ?? 0}
                  icon={<Activity className="h-4 w-4" />} />
        <StatCard label="Rows served" value={usage.data?.rows ?? 0}
                  icon={<Rows3 className="h-4 w-4" />} />
        <StatCard label="Failures" value={failures}
                  tone={failures > 0 ? "text-bad" : "text-ink"}
                  icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard label="Last call"
                  value={<span className="text-base">
                    {usage.data?.last_called_at ? fmtRelative(usage.data.last_called_at) : "Never"}
                  </span>}
                  icon={<Timer className="h-4 w-4" />} />
      </div>

      {/* Directly under the numbers it qualifies. It was three lines further down,
          inside the filter card, where it read as a note about the filter. */}
      <p className="mb-4 text-xs text-muted">
        Counted since the server last started. The console keeps no table of its own,
        so this is a rolling window, not an archive — an empty log after a restart does
        not mean nothing has ever called.
      </p>

      <FilterBar
        right={
          <span className="text-sm text-muted">
            {logs.data?.total ?? 0} {(logs.data?.total ?? 0) === 1 ? "call" : "calls"}
          </span>
        }
      >
        <FilterToggle
          active={errorsOnly}
          onChange={(value) => {
            setErrorsOnly(value);
            setPage(1);
          }}
          icon={<AlertTriangle className="h-4 w-4 opacity-70" />}
        >
          Refusals and failures only
        </FilterToggle>
      </FilterBar>

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
            title={errorsOnly ? "Nothing has been refused" : "Nothing has called yet"}
            hint={errorsOnly
              ? "No call from this application has been turned away since the server started."
              : "Calls appear here the moment the application uses its key — including the ones that were refused, and why."}
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
              {fmtDateTime(row.at)} · {row.row_count ?? 0} rows · {row.duration_ms ?? 0} ms
            </div>
            {row.error && <div className="mt-1 text-xs text-bad">{row.error}</div>}
          </div>
        )}
      />
    </div>
  );
}
