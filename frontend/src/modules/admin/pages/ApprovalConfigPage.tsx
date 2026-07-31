/* Settings > Approvals Config.
 *
 * One ladder per project per document. A rung is a RANK (hcm_positions.role_id —
 * COO, SPH, REGIONAL MANAGER…), not a person and not a position. Switch a rank off
 * and it stops approving, for everyone in that project. Who
 * actually approves is worked out at submit time by climbing the raiser's own
 * reporting line, so the screen never has to ask "which Regional Manager".
 *
 * Everything here is two dropdowns, a list of toggles, and a sentence telling the
 * admin what the toggles just did. */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import {
  AlertTriangle, ArrowRight, Copy, Plus, RotateCcw, Sparkles, Trash2,
} from "lucide-react";
import { Button, Card, Field, Input, PageHeader, Select } from "@/shared/components";
import { adminApi } from "../api";
import type { LadderRung, Operator, WorkflowCondition } from "../types";
import { OPERATOR_LABEL } from "../ruleLanguage";

const CONDITION_FIELDS = [
  { value: "amount", label: "Document value" },
  { value: "department_id", label: "Department" },
  { value: "item_count", label: "Number of lines" },
];
const CONDITION_OPERATORS: Operator[] = ["GT", "GTE", "LT", "LTE", "EQ", "NEQ"];

const newCondition = (): WorkflowCondition => ({
  field_name: "amount", operator: "GT", field_value: "", logic: "AND",
});

const positionDepartments = (rung: LadderRung) => {
  const groups = new Map<string, {
    id: number | null; name: string; positions: LadderRung["positions"];
  }>();
  for (const position of rung.positions ?? []) {
    const key = String(position.department_id ?? "none");
    const group = groups.get(key) ?? {
      id: position.department_id ?? null,
      name: position.department_name || "No department",
      positions: [],
    };
    group.positions.push(position);
    groups.set(key, group);
  }
  return [...groups.values()];
};

