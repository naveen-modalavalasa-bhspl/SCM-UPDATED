import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Check, Copy, KeyRound, Search, ShieldOff, UserPlus } from "lucide-react";
import {
  Button, Can, PageHeader, ResponsiveList, Select, StatCard, type Column,
} from "@/shared/components";
import { rbacApi } from "../api";
import { PermissionMatrix } from "../components/PermissionMatrix";
import { ReportingView } from "../components/ReportingView";
import { AccessLookup } from "../components/AccessLookup";
// Aliased: the component below is also called PageAccessMatrix.
import type { AdminUserRow, GrantResult, PageAccessMatrix as PageAccessData } from "../types";

const PAGE_SIZE = 50;

/**
 * There is no users table: identity is the HCM employee mirror. "Creating a user"
 * therefore means granting an existing employee access, which is why this screen is
 * a searchable employee list with an access toggle rather than a create form.
 */
export function UsersPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<
    "users" | "pages" | "features" | "matrix" | "reporting" | "lookup">("users");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "with" | "without">("all");
  const [roleId, setRoleId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminUserRow | null>(null);
  const [roleIds, setRoleIds] = useState<number[]>([]);
  const [issued, setIssued] = useState<GrantResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: ["rbac", "users", "summary"], queryFn: rbacApi.users.summary,
  });
  const roles = useQuery({ queryKey: ["rbac", "roles"], queryFn: rbacApi.roles });
  const users = useQuery({
    queryKey: ["rbac", "users", search, filter, roleId, page],
    queryFn: () => rbacApi.users.list({
      search: search || undefined,
      with_access: filter === "all" ? undefined : filter === "with",
      role_id: roleId ?? undefined,
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

  const saveRoles = useMutation({
    mutationFn: () => rbacApi.users.setRoles(selected!.employee_id, roleIds),
    onSuccess: () => { setSelected(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const revoke = useMutation({
    mutationFn: (id: number) => rbacApi.users.revoke(id),
    onSuccess: () => { setSelected(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const reset = useMutation({
    mutationFn: (id: number) => rbacApi.users.resetPassword(id),
    onSuccess: (r) => { setIssued(r); refresh(); },
    onError: (e: Error) => setError(e.message),
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
          ["pages", "Page access"],
          ["features", "Feature controls"],
          ["matrix", "Permission matrix"],
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
      ) : view === "pages" ? (
        <PageAccessMatrix />
      ) : view === "matrix" ? (
        <PermissionMatrix />
      ) : view === "reporting" ? (
        <ReportingView />
      ) : view === "lookup" ? (
        <AccessLookup />
      ) : (
        <FeatureAccessMatrix />
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


type AccessPage = PageAccessData["pages"][number];

/** Pages that are granted and revoked together, because they share one permission. */
interface PageGroup {
  permission: string | null;
  pages: AccessPage[];
  alwaysOn: boolean;
}

/**
 * Pages sharing a `required_permission` are one switch, not many.
 *
 * Access is stored only as role -> permission (`rbac_role_permissions`); there is no
 * per-page grant table. Twelve pages hang off `indent.view` alone. A column per page
 * therefore promised something the data cannot do: unticking one of the twelve left
 * the permission in place — because the other eleven still needed it — and the box
 * came straight back on the next refetch. The screen looked frozen.
 *
 * Grouping makes the control match what is actually stored, so every click sticks.
 */
export function groupPagesByPermission(pages: AccessPage[]): PageGroup[] {
  const groups = new Map<string, PageGroup>();
  pages.forEach((page) => {
    // Always-on pages have no permission to share; each stands alone and is read-only.
    const key = page.always_on ? `always:${page.code}` : `perm:${page.required_permission}`;
    const existing = groups.get(key);
    if (existing) existing.pages.push(page);
    else groups.set(key, {
      permission: page.required_permission ?? null,
      pages: [page],
      alwaysOn: page.always_on,
    });
  });
  return [...groups.values()];
}

function PageAccessMatrix() {
  const qc = useQueryClient();
  const matrix = useQuery({
    queryKey: ["rbac", "page-access"],
    queryFn: rbacApi.pageAccess,
  });
  const update = useMutation({
    mutationFn: ({ roleId, pageCodes }: { roleId: number; pageCodes: string[] }) =>
      rbacApi.setPageAccess(roleId, pageCodes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rbac", "page-access"] }),
  });

  if (matrix.isLoading) {
    return <div className="rounded-2xl border border-line bg-content1 p-8 text-sm text-muted">
      Loading page access…
    </div>;
  }
  if (!matrix.data) {
    return <div className="rounded-2xl border border-line bg-content1 p-8 text-sm text-bad">
      Page access could not be loaded.
    </div>;
  }

  const groups = groupPagesByPermission(matrix.data.pages);

  /** Every page in the group moves together — the permission behind them is one row. */
  const toggle = (roleId: number, held: string[], group: PageGroup) => {
    const codes = group.pages.map((page) => page.code);
    const on = codes.every((code) => held.includes(code));
    const next = on
      ? held.filter((code) => !codes.includes(code))
      : [...held, ...codes.filter((code) => !held.includes(code))];
    update.mutate({ roleId, pageCodes: next });
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-content1">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-base font-semibold text-ink">Page access by role</h2>
        <p className="mt-1 text-sm text-muted">
          HCM roles are listed first. My Desk and other public pages are always available.
          Pages that share a permission are granted together and are shown as one column.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-max border-collapse text-sm">
          <thead className="bg-content2">
            <tr>
              <th className="sticky left-0 z-10 min-w-56 bg-content2 px-4 py-3 text-left font-semibold text-ink">
                Role
              </th>
              {groups.map((group) => (
                <th key={group.permission ?? group.pages[0].code}
                    className="max-w-44 px-3 py-3 align-bottom text-center text-xs font-semibold text-body">
                  <div className="uppercase tracking-wide">
                    {group.pages.map((page) => page.name).join(" · ")}
                  </div>
                  {group.permission && (
                    <div className="mt-1 font-mono text-[10px] font-normal normal-case text-muted">
                      {group.permission}
                      {group.pages.length > 1 && ` · ${group.pages.length} pages`}
                    </div>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.data.roles.map((role) => (
              <tr key={role.id} className="border-t border-line">
                <td className="sticky left-0 z-10 bg-content1 px-4 py-3">
                  <div className="font-semibold text-ink">{role.name}</div>
                  <div className="text-[11px] font-medium text-muted">{role.source}</div>
                </td>
                {groups.map((group) => {
                  const checked = group.alwaysOn
                    || group.pages.every((page) => role.page_codes.includes(page.code));
                  return (
                    <td key={group.permission ?? group.pages[0].code} className="px-3 py-3 text-center">
                      <button
                        type="button"
                        disabled={group.alwaysOn || update.isPending}
                        title={
                          group.alwaysOn
                            ? "Always on"
                            : `${role.name}: ${group.permission} — ${group.pages.map((p) => p.name).join(", ")}`
                        }
                        onClick={() => toggle(role.id, role.page_codes, group)}
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition ${
                          checked
                            ? group.alwaysOn
                              ? "border-line bg-content2 text-muted"
                              : "border-brand bg-brand text-white"
                            : "border-line bg-content1 text-transparent hover:border-brand"
                        }`}
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {update.isError && (
        <div className="border-t border-line bg-bad-bg px-5 py-3 text-sm text-bad">
          {(update.error as Error).message}
        </div>
      )}
    </div>
  );
}


function FeatureAccessMatrix() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const matrix = useQuery({
    queryKey: ["rbac", "feature-access"],
    queryFn: rbacApi.featureAccess,
  });
  const update = useMutation({
    mutationFn: ({
      roleId, permissionCodes,
    }: { roleId: number; permissionCodes: string[] }) =>
      rbacApi.setFeatureAccess(roleId, permissionCodes),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rbac", "feature-access"] }),
  });

  if (matrix.isLoading) {
    return <div className="rounded-2xl border border-line bg-content1 p-8 text-sm text-muted">
      Loading feature controls…
    </div>;
  }
  if (!matrix.data) {
    return <div className="rounded-2xl border border-line bg-content1 p-8 text-sm text-bad">
      Feature controls could not be loaded.
    </div>;
  }

  const needle = search.trim().toLowerCase();
  const features = matrix.data.features.filter((feature) =>
    !needle
    || feature.code.toLowerCase().includes(needle)
    || feature.module.toLowerCase().includes(needle)
    || feature.description.toLowerCase().includes(needle));
  const toggle = (roleId: number, held: string[], permissionCode: string) => {
    const next = held.includes(permissionCode)
      ? held.filter((code) => code !== permissionCode)
      : [...held, permissionCode];
    update.mutate({ roleId, permissionCodes: next });
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-content1">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-base font-semibold text-ink">Feature controls by role</h2>
        <p className="mt-1 text-sm text-muted">
          Control actions such as raising, editing, submitting and approving indents.
        </p>
        <div className="relative mt-4 max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search feature, e.g. Create indents"
            className="h-10 w-full rounded-xl border border-line bg-content1 pl-9 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-max border-collapse text-sm">
          <thead className="bg-content2">
            <tr>
              <th className="sticky left-0 z-10 min-w-56 bg-content2 px-4 py-3 text-left font-semibold text-ink">
                Role
              </th>
              {features.map((feature) => (
                <th key={feature.code}
                    title={feature.code}
                    className="max-w-44 px-3 py-3 text-center text-xs font-semibold uppercase tracking-wide text-body">
                  <div>{feature.description}</div>
                  <div className="mt-0.5 text-[10px] font-normal normal-case text-muted">
                    {feature.module}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.data.roles.map((role) => (
              <tr key={role.id} className="border-t border-line">
                <td className="sticky left-0 z-10 bg-content1 px-4 py-3">
                  <div className="font-semibold text-ink">{role.name}</div>
                  <div className="text-[11px] font-medium text-muted">{role.source}</div>
                </td>
                {features.map((feature) => {
                  const checked = role.permission_codes.includes(feature.code);
                  return (
                    <td key={feature.code} className="px-3 py-3 text-center">
                      <button
                        type="button"
                        disabled={update.isPending}
                        title={`${role.name}: ${feature.description}`}
                        onClick={() => toggle(
                          role.id, role.permission_codes, feature.code,
                        )}
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition ${
                          checked
                            ? "border-brand bg-brand text-white"
                            : "border-line bg-content1 text-transparent hover:border-brand"
                        }`}
                      >
                        <Check className="h-4 w-4" />
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!features.length && (
        <div className="border-t border-line px-5 py-6 text-sm text-muted">
          No feature controls match that search.
        </div>
      )}
      {update.isError && (
        <div className="border-t border-line bg-bad-bg px-5 py-3 text-sm text-bad">
          {(update.error as Error).message}
        </div>
      )}
    </div>
  );
}
