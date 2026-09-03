import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Briefcase, MonitorSmartphone, Router, UserCircle, X,
} from "lucide-react";
import { Input, PageHeader, ResponsiveList, Select, type Column, selectOnFocus } from "@/shared/components";
import { adminApi } from "../api";
import type { AuditRow } from "../types";
import { fmtDateTime } from "@/shared/datetime";

const ACTION_META: Record<string, { title: string; chip: string }> = {
  CREATE:         { title: "Created",        chip: "bg-ok-bg text-ok" },
  UPDATE:         { title: "Updated",        chip: "bg-brand-050 text-brand" },
  DEACTIVATE:     { title: "Deactivated",    chip: "bg-bad-bg text-bad" },
  ACTIVATE:       { title: "Activated",      chip: "bg-ok-bg text-ok" },
  LOGIN:          { title: "Logged in",      chip: "bg-info-bg text-info" },
  ACCESS_GRANTED: { title: "Access granted", chip: "bg-warn-bg text-warn" },
  ACCESS_REVOKED: { title: "Access revoked", chip: "bg-bad-bg text-bad" },
};

const ACTION_LIST = Object.keys(ACTION_META);

function moduleLabel(entity: string): string {
  if (!entity) return "—";
  const p = entity.toLowerCase();
  if (p.startsWith("ind_")) return "Indents";
  if (p.startsWith("pro_")) return "Procurement";
  if (p.startsWith("stk_") || p.startsWith("inv_")) return "Inventory";
  if (p.startsWith("lgs_") || p.startsWith("tr_") || p.startsWith("out_")) return "Logistics";
  if (p.startsWith("wh_") || p.startsWith("dispatch")) return "Warehouse";
  if (p.startsWith("hcm_")) return "HCM";
  if (p.startsWith("rbac_")) return "Access & Roles";
  if (p.startsWith("sys_")) return "Settings";
  if (p.startsWith("mst_")) return "Masters";
  return entity.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeField(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ChangedSummary({ row, limit = 3 }: { row: AuditRow; limit?: number }) {
  const entries = Object.entries(row.changed_fields ?? {});
  if (!entries.length) {
    return <span className="text-xs italic text-muted">No changes</span>;
  }
  const visible = entries.slice(0, limit);
  const rest = entries.length - visible.length;
  return (
    <div className="space-y-1 text-xs leading-snug">
      {visible.map(([field, { to }]) => (
        <div key={field} className="flex items-baseline gap-1.5">
          <span className="shrink-0 font-medium text-muted">{humanizeField(field)}</span>
          <span className="truncate font-medium text-ink">{String(to ?? "—")}</span>
        </div>
      ))}
      {rest > 0 && (
        <div className="text-[11px] text-muted">+{rest} more field{rest > 1 ? "s" : ""}</div>
      )}
    </div>
  );
}

function ChangedDetail({ row }: { row: AuditRow }) {
  const entries = Object.entries(row.changed_fields ?? {});
  if (!entries.length) {
    return <p className="text-sm text-muted">No field changes were recorded.</p>;
  }
  return (
    <div className="divide-y divide-line/50 overflow-hidden rounded-lg border border-line/60">
      {entries.map(([field, { from, to }]) => (
        <div key={field} className="grid grid-cols-[minmax(0,6fr)_minmax(0,10fr)] items-baseline gap-3 px-3 py-2">
          <span className="text-xs font-medium text-muted">{humanizeField(field)}</span>
          <span className="text-right text-sm">
            {from !== undefined && from !== null && from !== "" && (
              <span className="mr-1.5 text-xs text-muted line-through">{String(from)}</span>
            )}
            <span className="font-semibold text-ink">{String(to ?? "—")}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const m = ACTION_META[action] ?? ACTION_META.UPDATE;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${m.chip}`}>
      {m.title}
    </span>
  );
}

function Changed({ row, onClose }: { row: AuditRow | null; onClose: () => void }) {
  useEffect(() => {
    if (!row) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, onClose]);
  if (!row) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button aria-label="Close details" onClick={onClose}
              className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
      <aside role="dialog" aria-modal="true"
             className="relative flex h-full w-full max-w-[460px] flex-col bg-content1 shadow-2xl">
        <div className="flex items-start gap-3 border-b border-line/70 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-lg font-bold text-ink">
              <ActionBadge action={row.action} />
            </h2>
            <p className="mt-1 truncate font-mono text-xs text-muted">
              {row.entity_no ?? `${row.entity} #${row.entity_id}`}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close"
                  className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-content2 hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <div className="grid gap-y-2">
            <DetailRow label="User" value={row.actor_name ?? "System"} />
            <DetailRow label="When" value={fmtDateTime(row.at)} />
            <DetailRow label="Module" value={moduleLabel(row.entity)} />
            <DetailRow label="Record" value={row.entity_no ?? `${row.entity} #${row.entity_id}`} />
            <DetailRow label="IP address" value={row.ip_address ?? "—"} />
            <DetailRow label="Location" value={row.location ?? "—"} />
            <DetailRow label="Device" value={row.device_type ?? "—"} />
            <DetailRow label="Browser / OS"
                       value={[row.browser, row.os].filter(Boolean).join(" · ") || "—"} />
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Changes</h3>
            <ChangedDetail row={row} />
          </div>
        </div>
      </aside>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line/50 py-2 last:border-0">
      <span className="text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      <span className="text-right text-sm font-medium text-body">{value ?? "—"}</span>
    </div>
  );
}

export function AuditPage() {
  const [location, setLocation] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [user, setUser] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AuditRow | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const audit = useQuery({
    queryKey: ["admin", "audit", search, action, page],
    queryFn: () => adminApi.audit({
      search: search || undefined, action: action || undefined, page, size: 50,
    }),
  });

  const rows = audit.data?.items ?? [];
  const total = audit.data?.total ?? 0;

  // Server-side filter estimates for the dropdowns come from the page actually loaded,
  // so a filter never offers a value the table cannot also show.
  const users = useMemo(
    () => Array.from(new Set(rows.map((r) => r.actor_name).filter(Boolean))) as string[],
    [rows],
  );

  // The locations actually present on this page, so the filter never offers a place
  // nobody has worked from. Rows written before the columns existed carry none and are
  // simply absent from the list rather than shown as a blank option.
  const locations = useMemo(
    () => Array.from(new Set(rows.map((r) => r.location).filter(Boolean))) as string[],
    [rows],
  );

  const filtered = useMemo(() => {
    const from = fromDate ? new Date(`${fromDate}T00:00:00`) : null;
    const to = toDate ? new Date(`${toDate}T23:59:59`) : null;
    return rows.filter((r) => {
      if (user && r.actor_name !== user) return false;
      if (location && r.location !== location) return false;
      if (r.at) {
        const d = new Date(r.at);
        if (from && d < from) return false;
        if (to && d > to) return false;
      }
      return true;
    });
  }, [rows, user, location, fromDate, toDate]);

  const columns: Column<AuditRow>[] = [
    { key: "when", header: "Date & time", render: (r) => (
      <span className="whitespace-nowrap text-xs text-body">{fmtDateTime(r.at)}</span>
    ) },
    { key: "who", header: "Who", render: (r) => (
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-medium text-ink">{r.actor_name ?? "System"}</div>
      </div>
    ) },
    { key: "module", header: "Module", render: (r) => (
      <span className="text-sm text-body">{moduleLabel(r.entity)}</span>
    ) },
    { key: "action", header: "Action", render: (r) => <ActionBadge action={r.action} /> },
    { key: "ip", header: "IP address", hideOnNarrow: true, render: (r) => (
      <span className="mono text-xs text-muted">{r.ip_address ?? "—"}</span>
    ) },
    { key: "location", header: "Location", hideOnNarrow: true, render: (r) => (
      <span className="text-sm text-body">{r.location ?? "—"}</span>
    ) },
    { key: "device", header: "Device", hideOnNarrow: true, render: (r) => (
      <span className="text-xs text-muted">
        {[r.device_type, r.browser, r.os].filter(Boolean).join(" · ") || "—"}
      </span>
    ) },
    { key: "changed", header: "Changed", hideOnNarrow: true, render: (r) => (
      <ChangedSummary row={r} />
    ) },
  ];

  return (
    <>
      <PageHeader eyebrow="Admin" title="Audit trail" />

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input value={searchInput} onFocus={selectOnFocus}
               onChange={(e) => setSearchInput(e.target.value)}
               placeholder="Search user, document or table…"
               aria-label="Search the audit trail" />
        <Select value={action}
                options={[{ value: "", label: "All actions" }, ...ACTION_LIST.map((a) => ({ value: a, label: ACTION_META[a].title }))]}
                onChange={(v) => { setAction(String(v)); setPage(1); }} />
        <Select value={user}
                options={[{ value: "", label: "All users" }, ...users.map((u) => ({ value: u, label: u }))]}
                onChange={(v) => { setUser(String(v)); setPage(1); }} />
        <div className="flex items-center gap-2">
          <Input type="date" aria-label="From date" value={fromDate}
                 onChange={(e) => setFromDate(e.target.value)} className="h-11" />
          <span className="text-muted">–</span>
          <Input type="date" aria-label="To date" value={toDate}
                 onChange={(e) => setToDate(e.target.value)} className="h-11" />
        </div>
      </div>

      {locations.length > 0 && (
        <div className="mb-4 w-72">
          <Select value={location}
                  options={[{ value: "", label: "All locations" },
                            ...locations.map((l) => ({ value: l, label: l }))]}
                  onChange={(v) => { setLocation(String(v)); setPage(1); }} />
        </div>
      )}

      <div className="mb-3 text-sm text-muted">
        Showing <span className="font-medium text-ink">{filtered.length.toLocaleString("en-IN")}</span> of{" "}
        <span className="font-medium text-ink">{total.toLocaleString("en-IN")}</span> events
      </div>

      <ResponsiveList
        data={filtered}
        loading={audit.isLoading}
        keyOf={(r) => r.id}
        columns={columns}
        empty={audit.isLoading ? undefined : "No activity found."}
        onRowClick={setSelected}
        renderCard={(r) => (
          <button type="button" onClick={() => setSelected(r)} className="w-full space-y-1.5 text-left">
            <div className="flex items-center justify-between gap-2">
              <ActionBadge action={r.action} />
              <span className="text-xs text-muted">{fmtDateTime(r.at)}</span>
            </div>
            <div className="flex items-center gap-2 text-sm font-medium text-ink">
              <UserCircle className="h-4 w-4 text-muted" />
              {r.actor_name ?? "System"}
              <span className="text-xs font-normal text-muted">· {moduleLabel(r.entity)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
              <span className="inline-flex items-center gap-1"><Router className="h-3.5 w-3.5" />{r.ip_address ?? "—"}</span>
              <span className="inline-flex items-center gap-1"><Briefcase className="h-3.5 w-3.5" />{r.location ?? "—"}</span>
              <span className="inline-flex items-center gap-1"><MonitorSmartphone className="h-3.5 w-3.5" />{r.device_type ?? "—"}</span>
            </div>
            <ChangedSummary row={r} />
          </button>
        )}
      />

      {total > 50 && (
        <div className="mt-4 flex items-center justify-center gap-3 border-t border-line/50 pt-4">
          <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
                  className="h-9 rounded-lg px-4 text-sm font-medium text-body disabled:text-muted">Previous</button>
          <span className="text-sm text-muted">Page {page}</span>
          <button disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)}
                  className="h-9 rounded-lg px-4 text-sm font-medium text-body disabled:text-muted">Next</button>
        </div>
      )}

      <Changed row={selected} onClose={() => setSelected(null)} />
    </>
  );
}