export function ApprovalConfigPage() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [docType, setDocType] = useState("INDENT");
  const [rungs, setRungs] = useState<LadderRung[]>([]);
  const [fromRoleId, setFromRoleId] = useState<number | null>(null);
  const [advanced, setAdvanced] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyTargets, setCopyTargets] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const options = useQuery({
    queryKey: ["admin", "ladders", "options"],
    queryFn: adminApi.ladders.options,
  });

  // Land on the first real project rather than an empty screen.
  useEffect(() => {
    const first = options.data?.projects[0];
    if (projectId === null && first) setProjectId(first.id);
  }, [options.data, projectId]);

  const ladder = useQuery({
    queryKey: ["admin", "ladders", projectId, docType],
    queryFn: () => adminApi.ladders.get(projectId, docType),
    enabled: projectId !== null,
  });

  // The server's rungs are the starting point; from then on the toggles are local
  // until Save, so the preview can follow them live.
  useEffect(() => {
    if (!ladder.data) return;
    setRungs(ladder.data.rungs);
    setAdvanced(null);
    setError(null);
    const bottom = ladder.data.rungs[ladder.data.rungs.length - 1];
    setFromRoleId(bottom ? bottom.position_role_id : null);
  }, [ladder.data]);

  const preview = useQuery({
    queryKey: ["admin", "ladders", "preview", projectId, docType, fromRoleId,
      rungs.map((r) => `${r.position_role_id}:${r.is_enabled}`).join(",")],
    queryFn: () => adminApi.ladders.preview(projectId, docType, rungs, fromRoleId),
    enabled: projectId !== null && fromRoleId !== null && rungs.length > 0,
  });

  const save = useMutation({
    mutationFn: () => adminApi.ladders.save(projectId, docType, rungs),
    onSuccess: () => {
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["admin", "ladders"] });
    },
    onError: (err: Error) => { setConfirming(false); setError(err.message); },
  });

  const copy = useMutation({
    mutationFn: () => adminApi.ladders.copy(projectId, docType, copyTargets),
    onSuccess: () => { setCopying(false); setCopyTargets([]); },
    onError: (err: Error) => { setCopying(false); setError(err.message); },
  });

  const docsByModule = useMemo(() => {
    const groups = new Map<string, { code: string; label: string }[]>();
    for (const doc of options.data?.doc_types ?? []) {
      const list = groups.get(doc.module) ?? [];
      list.push(doc);
      groups.set(doc.module, list);
    }
    return (options.data?.module_order ?? [...groups.keys()])
      .filter((module) => groups.has(module))
      .map((module) => ({ module, docs: groups.get(module)! }));
  }, [options.data]);

  const dirty = useMemo(() => {
    const saved = ladder.data?.rungs ?? [];
    if (saved.length !== rungs.length) return true;
    return rungs.some((rung, index) =>
      rung.is_enabled !== saved[index]?.is_enabled
      || JSON.stringify([...(rung.selected_position_ids ?? [])].sort((a, b) => a - b))
        !== JSON.stringify([...(saved[index]?.selected_position_ids ?? [])].sort((a, b) => a - b))
      || JSON.stringify(rung.conditions) !== JSON.stringify(saved[index]?.conditions));
  }, [rungs, ladder.data]);

  const patchRung = (index: number, values: Partial<LadderRung>) =>
    setRungs((current) => current.map((rung, i) =>
      i === index ? { ...rung, ...values } : rung));

  const togglePositions = (index: number, positionIds: number[], selected: boolean) =>
    setRungs((current) => current.map((rung, i) => {
      if (i !== index) return rung;
      const next = new Set(rung.selected_position_ids ?? []);
      for (const positionId of positionIds) {
        if (selected) next.add(positionId);
        else next.delete(positionId);
      }
      return { ...rung, selected_position_ids: [...next] };
    }));

  const projectName = options.data?.projects.find((p) => p.id === projectId)?.name ?? "";
  const enabledCount = rungs.filter((r) => r.is_enabled || r.conditions.length > 0).length;

  return (
    <div>
      <PageHeader
        eyebrow="Settings"
        title="Approvals Config"
        actions={
          <>
            <Button
              variant="ghost"
              disabled={ladder.data?.is_new || !options.data?.projects.length}
              onClick={() => { setCopyTargets([]); setCopying(true); }}
            >
              <Copy className="h-4 w-4" /> Copy to another project
            </Button>
            <Button disabled={!dirty || save.isPending} onClick={() => setConfirming(true)}>
              Save changes
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>
      )}

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Project"
            hint="Each project has its own ladder, built from the ranks its people hold."
          >
            <Select
              value={projectId ?? ""}
              placeholder="Pick a project"
              options={(options.data?.projects ?? []).map((p) => ({
                value: p.id, label: p.name,
              }))}
              onChange={(value) => setProjectId(value === "" ? null : Number(value))}
            />
          </Field>
          <Field label="Document" hint="Grouped by the module that owns the document.">
            <Select
              value={docType}
              options={docsByModule.flatMap(({ module, docs }) =>
                docs.map((doc) => ({ value: doc.code, label: `${module} · ${doc.label}` })))}
              onChange={(value) => setDocType(String(value))}
            />
          </Field>
        </div>
      </Card>

      {ladder.data?.is_new && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-brand/25 bg-brand-050 px-4 py-3">
          <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
          <div>
            <div className="font-semibold text-ink">New ladder for {projectName}</div>
            <p className="mt-1 text-sm text-body">
              Built from the ranks this project's people hold, everything switched on. Switch off
              what you don't need, then save — that becomes version 1. Until you do,
              approvals here keep using the reporting line.
            </p>
          </div>
        </div>
      )}

      <Card className="mb-5">
        <div className="flex items-center justify-between border-b border-line/70 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Who approves</h2>
            <p className="text-xs text-muted">
              Highest rank first. A request always travels upward from whoever raised it.
            </p>
          </div>
          <span className="text-xs text-muted">
            {enabledCount} of {rungs.length} ranks on
            {ladder.data && !ladder.data.is_new ? ` · v${ladder.data.version}` : ""}
          </span>
        </div>

        {ladder.isLoading && <div className="p-6 text-sm text-muted">Loading…</div>}
        {!ladder.isLoading && rungs.length === 0 && (
          <div className="p-6 text-sm text-muted">
            Nobody in this project holds a position, so there is nothing to configure yet.
            Run an HCM sync first.
          </div>
        )}

        <ul>
          {rungs.map((rung, index) => (
            <li key={rung.position_role_id} className="border-b border-line/50 last:border-0">
              <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Switch
                  size="sm"
                  isSelected={rung.is_enabled}
                  onValueChange={(on) => patchRung(index, { is_enabled: on })}
                  aria-label={`${rung.name} approves`}
                />
                <div className="min-w-[9rem] flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-semibold ${rung.is_enabled ? "text-ink" : "text-muted"}`}>
                      {rung.name}
                    </span>
                    {rung.is_new_rank && (
                      <span className="rounded bg-brand-050 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand">
                        new
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {rung.holders.length === 0
                      ? <span className="inline-flex items-center gap-1 text-bad">
                          <AlertTriangle className="h-3 w-3" />
                          Nobody holds this rank — it will be skipped
                        </span>
                      : `${rung.holders[0].name}${rung.holders.length > 1
                          ? ` +${rung.holders.length - 1}` : ""}`}
                  </div>
                </div>
                <button
                  type="button"
                  className="min-h-11 rounded-lg px-3 text-xs font-semibold text-brand"
                  onClick={() => setAdvanced(advanced === index ? null : index)}
                >
                  {(rung.selected_position_ids ?? []).length} of {rung.positions?.length ?? 0} positions
                  {rung.conditions.length > 0
                    ? ` · ${rung.conditions.length} condition${rung.conditions.length > 1 ? "s" : ""}`
                    : ""}
                </button>
              </div>

              {advanced === index && (
                <div className="border-t border-line/50 bg-content2/40 px-4 py-3">
                  <div className="mb-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink">
                      Eligible approver positions
                    </div>
                    <p className="mb-3 text-xs text-muted">
                      Selecting a department selects every position in it. You can still
                      adjust individual positions afterwards.
                    </p>
                    <div className="space-y-3">
                      {positionDepartments(rung).map((department) => {
                        const departmentIds = department.positions.map((position) => position.id);
                        const selectedIds = new Set(rung.selected_position_ids ?? []);
                        const allSelected = departmentIds.length > 0
                          && departmentIds.every((id) => selectedIds.has(id));
                        return (
                          <div key={department.id ?? department.name} className="rounded-lg border border-line bg-content1 p-3">
                            <label className="flex min-h-8 items-center gap-2 text-sm font-semibold text-ink">
                              <input
                                type="checkbox"
                                checked={allSelected}
                                onChange={(event) => togglePositions(
                                  index, departmentIds, event.target.checked,
                                )}
                              />
                              {department.name}
                              <span className="text-xs font-normal text-muted">
                                ({department.positions.length})
                              </span>
                            </label>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {department.positions.map((position) => (
                                <label key={position.id} className="flex min-h-8 items-start gap-2 text-xs text-body">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.has(position.id)}
                                    onChange={(event) => togglePositions(
                                      index, [position.id], event.target.checked,
                                    )}
                                  />
                                  <span>
                                    <span className="font-medium text-ink">{position.name}</span>
                                    {position.holders.length > 0 && (
                                      <span className="block text-muted">
                                        {position.holders.map((holder) => holder.name).join(", ")}
                                      </span>
                                    )}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="border-t border-line pt-3">
                  <p className="mb-2 text-xs text-muted">
                    With a condition, this rank is governed by the condition instead of the
                    switch — use it for "over ₹5,00,000, always include this rank".
                  </p>
                  {rung.conditions.map((condition, ci) => (
                    <div key={ci} className="mb-2 grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
                      <Select
                        value={condition.field_name}
                        options={CONDITION_FIELDS}
                        ariaLabel="Field"
                        onChange={(value) => patchRung(index, {
                          conditions: rung.conditions.map((c, i) =>
                            i === ci ? { ...c, field_name: String(value) } : c),
                        })}
                      />
                      <Select
                        value={condition.operator}
                        className="min-w-[7rem]"
                        ariaLabel="Operator"
                        options={CONDITION_OPERATORS.map((op) => ({
                          value: op, label: OPERATOR_LABEL[op] ?? op,
                        }))}
                        onChange={(value) => patchRung(index, {
                          conditions: rung.conditions.map((c, i) =>
                            i === ci ? { ...c, operator: value as Operator } : c),
                        })}
                      />
                      <Input
                        value={condition.field_value}
                        placeholder="500000"
                        onChange={(event) => patchRung(index, {
                          conditions: rung.conditions.map((c, i) =>
                            i === ci ? { ...c, field_value: event.target.value } : c),
                        })}
                      />
                      <Button
                        variant="ghost"
                        onClick={() => patchRung(index, {
                          conditions: rung.conditions.filter((_c, i) => i !== ci),
                        })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    onClick={() => patchRung(index, {
                      conditions: [...rung.conditions, newCondition()],
                    })}
                  >
                    <Plus className="h-4 w-4" /> Add condition
                  </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {/* The point of the screen: change a toggle, read what it did. */}
      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="If this rank raises a request">
            <Select
              value={fromRoleId ?? ""}
              className="min-w-[12rem]"
              options={rungs.map((rung) => ({
                value: rung.position_role_id, label: rung.name,
              }))}
              onChange={(value) => setFromRoleId(value === "" ? null : Number(value))}
            />
          </Field>
          {dirty && (
            <Button variant="ghost" onClick={() => setRungs(ladder.data?.rungs ?? [])}>
              <RotateCcw className="h-4 w-4" /> Undo changes
            </Button>
          )}
        </div>

        <div className="rounded-xl border border-brand/25 bg-brand-050 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">
            It goes to
          </div>
          {preview.data?.self_approved ? (
            <p className="mt-1 text-sm text-ink">
              Nobody — this is the top of the ladder, so the request is approved on
              submission and recorded as their own approval.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink">
              {(preview.data?.chain ?? []).map((step, index) => (
                <span key={step.role_name} className="contents">
                  {index > 0 && <ArrowRight className="h-3.5 w-3.5 text-muted" />}
                  <span className="rounded-lg bg-content1 px-2.5 py-1">
                    <span className="font-semibold">{step.role_name}</span>
                    {step.approver_names.length > 0 && (
                      <span className="text-muted"> · {step.approver_names.join(", ")}</span>
                    )}
                  </span>
                </span>
              ))}
              {!preview.data?.chain.length && (
                <span className="text-muted">{preview.data?.note ?? "…"}</span>
              )}
            </div>
          )}
          {(preview.data?.chain.length ?? 0) > 0 && (
            <p className="mt-2 text-xs text-muted">
              {preview.data!.chain.length} approval
              {preview.data!.chain.length > 1 ? "s" : ""} — resolved when the request is
              raised and fixed for that document, whatever you change afterwards.
            </p>
          )}
        </div>
      </Card>

      <Modal isOpen={confirming} onOpenChange={() => setConfirming(false)} placement="center">
        <ModalContent>
          <ModalHeader>Save this ladder?</ModalHeader>
          <ModalBody className="text-sm text-body">
            <p>
              Creates version {(ladder.data?.version ?? 0) + 1} for{" "}
              <strong>{projectName}</strong>.
            </p>
            {(ladder.data?.in_flight ?? 0) > 0 && (
              <p className="rounded-lg bg-warn-bg px-3 py-2 text-warn">
                {ladder.data!.in_flight} document
                {ladder.data!.in_flight > 1 ? "s are" : " is"} already in approval and
                will finish on the current version.
              </p>
            )}
            <p className="text-xs text-muted">
              Ranks switched on:{" "}
              {rungs.filter((r) => r.is_enabled).map((r) => r.name).join(", ") || "none"}
            </p>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <Modal isOpen={copying} onOpenChange={() => setCopying(false)} placement="center">
        <ModalContent>
          <ModalHeader>Copy this ladder</ModalHeader>
          <ModalBody className="text-sm text-body">
            <p className="text-xs text-muted">
              Copied by rank. A rank nobody in the target project holds is left out, and
              each target keeps its own version history.
            </p>
            {(options.data?.projects ?? [])
              .filter((project) => project.id !== projectId)
              .map((project) => (
                <label key={project.id} className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={copyTargets.includes(project.id)}
                    onChange={(event) => setCopyTargets((current) =>
                      event.target.checked
                        ? [...current, project.id]
                        : current.filter((id) => id !== project.id))}
                  />
                  <span>{project.name}</span>
                </label>
              ))}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setCopying(false)}>Cancel</Button>
            <Button
              disabled={copyTargets.length === 0 || copy.isPending}
              onClick={() => copy.mutate()}
            >
              {copy.isPending ? "Copying…" : `Copy to ${copyTargets.length}`}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </div>
  );
}
