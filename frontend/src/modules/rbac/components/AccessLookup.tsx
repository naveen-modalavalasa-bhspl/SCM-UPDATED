import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, ShieldQuestion, UserSearch } from "lucide-react";
import { Field, Select } from "@/shared/components";
import { rbacApi } from "../api";

/**
 * Two questions, one screen:
 *  - "Who can do X?"  — pick a permission, see every role that grants it and the
 *    people holding those roles (e.g. who can approve a PO).
 *  - "What does this person see?" — pick a person, see the roles, permissions and
 *    menu they would get when they sign in.
 */
export function AccessLookup() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <WhoCan />
      <ViewAsUser />
    </div>
  );
}

function WhoCan() {
  const [code, setCode] = useState("");
  const permissions = useQuery({
    queryKey: ["rbac", "matrix", "permissions"], queryFn: rbacApi.matrix.permissions,
  });
  const holders = useQuery({
    queryKey: ["rbac", "holders", code],
    queryFn: () => rbacApi.permissionHolders(code),
    enabled: code !== "",
  });

  return (
    <div className="rounded-2xl border border-line bg-content1 p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldQuestion className="h-4 w-4 text-brand" />
        <h3 className="text-sm font-semibold text-ink">Who can do this?</h3>
      </div>
      <Field label="Permission">
        <Select
          value={code}
          placeholder="e.g. Approve purchase orders"
          options={(permissions.data ?? []).map((p) => ({
            value: p.code, label: `${p.description} (${p.module})`,
          }))}
          onChange={(v) => setCode(String(v))}
        />
      </Field>

      {holders.isLoading && <p className="mt-3 text-sm text-muted">Looking up…</p>}
      {holders.data && (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-body">
            <span className="font-semibold text-ink">{holders.data.total_employees}</span>{" "}
            people can do this, through {holders.data.roles.length} role(s).
          </p>
          {holders.data.roles.map((role) => (
            <div key={role.id} className="rounded-lg border border-line px-3 py-2">
              <div className="text-sm font-semibold text-ink">
                {role.name}
                <span className="ml-2 text-[10px] font-medium text-muted">{role.source}</span>
              </div>
              {role.employees.length === 0 ? (
                <p className="text-xs text-muted">Nobody currently holds this role.</p>
              ) : (
                <ul className="mt-1 space-y-0.5">
                  {role.employees.map((e) => (
                    <li key={e.id} className="text-sm text-body">
                      {e.full_name}
                      <span className="ml-1.5 text-xs text-muted">
                        {e.emp_code ?? "—"} · {e.department_name ?? "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ViewAsUser() {
  const [search, setSearch] = useState("");
  const [employeeId, setEmployeeId] = useState<number | null>(null);

  const candidates = useQuery({
    queryKey: ["rbac", "viewas", "search", search],
    queryFn: () => rbacApi.users.list({ search, size: 8 }),
    enabled: search.trim().length >= 2,
  });
  const viewAs = useQuery({
    queryKey: ["rbac", "viewas", employeeId],
    queryFn: () => rbacApi.viewAs(employeeId!),
    enabled: employeeId !== null,
  });

  return (
    <div className="rounded-2xl border border-line bg-content1 p-4">
      <div className="mb-3 flex items-center gap-2">
        <UserSearch className="h-4 w-4 text-brand" />
        <h3 className="text-sm font-semibold text-ink">View as this user</h3>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a person…"
          className="h-11 w-full rounded-xl border border-line bg-content1 pl-9 pr-3 text-sm outline-none focus:border-brand"
        />
      </div>
      {candidates.data && search.trim().length >= 2 && (
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
          {candidates.data.items.map((u) => (
            <li key={u.employee_id}>
              <button
                type="button"
                onClick={() => { setEmployeeId(u.employee_id); setSearch(""); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-content2"
              >
                <span className="font-medium text-ink">{u.full_name}</span>
                <span className="ml-2 text-xs text-muted">{u.emp_code ?? "—"}</span>
              </button>
            </li>
          ))}
          {candidates.data.items.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted">No one matches.</li>
          )}
        </ul>
      )}

      {viewAs.isLoading && <p className="mt-3 text-sm text-muted">Resolving…</p>}
      {viewAs.data && (
        <div className="mt-3 space-y-3 text-sm">
          <div>
            <span className="font-semibold text-ink">{viewAs.data.employee.full_name}</span>
            {viewAs.data.position && (
              <span className="ml-2 text-xs text-muted">{viewAs.data.position.name}</span>
            )}
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Roles
            </div>
            <div className="flex flex-wrap gap-1">
              {viewAs.data.roles.map((r) => (
                <span key={r.id}
                      className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-semibold text-brand">
                  {r.name}
                </span>
              ))}
              {viewAs.data.roles.length === 0 && (
                <span className="text-xs text-muted">No roles.</span>
              )}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Menu they see
            </div>
            <ul className="space-y-0.5">
              {viewAs.data.menu.map((m) => (
                <li key={m.code} className="text-body">
                  {m.name}
                  {m.children?.length ? (
                    <span className="ml-1.5 text-xs text-muted">
                      ({m.children.map((c) => c.name).join(", ")})
                    </span>
                  ) : null}
                </li>
              ))}
              {viewAs.data.menu.length === 0 && (
                <li className="text-xs text-muted">Nothing — no page access.</li>
              )}
            </ul>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
              Permissions ({viewAs.data.permissions.length})
            </div>
            <div className="flex flex-wrap gap-1">
              {viewAs.data.permissions.map((p) => (
                <code key={p} className="rounded bg-content2 px-1.5 py-0.5 text-[11px] text-body">
                  {p}
                </code>
              ))}
              {viewAs.data.permissions.length === 0 && (
                <span className="text-xs text-muted">None.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
