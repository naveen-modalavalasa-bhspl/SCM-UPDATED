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
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Switch,
} from "@heroui/react";
import {
  AlertTriangle, ArrowRight, Copy, ListOrdered, Plus, RotateCcw, Sparkles, Trash2,
} from "lucide-react";
import { Button, Card, Field, Input, PageHeader, Select } from "@/shared/components";
import { adminApi } from "../api";
import type {
  LadderHolder, LadderPosition, LadderRung, Operator, ReminderConfig,
  ReminderRunResult, WorkflowCondition,
} from "../types";
import { OPERATOR_LABEL } from "../ruleLanguage";

const CONDITION_FIELDS = [
  { value: "amount", label: "Document value" },
  { value: "department_id", label: "Department" },
  { value: "item_count", label: "Number of lines" },
];
const CONDITION_OPERATORS: Operator[] = ["GT", "GTE", "LT", "LTE", "EQ", "NEQ"];

/** Rank names and their people change only when HCM syncs, and a rank's posts not even
 *  then — long enough that re-reading them on every visit is pure waste. */
const HCM_STALE_MS = 5 * 60 * 1000;

/** "Naresh Babu Metta +42". The count is the rank's real total; the names are the
 *  first few, and arrive with the ranks read a moment after the rungs. */
const holderLabel = (holders: LadderHolder[] | undefined, total: number) => {
  if (!holders?.length) return total > 0 ? `${total} holder${total > 1 ? "s" : ""}` : "";
  return `${holders[0].name}${total > 1 ? ` +${total - 1}` : ""}`;
};

const newCondition = (): WorkflowCondition => ({
  field_name: "amount", operator: "GT", field_value: "", logic: "AND",
});

