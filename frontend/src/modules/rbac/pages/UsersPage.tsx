import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Check, Copy, KeyRound, Search, ShieldOff, UserPlus } from "lucide-react";
import {
  Button, Can, ConfirmModal, PageHeader, ResponsiveList, Select, selectOnFocus,
  StatCard, useAction, type Column,
} from "@/shared/components";
import { rbacApi } from "../api";
import { ReportingView } from "../components/ReportingView";
import { AccessLookup } from "../components/AccessLookup";
import type { AdminUserRow, GrantResult } from "../types";

const PAGE_SIZE = 50;
/** Departments and posts move only when HCM syncs — long enough that re-reading them
 *  on every keystroke in the search box is pure waste. */
const HCM_STALE_MS = 5 * 60 * 1000;

/**
 * There is no users table: identity is the HCM employee mirror. "Creating a user"
 * therefore means granting an existing employee access, which is why this screen is
 * a searchable employee list with an access toggle rather than a create form.
 */
export function UsersPage() {
  const qc = useQueryClient();
  // REMOVED 2026-08-23 — "pages", "features" and "matrix". Those three tabs granted
  // against an HCM ROLE, and HCM role 29 "MANAGER" covers fifteen unrelated jobs, so
  // ticking Inventory on that row gave Inventory to all fifteen. Job Profiles replaced
  // them (see `pages/JobProfilesPage`), which is the same grant made against the real
  // job — but the old tabs stayed on screen beside it, so this page offered three
  // routes to a wrong answer next to one route to the right one.
  //
  // The COMPONENTS are still in this file and still exported nowhere else; nothing is
  // deleted and no endpoint or permission changed, so putting a tab back is one line.
  // The Job profiles link goes too: it is a menu row of its own in the rail above, and
  // a tab strip that repeats what the nav already says is the nav saying it twice.
  const [view, setView] = useState<
    "users" | "reporting" | "lookup">("users");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "with" | "without">("all");
  const [roleId, setRoleId] = useState<number | null>(null);
  // Department first, position second: a position dropdown over all 3,729 posts is
  // unreadable, and picking the department cuts it to the dozen that department holds.
  const [department, setDepartment] = useState<string>("");
  const [positionId, setPositionId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminUserRow | null>(null);
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [issued, setIssued] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ["rbac", "users", "summary"], queryFn: rbacApi.users.summary,
  });
  const roles = useQuery({ queryKey: ["rbac", "roles"], queryFn: rbacApi.roles });
  // Re-read when the department changes: the position list is derived from it.
  const filters = useQuery({
    queryKey: ["rbac", "user-filters", department],
    queryFn: () => rbacApi.users.filters(department || undefined),
    staleTime: HCM_STALE_MS,
  });
  const users = useQuery({
    queryKey: ["rbac", "users", search, filter, roleId, department, positionId, page],
    queryFn: () => rbacApi.users.list({
      search: search || undefined,
      with_access: filter === "all" ? undefined : filter === "with",
      role_id: roleId ?? undefined,
      department: department || undefined,
      position_id: positionId ?? undefined,
      page,
      size: PAGE_SIZE,
    }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["rbac", "users"] });
  };

  const grant = useMutation({
    mutationFn: () => rbacApi.users.grant({
      employee_id: selected!.employee_id, role_ids: roleIds,
    }),
    onSuccess: (r) => { setIssued(r); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const saveRoles = useAction({
    run: () => rbacApi.users.setRoles(selected!.employee_id, roleIds),
    success: () => `Roles updated for ${selected?.full_name ?? "this user"}`,
    onDone: () => { setSelected(null); refresh(); },
  });

  /* Revoking locks someone out and resetting invalidates the password they are using
     right now. Both were a single click on a small button inside an open modal. */
  const [confirmAction, setConfirmAction] = useState<"revoke" | "reset" | null>(null);

  const revoke = useAction({
    run: (id: number) => rbacApi.users.revoke(id),
    success: () => `Access revoked for ${selected?.full_name ?? "this user"}`,
    onDone: () => { setConfirmAction(null); setSelected(null); refresh(); },
  });

  const reset = useAction({
    run: (id: number) => rbacApi.users.resetPassword(id),
    success: "Password reset — copy the new one before closing",
    onDone: (r) => { setConfirmAction(null); setIssued(r); refresh(); },
  });

  const open = (row: AdminUserRow) => {
    setSelected(row);
    setRoleIds(row.roles.filter((r) => r.source === "SCM").map((r) => r.id));
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
      render: (r) => r.roles.length ? (
        <div className="flex flex-wrap gap-1">
          {r.roles.map((role) => (
            <span
              key={`${role.source}:${role.id}`}
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                role.source === "HCM" ? "bg-brand/10 text-brand" : "bg-content2 text-muted"
              }`}
            >
              {role.name}<span className="ml-1 opacity-60">{role.source}</span>
            </span>
          ))}
        </div>
      ) : "—" },
    { key: "access", header: "Access",
      render: (r) => <AccessPill on={r.has_access} locked={r.locked} /> },
  ];

  return (
    <>
      <PageHeader eyebrow="RBAC" title="Roles & access" />

      <div className="mb-5 flex gap-6 border-b border-line">
        {([
          ["users", "Users & roles"],
          ["reporting", "Reporting"],
          ["lookup", "Access lookup"],
        ] as const).map(
          ([key, label]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={`border-b-2 px-1 pb-3 text-sm font-semibold ${
                view === key
                  ? "border-brand text-brand"
                  : "border-transparent text-muted hover:text-body"
              }`}
            >
              {label}
            </button>
          ),
        )}
      </div>

      {view === "users" ? (
        <>
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
            onFocus={selectOnFocus}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search name, code or email…"
            className="h-11 w-full rounded-xl border border-line bg-content1 pl-9 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
        <div className="min-w-0 sm:w-56">
          <Select
            value={roleId ?? ""}
            placeholder="All roles"
            options={[
              { value: "", label: "All roles" },
              ...(roles.data ?? []).map((role) => ({
                value: role.id, label: `${role.name} (${role.source})`,
              })),
            ]}
            onChange={(v) => { setRoleId(v === "" ? null : Number(v)); setPage(1); }}
          />
        </div>
        <div className="min-w-0 sm:w-56">
          <Select
            value={department}
            placeholder="All departments"
            ariaLabel="Department"
            options={[
              { value: "", label: "All departments" },
              ...(filters.data?.departments ?? []).map((d) => ({
                value: d.name, label: `${d.name} (${d.count})`,
              })),
            ]}
            onChange={(v) => {
              setDepartment(String(v));
              // The chosen post almost certainly is not in the new department, and a
              // stale one would silently return nobody.
              setPositionId(null);
              setPage(1);
            }}
          />
        </div>
        <div className="min-w-0 sm:w-56">
          <Select
            value={positionId ?? ""}
            placeholder={department ? "All positions" : "All positions (pick a dept)"}
            ariaLabel="Position"
            options={[
              { value: "", label: "All positions" },
              ...(filters.data?.positions ?? []).map((p) => ({
                value: p.id, label: `${p.name} (${p.count})`,
              })),
            ]}
            onChange={(v) => { setPositionId(v === "" ? null : Number(v)); setPage(1); }}
          />
        </div>
        {(roleId !== null || department !== "" || positionId !== null) && (
          <button
            type="button"
            className="h-11 rounded-xl px-3 text-sm font-semibold text-brand"
            onClick={() => {
              setRoleId(null); setDepartment(""); setPositionId(null); setPage(1);
            }}
          >
            Clear filters
          </button>
        )}
        <div className="flex gap-1 rounded-xl bg-content2 p-1">
          {([["all", "All"], ["with", "With access"], ["without", "Without"]] as const)
            .map(([key, label]) => (
              <button
                key={key}
                onClick={() => { setFilter(key); setPage(1); }}
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

      {(users.data?.total ?? 0) > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <button disabled={page === 1} onClick={() => setPage((p) => p - 1)}
                  className="h-11 rounded-xl px-4 text-sm font-medium text-body disabled:text-muted">
            Previous
          </button>
          <span className="text-sm text-muted">
            Page {page} of {Math.ceil((users.data?.total ?? 0) / PAGE_SIZE)}
          </span>
          <button
            disabled={page * PAGE_SIZE >= (users.data?.total ?? 0)}
            onClick={() => setPage((p) => p + 1)}
            className="h-11 rounded-xl px-4 text-sm font-medium text-body disabled:text-muted">
            Next
          </button>
        </div>
      )}
        </>
      ) : view === "reporting" ? (
        <ReportingView />
      ) : (
        <AccessLookup />
      )}

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
                  <div className="mb-2 text-sm font-semibold text-ink">
                    HCM roles (from position)
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {selected?.roles.filter((role) => role.source === "HCM").map((role) => (
                      <span key={`hcm:${role.id}`}
                            className="rounded-full bg-brand/10 px-2.5 py-1 text-xs font-semibold text-brand">
                        {role.name}
                      </span>
                    ))}
                    {!selected?.roles.some((role) => role.source === "HCM") && (
                      <span className="text-xs text-muted">No HCM role on the position.</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    Controlled by HCM and cannot be changed here.
                  </div>
                </div>

                <div>
                  <div className="mb-2 text-sm font-semibold text-ink">
                    Additional SCM access roles
                  </div>
                  <div className="space-y-1.5">
                    {(roles.data ?? []).filter((role) => role.assignable).map((role) => (
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
                              onClick={() => setConfirmAction("revoke")}
                              disabled={revoke.isPending}>
                        <ShieldOff className="h-4 w-4" /> Revoke
                      </Button>
                      <Button variant="ghost"
                              onClick={() => setConfirmAction("reset")}
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

      <ConfirmModal
        isOpen={confirmAction !== null}
        title={
          confirmAction === "revoke"
            ? `Revoke access for ${selected?.full_name}?`
            : `Reset the password for ${selected?.full_name}?`
        }
        message={
          confirmAction === "revoke"
            ? "They are signed out and cannot log in again until access is granted afresh. Their roles are removed."
            : "Their current password stops working immediately. A new one is shown once and cannot be retrieved later."
        }
        confirmLabel={confirmAction === "revoke" ? "Revoke access" : "Reset password"}
        danger={confirmAction === "revoke"}
        busy={revoke.isPending || reset.isPending}
        error={revoke.error ?? reset.error}
        onConfirm={() => {
          if (!selected) return;
          if (confirmAction === "revoke") revoke.mutate(selected.employee_id);
          else reset.mutate(selected.employee_id);
        }}
        onClose={() => setConfirmAction(null)}
      />
    </>
  );
}


/* REMOVED 2026-08-23 — `PageAccessMatrix` and `FeatureAccessMatrix` (and the
 * AccessPage/PageGroup helpers only they used) lived here, behind the Page access
 * and Feature controls tabs. Both granted against an HCM ROLE, and HCM role 29
 * "MANAGER" covers fifteen unrelated jobs — ticking Inventory there gave Inventory
 * to all fifteen. RBAC > Job Profiles makes the same grant against the real job and
 * has its own menu row, so these were three doors to a wrong answer standing beside
 * one door to the right one.
 *
 * The ENDPOINTS they called (/api/rbac/page-access, /api/rbac/feature-access) and
 * their types are untouched — `rbacApi` still carries both, and the types are used
 * by tests. Nothing server-side changed and no permission moved; this is a screen
 * that stopped being offered, not access that stopped being possible.
 */

