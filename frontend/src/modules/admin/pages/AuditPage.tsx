import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input, PageHeader, ResponsiveList, Select, type Column } from "@/shared/components";
import { adminApi } from "../api";
import type { AuditRow } from "../types";

const ACTIONS = ["CREATE", "UPDATE", "DEACTIVATE", "ACTIVATE", "LOGIN",
                 "ACCESS_GRANTED", "ACCESS_REVOKED"].map((a) => ({ value: a, label: a }));

const ACTION_TONE: Record<string, string> = {
  CREATE: "bg-ok-bg text-ok",
  UPDATE: "bg-brand-050 text-brand",
  DEACTIVATE: "bg-bad-bg text-bad",
  ACCESS_REVOKED: "bg-bad-bg text-bad",
  ACCESS_GRANTED: "bg-ok-bg text-ok",
};

function when(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium", timeStyle: "short",
  });
}

/** The log stores only the fields that changed, so this renders the whole diff. */
function Changes({ row }: { row: AuditRow }) {
  const entries = Object.entries(row.changed_fields ?? {});
  if (!entries.length) return <span className="text-muted">—</span>;
  return (
    <div className="space-y-0.5">
      {entries.map(([field, { from, to }]) => (
        <div key={field} className="text-xs">
          <span className="font-medium text-body">{field}</span>{" "}
          <span className="text-muted line-through">{String(from ?? "—")}</span>{" "}
          <span className="text-muted">→</span>{" "}
          <span className="text-ink">{String(to ?? "—")}</span>
        </div>
      ))}
    </div>
  );
}

export function AuditPage() {
  const [entity, setEntity] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // The box filters on the server — who acted, the document number, or the table.
  // Debounced, and it resets to page 1 so a narrowed log never opens on an empty page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const audit = useQuery({
    queryKey: ["admin", "audit", entity, action, search, page],
    queryFn: () => adminApi.audit({
      entity: entity || undefined, action: action || undefined,
      search: search || undefined, page, size: 50,
    }),
  });

  const rows = audit.data?.items ?? [];
  // The filter offers whatever the current page actually contains, so it never
  // presents a table nobody has touched.
  const entities = Array.from(new Set(rows.map((r) => r.entity)))
    .map((e) => ({ value: e, label: e }));

  const columns: Column<AuditRow>[] = [
    { key: "at", header: "When", render: (r) => when(r.at) },
    { key: "actor", header: "Who", render: (r) => r.actor_name ?? "system" },
    { key: "action", header: "Action", render: (r) => (
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        ACTION_TONE[r.action] ?? "bg-default text-muted"
      }`}>{r.action}</span>
    ) },
    { key: "entity", header: "Record", hideOnNarrow: true, render: (r) => (
      <span className="mono text-xs text-body">{r.entity} #{r.entity_id}</span>
    ) },
    { key: "changes", header: "Changed", hideOnNarrow: true,
      render: (r) => <Changes row={r} /> },
  ];

  return (
    <>
      <PageHeader eyebrow="Admin" title="Audit log" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="w-56">
          <Select value={entity} options={[{ value: "", label: "All records" }, ...entities]}
                  onChange={(v) => { setEntity(String(v)); setPage(1); }} />
        </div>
        <div className="w-52">
          <Select value={action} options={[{ value: "", label: "All actions" }, ...ACTIONS]}
                  onChange={(v) => { setAction(String(v)); setPage(1); }} />
        </div>
        <div className="w-64">
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search who, document or table…"
            aria-label="Search the audit log"
          />
        </div>
        <span className="ml-auto text-sm text-muted">
          {audit.data?.total ?? 0} entries
        </span>
      </div>

      <ResponsiveList
        data={rows}
        loading={audit.isLoading}
        keyOf={(r) => r.id}
        columns={columns}
        empty="Nothing recorded yet."
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                ACTION_TONE[r.action] ?? "bg-default text-muted"
              }`}>{r.action}</span>
              <span className="text-xs text-muted">{when(r.at)}</span>
            </div>
            <div className="mono text-xs text-body">{r.entity} #{r.entity_id}</div>
            <div className="text-xs text-muted">{r.actor_name ?? "system"}</div>
            <Changes row={r} />
          </div>
        )}
      />

      {(audit.data?.total ?? 0) > 50 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
                  className="h-11 rounded-xl px-4 text-sm font-medium text-body disabled:text-muted">
            Previous
          </button>
          <span className="text-sm text-muted">Page {page}</span>
          <button
            disabled={page * 50 >= (audit.data?.total ?? 0)}
            onClick={() => setPage((p) => p + 1)}
            className="h-11 rounded-xl px-4 text-sm font-medium text-body disabled:text-muted">
            Next
          </button>
        </div>
      )}
    </>
  );
}
