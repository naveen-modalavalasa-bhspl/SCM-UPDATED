import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Check, Copy, KeyRound, Search, ShieldOff, UserPlus } from "lucide-react";
import {
  Button, Can, PageHeader, ResponsiveList, StatCard, type Column,
} from "@/shared/components";
import { adminApi } from "../api";
import type { AdminUserRow, GrantResult } from "../types";

/**
 * There is no users table: identity is the HCM employee mirror. "Creating a user"
 * therefore means granting an existing employee access, which is why this screen is
 * a searchable employee list with an access toggle rather than a create form.
 */
export function UsersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "with" | "without">("all");
  const [selected, setSelected] = useState<AdminUserRow | null>(null);
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [issued, setIssued] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ["admin", "users", "summary"], queryFn: adminApi.users.summary,
  });
  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: adminApi.roles });
  const users = useQuery({
    queryKey: ["admin", "users", search, filter],
    queryFn: () => adminApi.users.list({
      search: search || undefined,
      with_access: filter === "all" ? undefined : filter === "with",
      size: 50,
    }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
  };

  const grant = useMutation({
    mutationFn: () => adminApi.users.grant({
      employee_id: selected!.employee_id, role_ids: roleIds,
    }),
    onSuccess: (r) => { setIssued(r); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const saveRoles = useMutation({
    mutationFn: () => adminApi.users.setRoles(selected!.employee_id, roleIds),
    onSuccess: () => { setSelected(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => adminApi.users.revoke(id),
    onSuccess: () => { setSelected(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const reset = useMutation({
    mutationFn: (id: number) => adminApi.users.resetPassword(id),
    onSuccess: (r) => { setIssued(r); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const open = (row: AdminUserRow) => {
    setSelected(row);
    setRoleIds(row.roles.map((r) => r.id));
    setIssued(null);
    setError(null);
  };

  const AccessPill = ({ on, locked }: { on: boolean; locked: boolean }) => (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
      locked ? "bg-bad-bg text-bad" : on ? "bg-ok-bg text-ok" : "bg-default text-muted"
    }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${locked ? "bg-bad" : on ? "bg-ok" : "bg-muted"}`} />
      {locked ? "Locked" : on ? "Has access" : "No access"}
    </span>
  );

  const columns: Column<AdminUserRow>[] = [
    { key: "code", header: "Code",
      render: (r) => <span className="mono font-semibold text-ink">{r.emp_code ?? "—"}</span> },
    { key: "name", header: "Name", render: (r) => r.full_name },
    { key: "dept", header: "Department", hideOnNarrow: true,
      render: (r) => r.department_name ?? "—" },
    { key: "position", header: "Position", hideOnNarrow: true,
      render: (r) => r.positions[0]?.name ?? "—" },
    { key: "roles", header: "Roles", hideOnNarrow: true,
      render: (r) => r.roles.length ? r.roles.map((x) => x.code).join(", ") : "—" },
    { key: "access", header: "Access",
      render: (r) => <AccessPill on={r.has_access} locked={r.locked} /> },
  ];

  return (
    <>
      <PageHeader eyebrow="Admin" title="Users & access" />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Active employees" value={summary.data?.active_employees ?? "—"} />
        <StatCard label="Can sign in" value={summary.data?.users_with_access ?? "—"} />
        <StatCard label="Roles" value={summary.data?.active_roles ?? "—"} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, code or email…"
            className="h-11 w-full rounded-xl border border-line bg-content1 pl-9 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
        <div className="flex gap-1 rounded-xl bg-content2 p-1">
          {([["all", "All"], ["with", "With access"], ["without", "Without"]] as const)
            .map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`h-9 rounded-lg px-3 text-sm font-medium transition ${
                  filter === key ? "bg-content1 text-ink shadow-sm" : "text-muted hover:text-body"
                }`}
              >
                {label}
              </button>
            ))}
        </div>
      </div>

      <ResponsiveList
        data={users.data?.items ?? []}
        loading={users.isLoading}
        keyOf={(r) => r.employee_id}
        columns={columns}
        onRowClick={open}
        empty="No employees match that search."
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="mono font-semibold text-ink">{r.emp_code ?? "—"}</span>
              <AccessPill on={r.has_access} locked={r.locked} />
            </div>
            <div className="text-sm text-body">{r.full_name}</div>
            <div className="text-xs text-muted">{r.department_name ?? "—"}</div>
          </div>
        )}
      />

      <Modal isOpen={selected !== null} onOpenChange={() => setSelected(null)}
             placement="center" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex-col items-start gap-0.5">
                <span>{selected?.full_name}</span>
                <span className="text-xs font-normal text-muted">
                  {selected?.emp_code} · {selected?.department_name ?? "No department"}
                </span>
              </ModalHeader>
              <ModalBody className="gap-4">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
                    {error}
                  </div>
                )}

                {issued?.temporary_password && (
                  <div className="rounded-lg bg-ok-bg px-3 py-2.5">
                    <div className="flex items-center gap-2 text-sm font-semibold text-ok">
                      <Check className="h-4 w-4" /> Access granted
                    </div>
                    {/* Shown once. The server stores only a hash, so it cannot be
                        retrieved again — copy it now or reset the password later. */}
                    <div className="mt-1.5 text-xs text-body">
                      Temporary password, shown once:
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="mono flex-1 rounded bg-content1 px-2 py-1.5 text-sm font-semibold text-ink">
                        {issued.temporary_password}
                      </code>
                      <Button variant="ghost"
                              onClick={() => navigator.clipboard?.writeText(
                                issued.temporary_password!)}>
                        <Copy className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                <div>
                  <div className="mb-2 text-sm font-semibold text-ink">Roles</div>
                  <div className="space-y-1.5">
                    {(roles.data ?? []).map((role) => (
                      <div key={role.id}
                           className="flex items-center justify-between rounded-lg px-1 py-1">
                        <span className="text-sm text-body">{role.name}</span>
                        <Switch
                          size="sm" color="primary"
                          isSelected={roleIds.includes(role.id)}
                          onValueChange={(on) => setRoleIds((ids) =>
                            on ? [...ids, role.id] : ids.filter((i) => i !== role.id))}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {selected?.positions.length ? (
                  <div>
                    <div className="mb-1 text-sm font-semibold text-ink">
                      Positions (from HRMS)
                    </div>
                    <div className="text-xs text-muted">
                      {selected.positions.map((p) => p.name).join(", ")}
                    </div>
                  </div>
                ) : null}
              </ModalBody>

              <ModalFooter className="flex-wrap justify-between gap-2">
                <div className="flex gap-2">
                  {selected?.has_access && (
                    <Can do="admin.users.manage">
                      <Button variant="ghost" className="text-bad hover:bg-bad-bg"
                              onClick={() => revoke.mutate(selected.employee_id)}
                              disabled={revoke.isPending}>
                        <ShieldOff className="h-4 w-4" /> Revoke
                      </Button>
                      <Button variant="ghost"
                              onClick={() => reset.mutate(selected.employee_id)}
                              disabled={reset.isPending}>
                        <KeyRound className="h-4 w-4" /> Reset password
                      </Button>
                    </Can>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}>Close</Button>
                  <Can do="admin.users.manage">
                    {selected?.has_access ? (
                      <Button onClick={() => saveRoles.mutate()} disabled={saveRoles.isPending}>
                        {saveRoles.isPending ? "Saving…" : "Save roles"}
                      </Button>
                    ) : (
                      <Button onClick={() => grant.mutate()} disabled={grant.isPending}>
                        <UserPlus className="h-4 w-4" />
                        {grant.isPending ? "Granting…" : "Grant access"}
                      </Button>
                    )}
                  </Can>
                </div>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
