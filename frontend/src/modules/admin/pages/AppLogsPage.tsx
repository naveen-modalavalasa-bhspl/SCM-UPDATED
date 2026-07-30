import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader,
} from "@heroui/react";
import {
  Button, Input, PageHeader, ResponsiveList, Select, type Column,
} from "@/shared/components";
import { adminApi } from "../api";
import type { AppLog } from "../types";

const SOURCES = [
  { value: "", label: "Frontend & backend" },
  { value: "FRONTEND", label: "Frontend" },
  { value: "BACKEND", label: "Backend" },
];
const LEVELS = [
  { value: "", label: "All severity" },
  { value: "ERROR", label: "Errors" },
  { value: "WARNING", label: "Warnings" },
];
const STATUSES = [
  { value: "", label: "All status codes" },
  { value: "400", label: "400" },
  { value: "401", label: "401" },
  { value: "403", label: "403" },
  { value: "404", label: "404" },
  { value: "409", label: "409" },
  { value: "422", label: "422" },
  { value: "500", label: "500" },
  { value: "503", label: "503" },
];

function when(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function location(row: AppLog) {
  if (!row.source_file) return "—";
  const line = row.line_number ? `:${row.line_number}` : "";
  const column = row.column_number ? `:${row.column_number}` : "";
  return `${row.source_file}${line}${column}`;
}

function Status({ row }: { row: AppLog }) {
  const severe = row.level === "ERROR";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
      severe ? "bg-bad-bg text-bad" : "bg-warn-bg text-warn"
    }`}>
      {row.status_code ?? row.level}
    </span>
  );
}

function Detail({ label, value, mono = false }: {
  label: string;
  value: unknown;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className={`mt-1 break-all text-sm text-ink ${mono ? "font-mono" : ""}`}>
        {value == null || value === "" ? "—" : String(value)}
      </div>
    </div>
  );
}

export function AppLogsPage() {
  const [source, setSource] = useState("");
  const [level, setLevel] = useState("");
  const [status, setStatus] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AppLog | null>(null);

  const logs = useQuery({
    queryKey: ["admin", "app-logs", source, level, status, search, page],
    queryFn: () => adminApi.appLogs.list({
      source: source || undefined,
      level: level || undefined,
      status_code: status ? Number(status) : undefined,
      search: search || undefined,
      page,
      size: 25,
    }),
    refetchInterval: 30_000,
  });
  const rows = logs.data?.items ?? [];

  const columns: Column<AppLog>[] = [
    { key: "at", header: "When", render: (row) => (
      <span className="whitespace-nowrap text-xs text-body">{when(row.created_at)}</span>
    ) },
    { key: "source", header: "Source", render: (row) => (
      <span className="rounded-full bg-brand-050 px-2 py-0.5 text-[11px] font-semibold text-brand">
        {row.source}
      </span>
    ) },
    { key: "status", header: "Status", render: (row) => <Status row={row} /> },
    { key: "message", header: "Message", render: (row) => (
      <div className="max-w-md">
        <div className="line-clamp-2 font-medium text-ink">{row.message}</div>
        <div className="mt-0.5 text-xs text-muted">{row.error_type ?? "Error"}</div>
      </div>
    ) },
    { key: "endpoint", header: "Endpoint", hideOnNarrow: true, render: (row) => (
      <span className="font-mono text-xs text-body">
        {[row.http_method, row.endpoint].filter(Boolean).join(" ") || "—"}
      </span>
    ) },
    { key: "location", header: "Code location", hideOnNarrow: true, render: (row) => (
      <div className="max-w-sm font-mono text-xs text-body">
        <div className="break-all">{location(row)}</div>
        {row.function_name && <div className="mt-0.5 text-muted">{row.function_name}()</div>}
      </div>
    ) },
  ];

  const applySearch = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="App Logs"
        actions={<Button variant="ghost" onClick={() => logs.refetch()}>Refresh</Button>}
      />
      <p className="-mt-5 mb-5 text-sm text-muted">
        Frontend and backend failures with searchable code locations and request IDs.
      </p>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Select
          value={source}
          options={SOURCES}
          onChange={(value) => { setSource(String(value)); setPage(1); }}
        />
        <Select
          value={level}
          options={LEVELS}
          onChange={(value) => { setLevel(String(value)); setPage(1); }}
        />
        <Select
          value={status}
          options={STATUSES}
          onChange={(value) => { setStatus(String(value)); setPage(1); }}
        />
        <div className="flex gap-2 sm:col-span-2">
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") applySearch(); }}
            placeholder="Message, endpoint, file, function or request ID"
          />
          <Button variant="secondary" onClick={applySearch}>Search</Button>
        </div>
      </div>

      <div className="mb-3 text-right text-sm text-muted">
        {logs.data?.total ?? 0} entries
      </div>

      <ResponsiveList
        data={rows}
        loading={logs.isLoading}
        keyOf={(row) => row.id}
        columns={columns}
        onRowClick={setSelected}
        empty="No application errors recorded."
        renderCard={(row) => (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-brand">{row.source}</span>
              <Status row={row} />
            </div>
            <div className="line-clamp-2 text-sm font-medium text-ink">{row.message}</div>
            <div className="break-all font-mono text-xs text-muted">{location(row)}</div>
            <div className="text-xs text-muted">{when(row.created_at)}</div>
          </div>
        )}
      />

      {(logs.data?.total ?? 0) > 25 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <Button variant="ghost" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-sm text-muted">Page {page}</span>
          <Button
            variant="ghost"
            disabled={page * 25 >= (logs.data?.total ?? 0)}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <Modal
        isOpen={selected !== null}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        size="5xl"
        scrollBehavior="inside"
      >
        <ModalContent>
          <ModalHeader>Application error details</ModalHeader>
          <ModalBody>
            {selected && (
              <div className="space-y-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Detail label="Recorded" value={when(selected.created_at)} />
                  <Detail label="Source / severity"
                          value={`${selected.source} / ${selected.level}`} />
                  <Detail label="Status code" value={selected.status_code} mono />
                  <Detail label="Request ID" value={selected.request_id} mono />
                  <Detail label="User" value={selected.actor_name ?? selected.actor_id} />
                  <Detail label="Error type" value={selected.error_type} mono />
                  <Detail label="Endpoint"
                          value={[selected.http_method, selected.endpoint].filter(Boolean).join(" ")}
                          mono />
                  <Detail label="Page" value={selected.page_url} mono />
                  <Detail label="Function" value={selected.function_name} mono />
                </div>

                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Message
                  </div>
                  <div className="mt-1 whitespace-pre-wrap rounded-xl bg-content2 p-3 text-sm text-ink">
                    {selected.message}
                  </div>
                </div>

                <Detail label="Code location" value={location(selected)} mono />

                {selected.stack_trace && (
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Stack trace
                    </div>
                    <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-content2 p-3 font-mono text-xs text-body">
                      {selected.stack_trace}
                    </pre>
                  </div>
                )}

                {selected.context_data && (
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                      Safe context
                    </div>
                    <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-xl bg-content2 p-3 font-mono text-xs text-body">
                      {JSON.stringify(selected.context_data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setSelected(null)}>Close</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
