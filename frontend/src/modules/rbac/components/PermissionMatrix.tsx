import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader,
} from "@heroui/react";
import { Check, Copy, Plus, Search, Trash2 } from "lucide-react";
import { Button, Can, Field, Input } from "@/shared/components";
import { rbacApi } from "../api";
import type { PermissionDef, RoleWithPermissions } from "../types";

/**
 * The full permission matrix: roles down the side, permissions across the top
 * grouped by module. Edits are local until the one Save button; the confirm step
 * shows the diff per role ("granting 4, revoking 2") because permission changes
 * are the most dangerous edit in the system.
 */
export function PermissionMatrix() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  // roleId -> the draft set of codes; only roles the user touched appear here.
  const [draft, setDraft] = useState<Record<number, Set<string>>>({});
  const [confirming, setConfirming] = useState(false);
  const [roleModal, setRoleModal] = useState<
    { mode: "new" } | { mode: "clone"; source: RoleWithPermissions } | null>(null);
  const [roleCode, setRoleCode] = useState("");
  const [roleName, setRoleName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const permissions = useQuery({
    queryKey: ["rbac", "matrix", "permissions"], queryFn: rbacApi.matrix.permissions,
  });
  const roles = useQuery({
    queryKey: ["rbac", "matrix", "roles"], queryFn: rbacApi.matrix.roles,
  });

  const refresh = () => {
    setDraft({});
    qc.invalidateQueries({ queryKey: ["rbac", "matrix"] });
  };

  const save = useMutation({
    mutationFn: async () => {
      for (const [roleId, codes] of Object.entries(draft)) {
        await rbacApi.matrix.setPermissions(Number(roleId), [...codes]);
      }
    },
    onSuccess: () => { setConfirming(false); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const createOrClone = useMutation({
    mutationFn: () => (roleModal?.mode === "clone"
      ? rbacApi.matrix.cloneRole(roleModal.source.id, { code: roleCode, name: roleName })
      : rbacApi.matrix.createRole({ code: roleCode, name: roleName })),
    onSuccess: () => { setRoleModal(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const deleteRole = useMutation({
    mutationFn: (roleId: number) => rbacApi.matrix.deleteRole(roleId),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });

  const allRoles = (roles.data ?? []).filter((r) => r.is_active);
  const needle = search.trim().toLowerCase();
  const visible = (permissions.data ?? []).filter((p) =>
    !needle
    || p.code.toLowerCase().includes(needle)
    || p.module.toLowerCase().includes(needle)
    || p.description.toLowerCase().includes(needle));

  const byModule = useMemo(() => {
    const groups: { module: string; items: PermissionDef[] }[] = [];
    for (const p of visible) {
      const last = groups[groups.length - 1];
      if (last && last.module === p.module) { last.items.push(p); }
      else { groups.push({ module: p.module, items: [p] }); }
    }
    return groups;
  }, [visible]);

  const heldOf = (r: RoleWithPermissions): Set<string> =>
    draft[r.id] ?? new Set(r.permissions);

  const setHeld = (r: RoleWithPermissions, next: Set<string>) => {
    const original = new Set(r.permissions);
    const same = next.size === original.size && [...next].every((c) => original.has(c));
    setDraft((d) => {
      const copy = { ...d };
      if (same) { delete copy[r.id]; } else { copy[r.id] = next; }
      return copy;
    });
  };

  const toggleCell = (r: RoleWithPermissions, code: string) => {
    const next = new Set(heldOf(r));
    if (next.has(code)) { next.delete(code); } else { next.add(code); }
    setHeld(r, next);
  };

  // Bulk toggles: if every target is on, turn all off; otherwise turn all on.
  const toggleRow = (r: RoleWithPermissions) => {
    const held = heldOf(r);
    const allOn = visible.every((p) => held.has(p.code));
    const next = new Set(held);
    for (const p of visible) { if (allOn) { next.delete(p.code); } else { next.add(p.code); } }
    setHeld(r, next);
  };
  const toggleColumn = (code: string) => {
    const allOn = allRoles.every((r) => heldOf(r).has(code));
    for (const r of allRoles) {
      const next = new Set(heldOf(r));
      if (allOn) { next.delete(code); } else { next.add(code); }
      setHeld(r, next);
    }
  };
  const toggleGroup = (r: RoleWithPermissions, items: PermissionDef[]) => {
    const held = heldOf(r);
    const allOn = items.every((p) => held.has(p.code));
    const next = new Set(held);
    for (const p of items) { if (allOn) { next.delete(p.code); } else { next.add(p.code); } }
    setHeld(r, next);
  };

  const diff = useMemo(() => Object.entries(draft).map(([roleId, codes]) => {
    const role = allRoles.find((r) => r.id === Number(roleId));
    const original = new Set(role?.permissions ?? []);
    const granting = [...codes].filter((c) => !original.has(c));
    const revoking = [...original].filter((c) => !codes.has(c));
    return { role, granting, revoking };
  }).filter((d) => d.role), [draft, allRoles]);

  const changeCount = diff.reduce((n, d) => n + d.granting.length + d.revoking.length, 0);

  const openRoleModal = (m: typeof roleModal) => {
    setRoleModal(m); setError(null);
    if (m?.mode === "clone") {
      setRoleCode(`${m.source.code}_COPY`); setRoleName(`${m.source.name} (copy)`);
    } else { setRoleCode(""); setRoleName(""); }
  };

  if (permissions.isLoading || roles.isLoading) {
    return <div className="rounded-2xl border border-line bg-content1 p-8 text-sm text-muted">
      Loading permission matrix…
    </div>;
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-content1">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-ink">Permission matrix</h2>
          <p className="mt-0.5 text-sm text-muted">
            Click a cell to toggle. Nothing is saved until you press Save.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {changeCount > 0 && (
            <span className="rounded-full bg-warn-bg px-2.5 py-1 text-xs font-semibold text-warn">
              {changeCount} unsaved change(s)
            </span>
          )}
          <Can do="admin.roles.manage">
            <Button variant="ghost" onClick={() => openRoleModal({ mode: "new" })}>
              <Plus className="h-4 w-4" /> New role
            </Button>
            <Button disabled={changeCount === 0}
                    onClick={() => { setError(null); setConfirming(true); }}>
              Save
            </Button>
          </Can>
        </div>
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search permission or module…"
            className="h-10 w-full rounded-xl border border-line bg-content1 pl-9 pr-3 text-sm outline-none focus:border-brand"
          />
        </div>
      </div>

      {error && (
        <div className="border-b border-line bg-bad-bg px-5 py-2.5 text-sm text-bad">{error}</div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-max border-collapse text-sm">
          <thead className="bg-content2">
            <tr>
              <th className="sticky left-0 z-10 min-w-56 bg-content2 px-4 py-2 text-left font-semibold text-ink">
                Role
              </th>
              {byModule.map((g) => (
                <th key={g.module} colSpan={g.items.length}
                    className="border-l border-line px-2 py-2 text-center text-[11px] font-bold uppercase tracking-wider text-body">
                  {g.module}
                </th>
              ))}
            </tr>
            <tr>
              <th className="sticky left-0 z-10 bg-content2 px-4 py-2 text-left text-xs font-medium text-muted">
                click a name to toggle its whole row
              </th>
              {byModule.map((g) => g.items.map((p, i) => (
                <th key={p.code}
                    className={`max-w-36 px-2 py-2 text-center align-bottom ${i === 0 ? "border-l border-line" : ""}`}>
                  <button type="button" onClick={() => toggleColumn(p.code)}
                          title={`${p.code} — toggle for every role`}
                          className="text-[11px] font-semibold text-body hover:text-brand">
                    {p.description}
                  </button>
                </th>
              )))}
            </tr>
          </thead>
          <tbody>
            {allRoles.map((role) => {
              const held = heldOf(role);
              const touched = role.id in draft;
              return (
                <tr key={role.id} className="border-t border-line">
                  <td className={`sticky left-0 z-10 px-4 py-2 ${touched ? "bg-warn-bg" : "bg-content1"}`}>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => toggleRow(role)}
                              title="Toggle every visible permission for this role"
                              className="text-left font-semibold text-ink hover:text-brand">
                        {role.name}
                      </button>
                      <span className="text-[10px] font-medium text-muted">{role.source}</span>
                      <Can do="admin.roles.manage">
                        <button type="button" title="Clone role"
                                onClick={() => openRoleModal({ mode: "clone", source: role })}
                                className="text-muted hover:text-brand">
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        {!role.is_system && (
                          <button type="button" title="Delete role"
                                  onClick={() => deleteRole.mutate(role.id)}
                                  className="text-muted hover:text-bad">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </Can>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {byModule.map((g) => (
                        <button key={g.module} type="button"
                                onClick={() => toggleGroup(role, g.items)}
                                className="rounded bg-content2 px-1.5 py-0.5 text-[10px] font-medium text-muted hover:text-brand">
                          {g.module}: all
                        </button>
                      ))}
                    </div>
                  </td>
                  {byModule.map((g) => g.items.map((p, i) => {
                    const on = held.has(p.code);
                    return (
                      <td key={p.code}
                          className={`px-2 py-2 text-center ${i === 0 ? "border-l border-line" : ""}`}>
                        <button
                          type="button"
                          onClick={() => toggleCell(role, p.code)}
                          title={`${role.name}: ${p.code}`}
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition ${
                            on ? "border-brand bg-brand text-white"
                               : "border-line bg-content1 text-transparent hover:border-brand"
                          }`}
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      </td>
                    );
                  }))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!visible.length && (
        <div className="px-5 py-6 text-sm text-muted">No permissions match that search.</div>
      )}

      {/* Diff confirmation — the "granting 4, revoking 2" step. */}
      <Modal isOpen={confirming} onOpenChange={() => setConfirming(false)} placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Confirm permission changes</ModalHeader>
              <ModalBody className="gap-3">
                {diff.map((d) => (
                  <div key={d.role!.id} className="rounded-lg border border-line px-3 py-2">
                    <div className="text-sm font-semibold text-ink">{d.role!.name}</div>
                    <div className="text-xs text-body">
                      granting {d.granting.length}, revoking {d.revoking.length}
                    </div>
                    {d.granting.length > 0 && (
                      <div className="mt-1 text-xs text-ok">+ {d.granting.join(", ")}</div>
                    )}
                    {d.revoking.length > 0 && (
                      <div className="mt-1 text-xs text-bad">− {d.revoking.join(", ")}</div>
                    )}
                  </div>
                ))}
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : `Apply ${changeCount} change(s)`}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* New / clone role */}
      <Modal isOpen={roleModal !== null} onOpenChange={() => setRoleModal(null)}
             placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>
                {roleModal?.mode === "clone"
                  ? `Clone "${roleModal.source.name}"` : "New role"}
              </ModalHeader>
              <ModalBody className="gap-3">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>
                )}
                <Field label="Code">
                  <Input value={roleCode} onChange={(e) => setRoleCode(e.target.value)} />
                </Field>
                <Field label="Name">
                  <Input value={roleName} onChange={(e) => setRoleName(e.target.value)} />
                </Field>
                {roleModal?.mode === "clone" && (
                  <p className="text-xs text-muted">
                    The new role starts with the same {roleModal.source.permissions.length}{" "}
                    permission(s).
                  </p>
                )}
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={() => createOrClone.mutate()}
                        disabled={!roleCode.trim() || !roleName.trim() || createOrClone.isPending}>
                  {createOrClone.isPending ? "Saving…" : "Create"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </div>
  );
}
