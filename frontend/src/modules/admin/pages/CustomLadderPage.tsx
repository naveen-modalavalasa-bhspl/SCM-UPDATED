/* Settings > Approvals Config > Build your own ladder.
 *
 * The rank ladder answers "who is above me?". That is right for an Indent — a
 * storekeeper's request really does travel Store Supervisor → OE → District Manager.
 *
 * It is wrong for Inventory and Warehouse, and HCM says so: the whole SCM/warehouse
 * department sits on posts with no parent and no children, so climbing from a
 * storekeeper never reaches them — and all twelve share ONE rank ("WAREHOUSE MANAGER"),
 * so a rank toggle cannot name one of them either.
 *
 * So here a step is a POST, picked from a department, and the steps run in the order
 * they were ticked. A department is a dozen posts, which is why this is a checkbox list
 * and not a search box over 2,787 people. Still never a person: the post is the rung,
 * so whoever takes the chair inherits the approval.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Trash2,
} from "lucide-react";
import { Button, Card, Field, PageHeader, Select } from "@/shared/components";
import { adminApi } from "../api";
import type { CustomLadderStep, LadderPost } from "../types";

/** Departments and their posts move only when HCM syncs. */
const HCM_STALE_MS = 5 * 60 * 1000;

const stepFromPost = (post: LadderPost, sequence: number): CustomLadderStep => ({
  sequence, position_id: post.id, name: post.name, holders: post.holders,
  is_dead: post.holders.length === 0,
});

const resequence = (steps: CustomLadderStep[]) =>
  steps.map((step, index) => ({ ...step, sequence: index + 1 }));

const holderLabel = (step: CustomLadderStep) =>
  step.holders.map((holder) => holder.name).join(", ");

