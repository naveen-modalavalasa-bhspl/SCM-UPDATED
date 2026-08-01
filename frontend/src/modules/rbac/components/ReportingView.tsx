import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { rbacApi } from "../api";
import type { ReportingNode } from "../types";

/**
 * Reporting, kept simple: pick a person, see who they report to (one line up) and
 * their team below as an indented list that goes down the levels — RM → DM → OE →
 * SK/LT. Click anyone in the team to jump to them.
 */
export function ReportingView() {
  const [search, setSearch] = useState("");
  const [personId, setPersonId] = useState<number | null>(null);

  const candidates = useQuery({
    queryKey: ["rbac", "reporting", "search", search],
    queryFn: () => rbacApi.users.list({ search, size: 8 }),
    enabled: search.trim().length >= 2,
  });
  const reporting = useQuery({
    queryKey: ["rbac", "reporting", personId],
    queryFn: () => rbacApi.reporting(personId!),
    enabled: personId !== null,
  });

  const pick = (id: number) => { setPersonId(id); setSearch(""); };

  return (
    <div className="space-y-4">
      {/* Pick a person */}
      <div className="rounded-2xl border border-line bg-content1 p-4">
        <div className="relative sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type a name or employee code…"
            className="h-11 w-full rounded-xl border border-line bg-content1 pl-9 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
        {candidates.data && search.trim().length >= 2 && (
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
            {candidates.data.items.map((u) => (
              <li key={u.employee_id}>
                <button
                  type="button"
                  onClick={() => pick(u.employee_id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-content2"
                >
                  <span className="font-medium text-ink">{u.full_name}</span>
                  <span className="text-xs text-muted">
                    {u.emp_code ?? "—"} · {u.department_name ?? "—"}
                  </span>
                </button>
              </li>
            ))}
            {candidates.data.items.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted">No one matches.</li>
            )}
          </ul>
        )}
      </div>

      {personId === null && (
        <div className="rounded-2xl border border-line bg-content1 p-6 text-sm text-muted">
          Search for a person above to see who they report to and their team.
        </div>
      )}

      {reporting.isLoading && (
        <div className="rounded-2xl border border-line bg-content1 p-6 text-sm text-muted">
          Loading…
        </div>
      )}

      {reporting.data && (
        <div className="rounded-2xl border border-line bg-content1 p-5">
          {/* Reports to */}
          <div className="mb-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Reports to
            </div>
            {reporting.data.managers.length === 0 ? (
              <div className="mt-1 text-sm text-muted">Top of the organisation — no manager above.</div>
            ) : (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm">
                {[...reporting.data.managers].reverse().map((m, i, arr) => {
                  const holder = m.employees[0];
                  return (
                    <span key={m.position_id} className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!holder}
                        onClick={() => holder && pick(holder.id)}
                        className={`rounded-lg border border-line px-2 py-1 text-left ${
                          holder ? "hover:border-brand" : "text-muted"}`}
                        title={m.position_name}
                      >
                        <span className="font-mono text-[11px] text-muted">
                          {holder?.emp_code ?? "—"}
                        </span>{" "}
                        <span className="font-medium text-body">
                          {holder?.full_name ?? "Vacant"}
                        </span>
                        <span className="ml-1 text-xs text-muted">
                          {m.role_name ?? m.position_name}
                        </span>
                      </button>
                      {i < arr.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-muted" />}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* The person */}
          <div className="rounded-xl bg-brand/10 px-3 py-2">
            <span className="font-mono text-xs text-muted">
              {reporting.data.employee.emp_code ?? "—"}
            </span>
            <span className="ml-2 text-sm font-semibold text-ink">
              {reporting.data.employee.full_name}
            </span>
            <span className="ml-2 text-xs text-muted">
              {reporting.data.positions[0]?.role_name
                ? `${reporting.data.positions[0]?.role_name} · ` : ""}
              {reporting.data.positions[0]?.position_name ?? "No position"}
              {reporting.data.employee.office_name
                ? ` · ${reporting.data.employee.office_name}` : ""}
            </span>
          </div>

          {/* Their team */}
          <div className="mt-4">
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
              Team{reporting.data.team.length ? ` (${reporting.data.team.length} direct)` : ""}
            </div>
            {reporting.data.team.length === 0 ? (
              <div className="text-sm text-muted">No one reports to them.</div>
            ) : (
              <TeamList nodes={reporting.data.team} onPick={pick} depth={0} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TeamList({ nodes, onPick, depth }: {
  nodes: ReportingNode[]; onPick: (id: number) => void; depth: number;
}) {
  return (
    <ul className={depth ? "ml-3 border-l border-line pl-3" : "space-y-0.5"}>
      {nodes.map((n) => <TeamRow key={n.position_id} node={n} onPick={onPick} depth={depth} />)}
    </ul>
  );
}

function TeamRow({ node, onPick, depth }: {
  node: ReportingNode; onPick: (id: number) => void; depth: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  const kids = node.children ?? [];
  const holder = node.employees[0];
  return (
    <li className="py-0.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-content2 ${
            kids.length ? "" : "invisible"
          }`}
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        {node.role_name && (
          <span className="rounded bg-content2 px-1.5 py-0.5 text-[10px] font-bold text-muted">
            {node.role_name}
          </span>
        )}
        {holder ? (
          <button
            type="button"
            onClick={() => onPick(holder.id)}
            className="text-sm hover:text-brand"
          >
            <span className="font-mono text-[11px] text-muted">{holder.emp_code ?? "—"}</span>{" "}
            <span className="font-medium text-ink">{holder.full_name}</span>
            {node.employees.length > 1 && (
              <span className="ml-1 text-xs font-normal text-muted">
                +{node.employees.length - 1}
              </span>
            )}
          </button>
        ) : (
          <span className="text-sm text-muted">Vacant</span>
        )}
        <span className="text-xs text-muted">
          · {node.position_name}
          {holder?.office_name ? ` · ${holder.office_name}` : ""}
        </span>
      </div>
      {open && kids.length > 0 && <TeamList nodes={kids} onPick={onPick} depth={depth + 1} />}
    </li>
  );
}
