import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader,
} from "@heroui/react";
import { ChevronDown, ChevronRight, MapPin, Pencil, Plus, Users } from "lucide-react";
import { Button, Can, Field, Input, PageHeader, Select } from "@/shared/components";
import { rbacApi } from "../api";
import { alerts } from "@/modules/alerts";
import type { UserGroup } from "../types";

/**
 * Kept deliberately simple: a group is "everyone with this role", and under it you
 * add region sub-groups — "the same people, in this district". Codes are generated,
 * the type system (ROLE / HCM_ROLE / LOCATION) stays behind the scenes.
 */

const slug = (s: string) =>
  s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

export function GroupsPage() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [roleChoice, setRoleChoice] = useState<string>("");   // "SCM:3" | "HCM:14"
  const [groupName, setGroupName] = useState("");
  const [regionFor, setRegionFor] = useState<UserGroup | null>(null);
  const [regionId, setRegionId] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<UserGroup | null>(null);
  const [renameText, setRenameText] = useState("");
  const [viewing, setViewing] = useState<UserGroup | null>(null);
  const [openParents, setOpenParents] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const groups = useQuery({
    queryKey: ["rbac", "groups"],
    queryFn: () => rbacApi.groups.list({ size: 200 }),
  });
  const roles = useQuery({ queryKey: ["rbac", "roles"], queryFn: rbacApi.roles });
  const hcmRoles = useQuery({ queryKey: ["rbac", "hcm-roles"], queryFn: rbacApi.hcmRoles });
  const regions = useQuery({ queryKey: ["rbac", "regions"], queryFn: rbacApi.groups.regions });
  const members = useQuery({
    queryKey: ["rbac", "groups", viewing?.id, "members"],
    queryFn: () => rbacApi.groups.members(viewing!.id),
    enabled: viewing !== null,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["rbac", "groups"] });
  const fail = (e: Error) => setError(e.message);

  // One dropdown for both kinds of role; the prefix says which system it came from.
  const roleOptions = [
    ...(roles.data ?? []).filter((r) => r.source === "SCM").map((r) => ({
      value: `SCM:${r.id}`, label: r.name,
    })),
    ...(hcmRoles.data ?? []).map((r) => ({
      value: `HCM:${r.id}`, label: `${r.name} (HRMS)`,
    })),
  ];
  const roleLabel = (v: string) =>
    roleOptions.find((o) => o.value === v)?.label.replace(" (HRMS)", "") ?? "";

  const createGroup = useMutation({
    mutationFn: () => {
      const [source, id] = roleChoice.split(":");
      const name = groupName || roleLabel(roleChoice);
      return rbacApi.groups.create({
        code: `GRP_${slug(name)}`, name,
        group_type: source === "HCM" ? "HCM_ROLE" : "ROLE",
        role_id: Number(id),
      });
    },
    onSuccess: (g) => {
      void alerts.success("role.saved", { name: g.name });
      setCreating(false); refresh();
    },
    onError: fail,
  });

  const addRegion = useMutation({
    mutationFn: () => {
      const region = regions.data?.find((r) => r.id === regionId);
      const name = `${region?.name ?? "Region"} — ${regionFor!.name}`;
      return rbacApi.groups.create({
        code: `${regionFor!.code}_${slug(region?.name ?? String(regionId))}`,
        name, group_type: "LOCATION", location_id: regionId!,
        parent_id: regionFor!.id,
      });
    },
    onSuccess: (g) => {
      setRegionFor(null);
      setOpenParents((s) => new Set(s).add(g.parent_id!));
      refresh();
    },
    onError: fail,
  });

  const rename = useMutation({
    mutationFn: () => rbacApi.groups.update(renaming!.id, { ...renaming!, name: renameText }),
    onSuccess: () => {
      void alerts.success("role.saved", { name: renameText });
      setRenaming(null); refresh();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (g: UserGroup) => rbacApi.groups.deactivate(g.id).then(() => g.name),
    onSuccess: (name) => {
      void alerts.success("master.deactivated", { name });
      refresh();
    },
    onError: fail,
  });

  const askThenRemove = async (g: UserGroup) => {
    if (!(await alerts.confirm("master.deactivate", { name: g.name }))) return;
    setRenaming(null);
    remove.mutate(g);
  };

  const items = (groups.data?.items ?? []).filter((g) => g.is_active);
  const parents = items.filter((g) => g.parent_id == null);
  const childrenOf = (id: number) => items.filter((g) => g.parent_id === id);
  const toggle = (id: number) => setOpenParents((s) => {
    const next = new Set(s);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    return next;
  });

  const Row = ({ g, child }: { g: UserGroup; child?: boolean }) => (
    <div className={`flex items-center gap-2 py-3 pr-4 hover:bg-content2 ${
      child ? "border-t border-line/60 pl-14" : "px-4"
    }`}>
      {!child && (
        <button type="button" onClick={() => toggle(g.id)}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-content3 ${
                  childrenOf(g.id).length ? "" : "invisible"
                }`}>
          {openParents.has(g.id)
            ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      )}
      {child && <MapPin className="h-3.5 w-3.5 shrink-0 text-muted" />}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{g.name}</span>
      {!child && childrenOf(g.id).length > 0 && (
        <span className="hidden text-xs text-muted sm:inline">
          {childrenOf(g.id).length} region(s)
        </span>
      )}
      <Button variant="ghost" onClick={() => setViewing(g)}>
        <Users className="h-4 w-4" /> Members
      </Button>
      <Can do="admin.groups.manage">
        {!child && (
          <Button variant="ghost"
                  onClick={() => { setRegionFor(g); setRegionId(null); setError(null); }}>
            <MapPin className="h-4 w-4" /> Add region
          </Button>
        )}
        <Button variant="ghost"
                onClick={() => { setRenaming(g); setRenameText(g.name); setError(null); }}>
          <Pencil className="h-4 w-4" />
        </Button>
      </Can>
    </div>
  );

  return (
    <>
      <PageHeader eyebrow="RBAC" title="User groups" />

      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          A group is everyone with a role. Add regions under it to split them by
          district — members update on their own when HR data changes.
        </p>
        <Can do="admin.groups.manage">
          <Button onClick={() => {
            setCreating(true); setRoleChoice(""); setGroupName(""); setError(null);
          }}>
            <Plus className="h-4 w-4" /> New group
          </Button>
        </Can>
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-content1">
        {groups.isLoading && <div className="p-6 text-sm text-muted">Loading…</div>}
        {!groups.isLoading && parents.length === 0 && (
          <div className="p-6 text-sm text-muted">
            No groups yet. Click "New group", pick a role — that's it.
          </div>
        )}
        <ul className="divide-y divide-line">
          {parents.map((parent) => (
            <li key={parent.id}>
              <Row g={parent} />
              {openParents.has(parent.id) && childrenOf(parent.id).map((c) => (
                <Row key={c.id} g={c} child />
              ))}
            </li>
          ))}
        </ul>
      </div>

      {/* New group: pick a role, optionally rename. Nothing else. */}
      <Modal isOpen={creating} onOpenChange={() => setCreating(false)} placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>New group</ModalHeader>
              <ModalBody className="gap-3">
                {error && <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>}
                <Field label="Who is in this group?">
                  <Select value={roleChoice} options={roleOptions}
                          placeholder="Pick a role, e.g. Lab Technician"
                          onChange={(v) => {
                            const choice = String(v);
                            setRoleChoice(choice);
                            setGroupName(roleLabel(choice));
                          }} />
                </Field>
                <Field label="Group name">
                  <Input value={groupName}
                         onChange={(e) => setGroupName(e.target.value)} />
                </Field>
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={() => { setError(null); createGroup.mutate(); }}
                        disabled={!roleChoice || createGroup.isPending}>
                  {createGroup.isPending ? "Creating…" : "Create group"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Add region: pick a district. Name and code are derived. */}
      <Modal isOpen={regionFor !== null} onOpenChange={() => setRegionFor(null)}
             placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex-col items-start gap-0.5">
                <span>Add a region</span>
                <span className="text-xs font-normal text-muted">
                  under {regionFor?.name}
                </span>
              </ModalHeader>
              <ModalBody className="gap-3">
                {error && <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>}
                <Field label="District / region">
                  <Select value={regionId ?? ""}
                          placeholder="Pick a district"
                          options={(regions.data ?? []).map((r) => ({
                            value: r.id,
                            label: [r.name, [r.city, r.state].filter(Boolean).join(", ")]
                              .filter(Boolean).join(" — "),
                          }))}
                          onChange={(v) => setRegionId(v === "" ? null : Number(v))} />
                </Field>
                <p className="text-xs text-muted">
                  This sub-group will contain the members of "{regionFor?.name}" who
                  belong to that district.
                </p>
              </ModalBody>
              <ModalFooter>
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={() => { setError(null); addRegion.mutate(); }}
                        disabled={regionId == null || addRegion.isPending}>
                  {addRegion.isPending ? "Adding…" : "Add region"}
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Rename / remove */}
      <Modal isOpen={renaming !== null} onOpenChange={() => setRenaming(null)}
             placement="center">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader>Edit group</ModalHeader>
              <ModalBody className="gap-3">
                {error && <div className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>}
                <Field label="Name">
                  <Input value={renameText} onChange={(e) => setRenameText(e.target.value)} />
                </Field>
              </ModalBody>
              <ModalFooter className="justify-between">
                <Button variant="ghost" className="text-bad hover:bg-bad-bg"
                        onClick={() => void askThenRemove(renaming!)}>
                  Remove group
                </Button>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}>Cancel</Button>
                  <Button onClick={() => { setError(null); rename.mutate(); }}
                          disabled={!renameText.trim() || rename.isPending}>
                    {rename.isPending ? "Saving…" : "Save"}
                  </Button>
                </div>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>

      {/* Members */}
      <Modal isOpen={viewing !== null} onOpenChange={() => setViewing(null)}
             placement="center" scrollBehavior="inside">
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex-col items-start gap-0.5">
                <span>{viewing?.name}</span>
                <span className="text-xs font-normal text-muted">
                  {members.data?.length ?? 0} member(s)
                </span>
              </ModalHeader>
              <ModalBody>
                {members.isLoading && <p className="text-sm text-muted">Loading…</p>}
                {members.data?.length === 0 && (
                  <p className="text-sm text-muted">Nobody in this group yet.</p>
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