export function CustomLadderPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [projectId, setProjectId] = useState<number | null>(
    params.get("project_id") ? Number(params.get("project_id")) : null);
  const [docType, setDocType] = useState(params.get("doc_type") || "GRN");
  const [department, setDepartment] = useState<string>("");
  const [steps, setSteps] = useState<CustomLadderStep[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const options = useQuery({
    queryKey: ["admin", "ladders", "options"],
    queryFn: adminApi.ladders.options,
  });

  useEffect(() => {
    const first = options.data?.projects[0];
    if (projectId === null && first) setProjectId(first.id);
  }, [options.data, projectId]);

  const departments = useQuery({
    queryKey: ["admin", "ladder-departments", projectId],
    queryFn: () => adminApi.customLadders.departments(projectId),
    enabled: projectId !== null,
    staleTime: HCM_STALE_MS,
  });

  const posts = useQuery({
    queryKey: ["admin", "ladder-department-posts", projectId, department],
    queryFn: () => adminApi.customLadders.posts(projectId, department),
    enabled: projectId !== null && department !== "",
    staleTime: HCM_STALE_MS,
  });

  const saved_ladder = useQuery({
    queryKey: ["admin", "custom-ladder", projectId, docType],
    queryFn: () => adminApi.customLadders.get(projectId, docType),
    enabled: projectId !== null,
  });

  // The server's steps are the starting point; from then on the list is local until
  // Save, so the chain below follows every tick live.
  useEffect(() => {
    if (!saved_ladder.data) return;
    setSteps(saved_ladder.data.steps);
    setError(null);
    setSaved(null);
  }, [saved_ladder.data]);

  const save = useMutation({
    mutationFn: () => adminApi.customLadders.save(projectId, docType, steps),
    onSuccess: (data) => {
      setConfirming(false);
      setSteps(data.steps);
      setSaved(`Saved as version ${data.version}.`);
    },
    onError: (err: Error) => { setConfirming(false); setError(err.message); },
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

  const chosen = new Set(steps.map((step) => step.position_id));
  const projectName = options.data?.projects.find((p) => p.id === projectId)?.name ?? "";
  const docLabel = options.data?.doc_types.find((d) => d.code === docType)?.label ?? docType;

  const togglePost = (post: LadderPost, on: boolean) =>
    setSteps((current) => resequence(on
      ? [...current, stepFromPost(post, current.length + 1)]
      : current.filter((step) => step.position_id !== post.id)));

  const move = (index: number, by: number) =>
    setSteps((current) => {
      const target = index + by;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return resequence(next);
    });

  return (
    <div>
      <PageHeader
        eyebrow="Settings · Approvals Config"
        title="Build your own ladder"
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate("/admin/approvals-config")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button
              disabled={steps.length === 0 || save.isPending}
              onClick={() => setConfirming(true)}
            >
              Save ladder
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">{error}</div>
      )}
      {saved && (
        <div className="mb-4 rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok">{saved}</div>
      )}

      <Card className="mb-5 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Project">
            <Select
              value={projectId ?? ""}
              placeholder="Pick a project"
              options={(options.data?.projects ?? []).map((p) => ({
                value: p.id, label: p.name,
              }))}
              onChange={(value) => setProjectId(value === "" ? null : Number(value))}
            />
          </Field>
          <Field label="Document">
            <Select
              value={docType}
              options={docsByModule.flatMap(({ module, docs }) =>
                docs.map((doc) => ({ value: doc.code, label: `${module} · ${doc.label}` })))}
              onChange={(value) => setDocType(String(value))}
            />
          </Field>
          <Field
            label="Approvers from"
            hint="The department the approvers sit in — Warehouse, Finance, Operations."
          >
            <Select
              value={department}
              placeholder={departments.isLoading ? "Loading…" : "Pick a department"}
              options={(departments.data ?? []).map((d) => ({
                value: d.name, label: `${d.name} (${d.position_count})`,
              }))}
              onChange={(value) => setDepartment(String(value))}
            />
          </Field>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="border-b border-line/70 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink">Pick the approvers</h2>
            <p className="text-xs text-muted">
              Tick a post, not a person. When the holder changes, whoever takes the
              chair inherits the approval.
            </p>
          </div>
          {department === "" && (
            <div className="p-6 text-sm text-muted">Pick a department first.</div>
          )}
          {posts.isLoading && <div className="p-6 text-sm text-muted">Loading posts…</div>}
          {posts.isError && (
            <div className="p-6 text-sm text-bad">Could not load this department's posts.</div>
          )}
          {posts.data?.length === 0 && (
            <div className="p-6 text-sm text-muted">
              Nobody in this project holds a post in {department}.
            </div>
          )}
          <ul>
            {(posts.data ?? []).map((post) => (
              <li key={post.id} className="border-b border-line/50 last:border-0">
                <label className="flex min-h-11 cursor-pointer items-start gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4"
                    checked={chosen.has(post.id)}
                    onChange={(event) => togglePost(post, event.target.checked)}
                  />
                  <span className="text-sm">
                    <span className="font-semibold text-ink">{post.name}</span>
                    <span className="block text-xs text-muted">
                      {post.holders.length > 0
                        ? post.holders.map((holder) => holder.name).join(", ")
                        : "Vacant — it would be skipped"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-line/70 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">The ladder</h2>
              <p className="text-xs text-muted">Top to bottom, in this order.</p>
            </div>
            <span className="text-xs text-muted">
              {steps.length} step{steps.length === 1 ? "" : "s"}
              {saved_ladder.data && !saved_ladder.data.is_new
                ? ` · v${saved_ladder.data.version}` : ""}
            </span>
          </div>
          {steps.length === 0 && (
            <div className="p-6 text-sm text-muted">
              Nothing ticked yet. Until you save one, this document keeps using the
              rank ladder.
            </div>
          )}
          <ul>
            {steps.map((step, index) => (
              <li key={step.position_id} className="border-b border-line/50 last:border-0">
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-050 text-xs font-semibold text-brand">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-ink">{step.name}</div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      {step.is_dead
                        ? <span className="inline-flex items-center gap-1 text-bad">
                            <AlertTriangle className="h-3 w-3" />
                            Vacant — this step will be skipped
                          </span>
                        : holderLabel(step)}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Move up"
                    className="min-h-11 rounded-lg px-2 text-muted disabled:opacity-30"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    className="min-h-11 rounded-lg px-2 text-muted disabled:opacity-30"
                    disabled={index === steps.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${step.name}`}
                    className="min-h-11 rounded-lg px-2 text-muted"
                    onClick={() => setSteps((current) => resequence(
                      current.filter((s) => s.position_id !== step.position_id)))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {steps.length > 0 && (
            <div className="m-4 rounded-xl border border-brand/25 bg-brand-050 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-brand">
                A {docLabel} goes to
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink">
                {steps.map((step, index) => (
                  <span key={step.position_id} className="contents">
                    {index > 0 && <ArrowRight className="h-3.5 w-3.5 text-muted" />}
                    <span className="rounded-lg bg-content1 px-2.5 py-1">
                      <span className="font-semibold">{step.name}</span>
                      {step.holders.length > 0 && (
                        <span className="text-muted"> · {holderLabel(step)}</span>
                      )}
                    </span>
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                Resolved when the document is raised and fixed for it, whatever you
                change afterwards.
              </p>
            </div>
          )}
        </Card>
      </div>

      <Modal isOpen={confirming} onOpenChange={() => setConfirming(false)} placement="center">
        <ModalContent>
          <ModalHeader>Save this ladder?</ModalHeader>
          <ModalBody className="text-sm text-body">
            <p>
              Creates version {(saved_ladder.data?.version ?? 0) + 1} for{" "}
              <strong>{docLabel}</strong> in <strong>{projectName}</strong>.
            </p>
            <p className="rounded-lg bg-warn-bg px-3 py-2 text-warn">
              This replaces whatever approves {docLabel} today, including the rank
              ladder — one document, one ladder.
            </p>
            {(saved_ladder.data?.in_flight ?? 0) > 0 && (
              <p className="rounded-lg bg-warn-bg px-3 py-2 text-warn">
                {saved_ladder.data!.in_flight} document
                {saved_ladder.data!.in_flight > 1 ? "s are" : " is"} already in approval
                and will finish on the current version.
              </p>
            )}
            <p className="text-xs text-muted">
              {steps.map((step) => step.name).join(" → ")}
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
    </div>
  );
}