const positionDepartments = (positions: LadderPosition[]) => {
  const groups = new Map<string, {
    id: number | null; name: string; positions: LadderPosition[];
  }>();
  for (const position of positions) {
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

/** The posts under one rank, read only once the rung is opened.
 *
 *  A live project holds ~3,400 posts across seventeen ranks. Shipping all of them with
 *  every ladder read cost 1.3 MB and seconds, to fill in a panel that is closed until
 *  somebody clicks it. */
// The select needs a non-empty value for the company-wide ladder: its id is null, and
// an empty value is how the control says "nothing picked". `undefined` is therefore
// "nothing picked yet" and `null` is the real, selectable company-wide choice — the
// only home for SCM staff, whom HCM tags to no project at all.
const COMPANY_WIDE = "company";

function RungPositions({ projectId, roleId, selected, onToggle }: {
  projectId: number | null | undefined;
  roleId: number;
  /** null — nothing ticked — means the rung is the whole rank. */
  selected: number[] | null;
  onToggle: (positionIds: number[], selected: boolean) => void;
}) {
  const positions = useQuery({
    queryKey: ["admin", "ladder-rank-positions", projectId, roleId],
    queryFn: () => adminApi.ladders.rankPositions(projectId ?? null, roleId),
    enabled: projectId !== undefined,
    staleTime: HCM_STALE_MS,
  });
  const selectedIds = new Set(selected ?? []);

  return (
    <div className="mb-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink">
        Eligible approver positions
      </div>
      <p className="mb-3 text-xs text-muted">
        {selected === null
          ? "Nothing ticked means every position at this rank approves — including "
            + "posts held by people outside this project, which a reporting line often "
            + "climbs through. Tick positions only to narrow it."
          : "Selecting a department selects every position in it. You can still "
            + "adjust individual positions afterwards. Untick them all to go back to "
            + "the whole rank."}
      </p>
      {positions.isLoading && <div className="text-sm text-muted">Loading positions…</div>}
      {positions.isError && (
        <div className="text-sm text-bad">Could not load this rank's positions.</div>
      )}
      <div className="space-y-3">
        {positionDepartments(positions.data ?? []).map((department) => {
          const departmentIds = department.positions.map((position) => position.id);
          const allSelected = departmentIds.length > 0
            && departmentIds.every((id) => selectedIds.has(id));
          return (
            <div key={department.id ?? department.name} className="rounded-lg border border-line bg-content1 p-3">
              <label className="flex min-h-8 items-center gap-2 text-sm font-semibold text-ink">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(event) => onToggle(departmentIds, event.target.checked)}
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
                      onChange={(event) => onToggle([position.id], event.target.checked)}
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
  );
}

export function ApprovalConfigPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<number | null | undefined>(undefined);
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
    if (projectId === undefined && first) setProjectId(first.id);
  }, [options.data, projectId]);

  // Two reads, deliberately. The ladder is per project AND document; the ranks behind
  // it are per project only, so flipping the Document dropdown no longer re-derives
  // an identical answer from 3,400 HCM positions.
  const ladder = useQuery({
    queryKey: ["admin", "ladders", projectId, docType],
    queryFn: () => adminApi.ladders.get(projectId ?? null, docType),
    enabled: projectId !== undefined,
    staleTime: HCM_STALE_MS,
  });

  const ranks = useQuery({
    queryKey: ["admin", "ladder-ranks", projectId],
    queryFn: () => adminApi.ladders.ranks(projectId ?? null),
    enabled: projectId !== undefined,
    staleTime: HCM_STALE_MS,
  });

  const holdersOf = useMemo(
    () => new Map((ranks.data ?? []).map((rank) => [rank.role_id, rank.holders])),
    [ranks.data],
  );

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
    queryFn: () => adminApi.ladders.preview(projectId ?? null, docType, rungs, fromRoleId),
    enabled: projectId !== undefined && fromRoleId !== null && rungs.length > 0,
  });

  const save = useMutation({
    mutationFn: () => adminApi.ladders.save(projectId ?? null, docType, rungs),
    onSuccess: () => {
      setConfirming(false);
      // Only the ladder moved. The ranks and their posts come from HCM and are
      // untouched by a save, so they keep their cache.
      qc.invalidateQueries({ queryKey: ["admin", "ladders"] });
    },
    onError: (err: Error) => { setConfirming(false); setError(err.message); },
  });

  const copy = useMutation({
    mutationFn: () => adminApi.ladders.copy(projectId ?? null, docType, copyTargets),
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

  /** Untouched, a rung is the whole rank (null). Ticking a post narrows it to a list;
   *  clearing the last tick hands it back to the rank rather than leaving a rung with
   *  nobody eligible, which is not a state anyone means to save. */
  const togglePositions = (index: number, positionIds: number[], selected: boolean) =>
    setRungs((current) => current.map((rung, i) => {
      if (i !== index) return rung;
      const next = new Set(rung.selected_position_ids ?? []);
      for (const positionId of positionIds) {
        if (selected) next.add(positionId);
        else next.delete(positionId);
      }
      return { ...rung, selected_position_ids: next.size ? [...next] : null };
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

      {/* Warnings from the last save. A rung at a rank no reporting line climbs
          through saves fine and then silently approves nothing, so the only place
          this can be said usefully is right after the save that caused it. */}
      {(save.data?.warnings ?? []).length > 0 && (
        <div className="mb-4 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
          <p className="mb-1 inline-flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Saved, but check these rungs
          </p>
          <ul className="list-disc pl-5">
            {save.data!.warnings.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      <OverdueChasePanel />
      <StaleLadderPanel />

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Project"
            hint="Each project has its own ladder, built from the ranks its people hold."
          >
            <Select
              value={projectId === undefined ? "" : projectId ?? COMPANY_WIDE}
              placeholder="Pick a project"
              options={(options.data?.projects ?? []).map((p) => ({
                value: p.id ?? COMPANY_WIDE, label: p.name,
              }))}
              onChange={(value) => setProjectId(
                value === "" ? undefined : value === COMPANY_WIDE ? null : Number(value))}
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

      {ladder.data?.has_custom && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn-bg px-4 py-3">
          <p className="text-sm text-warn">
            This document is approved by a ladder you built by hand, not by the ranks
            below. Saving here would replace it.
          </p>
          <Button
            variant="ghost"
            onClick={() => navigate(
              `/admin/approvals-config/custom?doc_type=${docType}`
              + (projectId !== null ? `&project_id=${projectId}` : ""))}
          >
            Open it
          </Button>
        </div>
      )}

      {ladder.data?.is_new && !ladder.data?.has_custom && (
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
                    {rung.is_dead
                      ? <span className="inline-flex items-center gap-1 text-bad">
                          <AlertTriangle className="h-3 w-3" />
                          Nobody holds this rank — it will be skipped
                        </span>
                      : holderLabel(holdersOf.get(rung.position_role_id),
                                    rung.holder_count)}
                  </div>
                </div>
                <button
                  type="button"
                  className="min-h-11 rounded-lg px-3 text-xs font-semibold text-brand"
                  onClick={() => setAdvanced(advanced === index ? null : index)}
                >
                  {rung.selected_position_ids === null
                    ? `All ${rung.position_count} positions`
                    : `${rung.selected_position_ids.length} of ${rung.position_count} positions`}
                  {rung.conditions.length > 0
                    ? ` · ${rung.conditions.length} condition${rung.conditions.length > 1 ? "s" : ""}`
                    : ""}
                </button>
              </div>

              {advanced === index && (
                <div className="border-t border-line/50 bg-content2/40 px-4 py-3">
                  <RungPositions
                    projectId={projectId}
                    roleId={rung.position_role_id}
                    selected={rung.selected_position_ids ?? []}
                    onToggle={(ids, on) => togglePositions(index, ids, on)}
                  />
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

        {/* Climbing only works when the approver is above the raiser. For Inventory
            and Warehouse they are not — the whole warehouse department sits on posts
            with no parent, and all of them share one rank. That needs a ladder built
            by hand out of posts. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-4">
          <p className="text-xs text-muted">
            Approver isn't above whoever raises it — a warehouse or stores person?
            Pick them by post instead.
          </p>
          <Button
            variant="ghost"
            onClick={() => navigate(
              `/admin/approvals-config/custom?doc_type=${docType}`
              + (projectId !== null ? `&project_id=${projectId}` : ""))}
          >
            <ListOrdered className="h-4 w-4" /> Build your own ladder
          </Button>
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

/** Overdue-approval chasing: remind the approver, then escalate to their manager.
 *
 *  Ships switched OFF and says what it would do before it does anything. This writes
 *  notifications to real people's inboxes, and the first run against a queue that has
 *  been quietly ageing for weeks would land on everyone at once — so the count and the
 *  breakdown are on screen before the switch is, and "Run now" is separate from the
 *  timer for the same reason.
 *
 *  Nothing here touches a document. The worst a misfire can do is send a notification. */
function OverdueChasePanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ReminderConfig | null>(null);
  const [ran, setRan] = useState<ReminderRunResult | null>(null);

  const status = useQuery({
    queryKey: ["admin", "reminders"],
    queryFn: () => adminApi.reminders.status(),
    staleTime: 30 * 1000,
  });

  const config = draft ?? status.data?.config ?? null;
  const items = status.data?.items ?? [];
  const counts = {
    remind: items.filter((i) => i.next_action === "REMIND").length,
    escalate: items.filter((i) => i.next_action === "ESCALATE").length,
  };

  const save = useMutation({
    mutationFn: (next: ReminderConfig) => adminApi.reminders.save(next),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["admin", "reminders"] });
    },
  });

  const runNow = useMutation({
    mutationFn: () => adminApi.reminders.runNow(),
    onSuccess: (result) => {
      setRan(result);
      qc.invalidateQueries({ queryKey: ["admin", "reminders"] });
    },
  });

  if (!config) return null;
  const set = (patch: Partial<ReminderConfig>) => setDraft({ ...config, ...patch });

  return (
    <Card className="mb-5 p-4">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex min-h-11 w-full items-center gap-2 text-left text-sm"
      >
        <AlertTriangle className={`h-4 w-4 ${config.enabled ? "text-warn" : "text-muted"}`} />
        <span className="font-medium">
          {status.data?.total ?? 0} approval{(status.data?.total ?? 0) === 1 ? "" : "s"} overdue
        </span>
        <span className="text-muted">
          · chasing is {config.enabled ? "on" : "off"}
        </span>
        <span className="ml-auto text-muted">{open ? "Hide" : "Settings"}</span>
      </button>

      {open && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-3 text-xs text-muted">
            An overdue approval is reminded up to {config.max_reminders} time
            {config.max_reminders === 1 ? "" : "s"}, at most once every {config.gap_hours}h.
            After that it escalates once to the approver's reporting manager. Approvals
            carry no due date today, so one is treated as overdue{" "}
            {config.overdue_after_days} day{config.overdue_after_days === 1 ? "" : "s"} after
            it reaches the approver.
          </p>

          <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Overdue after (days)">
              <Input type="number" min={0} value={String(config.overdue_after_days)}
                     onChange={(e) => set({ overdue_after_days: Number(e.target.value) })} />
            </Field>
            <Field label="Reminders before escalating">
              <Input type="number" min={0} value={String(config.max_reminders)}
                     onChange={(e) => set({ max_reminders: Number(e.target.value) })} />
            </Field>
            <Field label="Hours between reminders">
              <Input type="number" min={0} value={String(config.gap_hours)}
                     onChange={(e) => set({ gap_hours: Number(e.target.value) })} />
            </Field>
            <Field label="Check every (minutes)">
              <Input type="number" min={0} value={String(config.interval_minutes)}
                     onChange={(e) => set({ interval_minutes: Number(e.target.value) })} />
            </Field>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Switch
              isSelected={config.enabled}
              onValueChange={(on) => set({ enabled: on })}
            >
              <span className="text-sm">Chase automatically on this schedule</span>
            </Switch>
            {status.data?.next_run && (
              <span className="text-xs text-muted">
                Next run {new Date(status.data.next_run).toLocaleString()}
              </span>
            )}
          </div>

          {/* The count that matters most before switching on: how many notifications
              the very next sweep would send. */}
          <p className="mb-3 rounded-lg bg-warn-bg px-3 py-2 text-sm text-warn">
            Right now the next sweep would send {counts.remind} reminder
            {counts.remind === 1 ? "" : "s"} and {counts.escalate} escalation
            {counts.escalate === 1 ? "" : "s"}.
          </p>

          {ran && (
            <p className="mb-3 rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok">
              Sent {ran.reminded} reminder{ran.reminded === 1 ? "" : "s"} and{" "}
              {ran.escalated} escalation{ran.escalated === 1 ? "" : "s"}
              {ran.skipped > 0 && `, skipped ${ran.skipped} with no manager on record`}.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!draft || save.isPending}
              onClick={() => draft && save.mutate(draft)}
            >
              {save.isPending ? "Saving…" : "Save settings"}
            </Button>
            {draft && (
              <Button variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
            )}
            <Button
              variant="subtle"
              disabled={runNow.isPending || (status.data?.total ?? 0) === 0}
              onClick={() => runNow.mutate()}
            >
              {runNow.isPending ? "Chasing…" : "Run now"}
            </Button>
          </div>

          {items.length > 0 && (
            <div className="mt-3 max-h-64 overflow-auto border-t border-line pt-3">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted">
                  <tr>
                    <th className="py-1 pr-3">Document</th>
                    <th className="py-1 pr-3">Waiting at</th>
                    <th className="py-1 pr-3">Overdue</th>
                    <th className="py-1 pr-3">Reminders</th>
                    <th className="py-1">Next</th>
                  </tr>
                </thead>
                <tbody>
                  {items.slice(0, 50).map((row) => (
                    <tr key={row.pending_id} className="border-t border-line">
                      <td className="py-1.5 pr-3">{row.doc_no ?? `#${row.doc_id}`}</td>
                      <td className="py-1.5 pr-3">{row.stage_name ?? "—"}</td>
                      <td className="py-1.5 pr-3">{row.days_overdue}d</td>
                      <td className="py-1.5 pr-3">{row.reminders_sent}</td>
                      <td className="py-1.5">{row.next_action.toLowerCase()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {items.length > 50 && (
                <p className="pt-2 text-xs text-muted">
                  Showing the 50 most overdue of {items.length}.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Documents still climbing a ladder that has since been replaced.
 *
 *  This is not a fault list. Freezing the chain at submit is the correct behaviour —
 *  it is what stops an edit moving a document that is already halfway through. But it
 *  is invisible, and "I fixed the ladder, so why is it still sitting with the old
 *  approver" is the question it answers. Collapsed by default: on a healthy setup it
 *  is noise, and on an unhealthy one the count in the header is the whole message.
 *
 *  Deliberately NOT scoped to the project on screen. The point is to see all of them
 *  at once, which is the opposite of the rest of this page. */
function StaleLadderPanel() {
  const [open, setOpen] = useState(false);
  const stale = useQuery({
    queryKey: ["admin", "ladders", "stale"],
    queryFn: () => adminApi.ladders.staleInFlight(),
    staleTime: 60 * 1000,
  });

  const total = stale.data?.total ?? 0;
  if (total === 0) return null;

  return (
    <Card className="mb-5 p-4">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="flex min-h-11 w-full items-center gap-2 text-left text-sm"
      >
        <ListOrdered className="h-4 w-4 text-muted" />
        <span className="font-medium">
          {total} document{total > 1 ? "s are" : " is"} running on a replaced ladder
        </span>
        <span className="ml-auto text-muted">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="mt-3 overflow-x-auto border-t border-line pt-3">
          <p className="mb-3 text-xs text-muted">
            Each of these entered approval before the ladder was last saved, so it
            finishes on the version it started with. Nothing here needs fixing — cancel
            and re-raise a document only if it must follow the new ladder.
          </p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-muted">
              <tr>
                <th className="py-1 pr-3">Document</th>
                <th className="py-1 pr-3">Project</th>
                <th className="py-1 pr-3">Raised by</th>
                <th className="py-1 pr-3">Waiting at</th>
                <th className="py-1 pr-3">Running</th>
                <th className="py-1">Live</th>
              </tr>
            </thead>
            <tbody>
              {stale.data!.items.map((row) => (
                <tr key={row.instance_id} className="border-t border-line">
                  <td className="py-1.5 pr-3">{row.doc_no ?? `#${row.doc_id}`}</td>
                  <td className="py-1.5 pr-3">{row.project_name ?? "—"}</td>
                  <td className="py-1.5 pr-3">{row.raised_by ?? "—"}</td>
                  <td className="py-1.5 pr-3">{row.stage_name ?? "—"}</td>
                  <td className="py-1.5 pr-3">
                    v{row.running_version}
                    {row.versions_behind > 0 && (
                      <span className="ml-1 text-muted">
                        ({row.versions_behind} behind)
                      </span>
                    )}
                  </td>
                  <td className="py-1.5">v{row.live_version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
