import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import { Plus, Users } from "lucide-react";
import {
  Button, Can, Field, Input, PageHeader, ResponsiveList, Select, type Column,
} from "@/shared/components";
import { mastersApi } from "@/modules/masters/api";
import { adminApi } from "../api";
import type { GroupType, UserGroup } from "../types";

const GROUP_TYPES = [
  { value: "ROLE", label: "By role" },
  { value: "POSITION", label: "By position" },
  { value: "LOCATION", label: "By place (sub-group)" },
];

const emptyGroup: Partial<UserGroup> = {
  code: "", name: "", description: "", group_type: "ROLE",
  role_id: null, position_id: null, location_id: null, parent_id: null,
  is_active: true,
};

export function GroupsPage() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<UserGroup> | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [viewing, setViewing] = useState<UserGroup | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = useQuery({
    queryKey: ["admin", "groups"],
    queryFn: () => adminApi.groups.list({ size: 100 }),
  });
  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: adminApi.roles });
  const warehouses = useQuery({
    queryKey: ["masters", "warehouses-all"],
    queryFn: () => mastersApi.warehouses.list({ size: 200 }).then((p) => p.items),
  });
  // Members are resolved server-side from the group's rule, so this is always current.
  const members = useQuery({
    queryKey: ["admin", "groups", viewing?.id, "members"],
    queryFn: () => adminApi.groups.members(viewing!.id),
    enabled: viewing !== null,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "groups"] });

  const save = useMutation({
    mutationFn: () => (editingId == null
      ? adminApi.groups.create(draft!)
      : adminApi.groups.update(editingId, draft!)),
    onSuccess: () => { setDraft(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const deactivate = useMutation({
    mutationFn: (id: number) => adminApi.groups.deactivate(id),
    onSuccess: () => { setDraft(null); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const patch = (p: Partial<UserGroup>) => setDraft((d) => ({ ...d!, ...p }));

  const openNew = () => { setEditingId(null); setDraft(emptyGroup); setError(null); };
  const openEdit = (g: UserGroup) => { setEditingId(g.id); setDraft(g); setError(null); };

  const parentOptions = (groups.data?.items ?? [])
    .filter((g) => g.id !== editingId && g.group_type !== "LOCATION")
    .map((g) => ({ value: g.id, label: `${g.code} — ${g.name}` }));

  const columns: Column<UserGroup>[] = [
    { key: "code", header: "Code",
      render: (r) => <span className="mono font-semibold text-ink">{r.code}</span> },
    { key: "name", header: "Name", render: (r) => r.name },
    { key: "type", header: "Grouped by", render: (r) => r.group_type, hideOnNarrow: true },
    { key: "members", header: "", render: (r) => (
      <Button variant="ghost" onClick={(e) => { e.stopPropagation(); setViewing(r); }}>
        <Users className="h-4 w-4" /> Members
      </Button>
    ) },
  ];

  return (
    <>
      <PageHeader eyebrow="Admin" title="User groups" />

      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Membership is worked out when you ask, from role, position or place — so an
          HRMS sync never leaves a stale list. A sub-group narrows its parent.
        </p>
        <Can do="admin.groups.manage">
          <Button onClick={openNew}><Plus className="h-4 w-4" /> New group</Button>
        </Can>
      </div>

      <ResponsiveList
        data={groups.data?.items ?? []}
        loading={groups.isLoading}
        keyOf={(r) => r.id}
        columns={columns}
        onRowClick={openEdit}
        empty="No groups yet."
        renderCard={(r) => (
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="mono font-semibold text-ink">{r.code}</span>
              <span className="text-xs text-muted">{r.group_type}</span>
            </div>
            <div className="text-sm text-body">{r.name}</div>
          </div>
        )}
      />

      <Modal isOpen={draft !== null} onOpenChange={() => setDraft(null)} placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>{editingId == null ? "New group" : "Edit group"}</ModalHeader>
              <ModalBody className="gap-3">
                {error && (
                  <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm font-medium text-bad">
                    {error}
                  </div>
                )}
                <Field label="Code"><Input value={draft?.code ?? ""}
                  onChange={(e) => patch({ code: e.target.value })} /></Field>
                <Field label="Name"><Input value={draft?.name ?? ""}
                  onChange={(e) => patch({ name: e.target.value })} /></Field>
                <Field label="Grouped by">
                  <Select value={draft?.group_type ?? "ROLE"} options={GROUP_TYPES}
                          onChange={(v) => patch({
                            group_type: v as GroupType,
                            role_id: null, position_id: null, location_id: null,
                          })} />
                </Field>

                {draft?.group_type === "ROLE" && (
                  <Field label="Role">
                    <Select value={draft.role_id ?? ""}
                            options={(roles.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
                            onChange={(v) => patch({ role_id: v === "" ? null : Number(v) })} />
                  </Field>
                )}
                {draft?.group_type === "POSITION" && (
                  <Field label="Position id (from HRMS)">
                    <Input type="number" value={String(draft.position_id ?? "")}
                           onChange={(e) => patch({
                             position_id: e.target.value ? Number(e.target.value) : null,
                           })} />
                  </Field>
                )}
                {draft?.group_type === "LOCATION" && (
                  <Field label="Warehouse">
                    <Select value={draft.location_id ?? ""}
                            options={(warehouses.data ?? []).map((w) => ({
                              value: w.id, label: `${w.code} — ${w.name}`,
                            }))}
                            onChange={(v) => patch({ location_id: v === "" ? null : Number(v) })} />
                  </Field>
                )}

                <Field label={draft?.group_type === "LOCATION"
                  ? "Parent group (required — this sub-group narrows it)"
                  : "Parent group (optional)"}>
                  <Select value={draft?.parent_id ?? ""} options={parentOptions}
                          onChange={(v) => patch({ parent_id: v === "" ? null : Number(v) })} />
                </Field>

                <div className="flex items-center justify-between py-1">
                  <span className="text-sm font-medium text-body">Active</span>
                  <Switch size="sm" color="primary" isSelected={draft?.is_active ?? true}
                          onValueChange={(v) => patch({ is_active: v })} />
                </div>
              </ModalBody>
              <ModalFooter className="justify-between">
                <div>
                  {editingId != null && (
                    <Can do="admin.groups.manage">
                      <Button variant="ghost" className="text-bad hover:bg-bad-bg"
                              onClick={() => deactivate.mutate(editingId)}>
                        Deactivate
                      </Button>
                    </Can>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  <Button onClick={() => { setError(null); save.mutate(); }}
                          disabled={save.isPending}>
                    {save.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      <Modal isOpen={viewing !== null} onOpenChange={() => setViewing(null)}
             placement="center" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex-col items-start gap-0.5">
                <span>{viewing?.name}</span>
                <span className="text-xs font-normal text-muted">
                  {members.data?.length ?? 0} member(s), resolved just now
                </span>
              </ModalHeader>
              <ModalBody>
                {members.isLoading && <p className="text-sm text-muted">Resolving…</p>}
                {members.data?.length === 0 && (
                  <p className="text-sm text-muted">
                    Nobody matches this group's rule yet.
                  </p>
                )}
                <ul className="divide-y divide-line">
                  {(members.data ?? []).map((m) => (
                    <li key={m.id} className="py-2">
                      <div className="text-sm text-body">{m.full_name}</div>
                      <div className="text-xs text-muted">
                        {m.emp_code ?? "—"} · {m.department_name ?? "—"}
                      </div>
                    </li>
                  ))}
                </ul>
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Close</Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
