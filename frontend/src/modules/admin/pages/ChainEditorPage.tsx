/** One document type's approval chain: build it, save it, see its history.
 *
 *  Its own route rather than a modal, so Save and Cancel are real buttons and leaving
 *  with unsaved changes asks first.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Modal, ModalBody, ModalContent, ModalFooter, ModalHeader,
} from "@heroui/react";
import { ArrowRight, ChevronLeft, Copy, History, Plus, Users } from "lucide-react";

import {
  Button, Card, ConfirmModal, ErrorBanner, PageHeader, Select, useToast,
} from "@/shared/components";
import { adminApi } from "../api";
import { StepList, stepKey, stepKind } from "../components/StepList";
import { PostsDrawer } from "../components/PostsDrawer";
import type {
  CustomLadderStep, FlowDocument, FlowRung, FlowVersion, SelfApprovalPolicy,
  StepKind,
} from "../types";

const PICKER_GROUPS: { kind: StepKind; label: string }[] = [
  { kind: "local", label: "Posts" },
  { kind: "rank", label: "Reporting line" },
  // The chairs HCM has now created — SCM HEAD, INDENT TEAM, P O, CPO, DIRECTOR. They
  // are seated out of the SUPPLY CHAIN MANAGEMENT and H O projects, so they are not on
  // any field raiser's reporting line and never appeared under "Reporting line" for a
  // project like 104-MMU. Everyone holding the rank signs; nothing is climbed.
  { kind: "shared_rank", label: "Shared chairs (SCM / Head Office)" },
  { kind: "hcm", label: "HCM posts" },
];

/** The hover text behind a chip: what this rung is, in the numbers that decide whether
 *  it is the right one. Two ranks can share a name (HCM's cutover left old role ids in
 *  place), and the size is what separates the live one from the leftover. */
function rungHint(kind: StepKind, rung: FlowRung): string | undefined {
  if (kind === "shared_rank") {
    const people = rung.people?.length
      ? rung.people.join(", ") : "nobody is seated in it yet";
    return `${rung.name}: signed by ${people}. Not on the raiser's reporting line, `
      + `so every holder of this rank sees it whoever raised the document.`;
  }
  if (kind !== "rank" || rung.position_count === undefined) return undefined;
  const posts = `${rung.position_count} post${rung.position_count === 1 ? "" : "s"}`;
  const people = rung.people_count === undefined
    ? "" : `, ${rung.people_count} ${rung.people_count === 1 ? "person" : "people"}`;
  return rung.position_count <= 1
    ? `${rung.name}: only ${posts}${people}. Almost every raiser will climb past this `
      + `rung — check it is not an old rank left behind by the HCM cutover.`
    : `${rung.name}: ${posts}${people} under this rank.`;
}

export function ChainEditorPage() {
  const { docType = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const projectId = params.get("project") ? Number(params.get("project")) : null;
  // Which RANK of raiser this chain is for. Absent means the chain everybody else
  // uses — the one and only chain every document had before this existed. Kept in the
  // URL so the browser's back button walks the ranks and a link names one exactly.
  const raiserRoleId = params.get("raiser") ? Number(params.get("raiser")) : null;

  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [steps, setSteps] = useState<CustomLadderStep[]>([]);
  const [policy, setPolicy] = useState<SelfApprovalPolicy>("INDEPENDENT");
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showPosts, setShowPosts] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyTargets, setCopyTargets] = useState<number[]>([]);
  const [copyRankTargets, setCopyRankTargets] = useState<number[]>([]);
  // "DEFAULT" rather than null, so "no pending switch" and "switch to the default
  // chain" are two different states.
  const [pendingRaiser, setPendingRaiser] = useState<number | "DEFAULT" | null>(null);

  const chain = useQuery({
    queryKey: ["approval-flow-chain", projectId, docType, raiserRoleId],
    queryFn: () => adminApi.flow.chain(projectId, docType, raiserRoleId),
  });
  const rungs = useQuery({
    queryKey: ["approval-flow-rungs", projectId, search],
    queryFn: () => adminApi.flow.rungs(projectId, search),
  });

  // Seeded once — a refetch must not discard edits in progress.
  useEffect(() => {
    if (chain.data && !loaded) {
      setSteps(chain.data.steps ?? []);
      setPolicy(chain.data.self_approval_policy ?? "INDEPENDENT");
      setLoaded(true);
    }
  }, [chain.data, loaded]);

  // Switching rank is switching document: the chain on screen belongs to the rank that
  // was selected, so the next one has to be seeded from its own load.
  useEffect(() => {
    setLoaded(false);
    setDirty(false);
  }, [raiserRoleId]);

  const save = useMutation({
    mutationFn: () => adminApi.flow.save(projectId, docType, steps, {
      self_approval_policy: policy,
      fallback_position_id: chain.data?.fallback_position_id ?? null,
    }, raiserRoleId),
    onSuccess: (saved) => {
      toast.success(`Saved as v${saved.version}`);
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["approval-flow"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-chain"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-versions"] });
    },
  });

  // Copies what is SAVED, not what is on screen — so unsaved edits cannot leak onto
  // other projects or ranks behind the admin's back.
  const copy = useMutation({
    mutationFn: () => adminApi.flow.copy(
      { projectId, raiserRoleId }, docType,
      { projectIds: copyTargets, raiserRoleIds: copyRankTargets }),
    onSuccess: (result) => {
      const done = result.copied_to.length + result.copied_to_ranks.length;
      toast.success(`Copied to ${done} place${done === 1 ? "" : "s"}`);
      setCopying(false);
      setCopyTargets([]);
      setCopyRankTargets([]);
      queryClient.invalidateQueries({ queryKey: ["approval-flow"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-chain"] });
    },
  });

  function update(next: CustomLadderStep[]) {
    setSteps(next);
    setDirty(true);
  }

  /** Move to another rank's chain, asking first if this one has unsaved edits. */
  function pickRaiser(next: number | null) {
    if (next === raiserRoleId) return;
    if (dirty) { setPendingRaiser(next === null ? "DEFAULT" : next); return; }
    applyRaiser(next);
  }

  function applyRaiser(next: number | null) {
    const params_ = new URLSearchParams(params);
    if (next == null) params_.delete("raiser");
    else params_.set("raiser", String(next));
    setParams(params_, { replace: false });
  }

  // Already cached by the list screen this page is opened from — the project's NAME is
  // the only thing needed here, and it makes the preview say which project it describes.
  const options = useQuery({
    queryKey: ["ladder-options"],
    queryFn: adminApi.ladders.options,
  });

  const chosen = useMemo(() => new Set(steps.map(stepKey)), [steps]);
  const noApproval = policy === "NO_APPROVAL";
  const label = chain.data?.label ?? docType;
  const projectName = (options.data?.projects ?? [])
    .find((project) => project.id === projectId)?.name ?? null;
  const policyLabel = (chain.data?.policies ?? [])
    .find((choice) => choice.value === policy)?.label ?? null;

  // Ranks, highest first — the order the org chart reads in, so the picker is a
  // reporting line rather than an alphabetical list. Ranks come back keyed by depth
  // (smaller is higher), and only ranks carry it.
  const ranks = useMemo(
    () => [...(rungs.data?.ranks ?? [])].sort(
      (a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.name.localeCompare(b.name)),
    [rungs.data],
  );
  const perRaiser = chain.data?.supports_raiser_chains ?? false;
  const configuredRanks = new Set(
    (chain.data?.raiser_chains ?? []).map((entry) => entry.role_id));
  const raiserName = ranks.find((rank) => rank.id === raiserRoleId)?.name
    ?? chain.data?.raiser_role_name ?? null;

  function add(kind: StepKind, rung: FlowRung) {
    if (chosen.has(`${kind}:${rung.id}`)) return;
    update([...steps, {
      sequence: steps.length + 1,
      name: rung.name,
      kind,
      position_id: kind === "hcm" ? rung.id : null,
      post_id: kind === "local" ? rung.id : null,
      // Both rank kinds travel as a rank. Which one it IS — climbed or shared — is the
      // server's call, decided from whether this project's own people hold it.
      position_role_id: kind === "rank" || kind === "shared_rank" ? rung.id : null,
      holders: rung.members ?? [],
    }]);
  }

  function leave() {
    if (dirty) setLeaving(true);
    else navigate(-1);
  }

  const groups = PICKER_GROUPS.map(({ kind, label: groupLabel }) => ({
    kind,
    label: groupLabel,
    items: (kind === "local" ? rungs.data?.local
      : kind === "rank" ? rungs.data?.ranks
        : kind === "shared_rank" ? rungs.data?.shared_ranks
          : rungs.data?.hcm) ?? [],
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <button
        type="button"
        onClick={leave}
        className="mb-2 flex min-h-11 items-center gap-1 text-sm text-muted hover:text-body"
      >
        <ChevronLeft size={16} /> Approval Flow
      </button>

      <PageHeader
        eyebrow={chain.data?.is_legacy ? "Built on the old screen" : undefined}
        title={label}
        actions={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { setCopyTargets([]); setCopying(true); }}>
              <Copy size={16} className="mr-1.5" /> Copy to…
            </Button>
            <Button variant="ghost" onClick={() => setShowHistory(true)}>
              <History size={16} className="mr-1.5" /> History
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending || (!noApproval && steps.length === 0)}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      />

      <ErrorBanner error={save.error ?? chain.error} />

      {perRaiser && (
        <div className="mb-4">
          <div className="w-72">
            <Select
              label="When raised by"
              value={raiserRoleId ?? ""}
              onChange={(value) => pickRaiser(value ? Number(value) : null)}
              options={[
                { value: "", label: "Everyone (default chain)" },
                ...ranks.map((rank) => ({
                  value: String(rank.id),
                  // A tick, so the ranks that already have a chain of their own are
                  // visible without opening each one.
                  label: `${rank.name}${configuredRanks.has(rank.id) ? " ✓" : ""}`,
                })),
              ]}
            />
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {raiserRoleId == null
              ? `Used by every raiser without a chain of their own`
              + `${configuredRanks.size > 0 ? ` — ${configuredRanks.size} rank`
                + `${configuredRanks.size === 1 ? " has" : "s have"} one` : ""}.`
              : chain.data?.inherited_from_default
                ? `${raiserName ?? "This rank"} has no chain yet — this is the default `
                  + `one, unsaved. Edit and save to give them their own.`
                : `Only documents raised by ${raiserName ?? "this rank"} travel this `
                  + `chain.`}
          </p>
        </div>
      )}

      <div className="mb-4 w-72">
        <Select
          label="Who approves"
          value={policy}
          onChange={(value) => { setPolicy(value as SelfApprovalPolicy); setDirty(true); }}
          options={(chain.data?.policies ?? []).map((choice) => ({
            value: choice.value, label: choice.label,
          }))}
        />
      </div>

      {noApproval ? (
        <Card className="px-4 py-8 text-center text-sm text-muted">
          Approved the moment it is raised
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-[1fr_18rem]">
          <div>
            <StepList steps={steps} onChange={update} />
            {(chain.data?.warnings ?? []).map((warning) => (
              <p key={warning} className="mt-2 text-xs text-warn">{warning}</p>
            ))}
          </div>

          <Card className="h-fit p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                Add a step
              </span>
              <button
                type="button"
                onClick={() => setShowPosts(true)}
                className="flex min-h-11 items-center gap-1 text-xs text-muted hover:text-body"
              >
                <Users size={13} /> Posts
              </button>
            </div>
            <input
              placeholder="Search HCM posts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="mb-2 min-h-11 w-full rounded-md border border-line/70 bg-content1 px-2.5 text-sm outline-none focus:border-primary"
            />
            <div className="max-h-96 space-y-3 overflow-y-auto">
              {groups.map(({ kind, label: groupLabel, items }) => (
                items.length === 0 ? null : (
                  <div key={kind}>
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {groupLabel}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {items.map((rung) => (
                        <button
                          key={`${kind}-${rung.id}`}
                          type="button"
                          disabled={chosen.has(`${kind}:${rung.id}`)}
                          onClick={() => add(kind, rung)}
                          title={rungHint(kind, rung)}
                          className="flex min-h-11 items-center gap-1 rounded-full border border-line/70 px-2.5 text-xs transition-colors hover:border-primary hover:bg-content2 disabled:pointer-events-none disabled:opacity-35"
                        >
                          <Plus size={11} /> {rung.name}
                          {/* How big this rank actually is. HCM re-keyed its roles at the
                            * 2026-08-10 cutover and a few positions kept their old role
                            * id, so the same NAME can arrive twice — a real District
                            * Manager over 27 posts and a leftover over 1. A rung is a
                            * role id, and picking the small one builds a chain almost
                            * every raiser climbs straight past. The count is the only
                            * thing on screen that tells them apart. */}
                          {kind === "shared_rank" && rung.people_count !== undefined && (
                            <span className="ml-1 text-[11px] text-muted">
                              {rung.people_count} {rung.people_count === 1 ? "person" : "people"}
                            </span>
                          )}
                          {kind === "rank" && rung.position_count !== undefined && (
                            <span className="tabular text-[10px] text-muted">
                              · {rung.position_count}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              ))}
              {search.trim().length >= 2 && (rungs.data?.hcm.length ?? 0) === 0 && (
                <p className="text-xs text-muted">No HCM post matches “{search}”.</p>
              )}
            </div>
          </Card>
        </div>
      )}

      {!noApproval && (
        <FlowPreview
          label={label}
          projectName={projectName}
          raiserName={perRaiser ? raiserName : null}
          steps={steps}
          policyLabel={policyLabel}
        />
      )}

      {showPosts && <PostsDrawer onClose={() => setShowPosts(false)} />}
      {showHistory && (
        <HistoryPanel
          docType={docType}
          projectId={projectId}
          raiserRoleId={raiserRoleId}
          onClose={() => setShowHistory(false)}
          onRestored={() => { setLoaded(false); setDirty(false); setShowHistory(false); }}
        />
      )}
      <Modal isOpen={copying} onOpenChange={() => setCopying(false)} placement="center">
        <ModalContent>
          <ModalHeader>Copy this chain</ModalHeader>
          <ModalBody className="text-sm text-body">
            <p className="text-xs text-muted">
              The saved chain for <span className="font-medium">{label}</span> is copied
              step for step onto each project you tick, replacing whatever they use now.
              Each keeps its own version history, and documents already in approval are
              untouched. Unsaved edits on this screen are not included.
            </p>
            <ErrorBanner error={copy.error} />
            <div className="max-h-72 space-y-3 overflow-y-auto">
              {perRaiser && ranks.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Other raiser ranks, in this project
                  </p>
                  {/* Steps the target rank already outranks are dropped on the way in —
                    * an OE's chain must not contain "climb to an OE". Said here because
                    * it is the one part of a copy that is not verbatim. */}
                  <p className="mb-1 text-xs text-muted">
                    Steps at or below the target rank are left out.
                  </p>
                  {ranks.filter((rank) => rank.id !== raiserRoleId).map((rank) => (
                    <label key={rank.id} className="flex min-h-11 items-center gap-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={copyRankTargets.includes(rank.id)}
                        onChange={(event) => setCopyRankTargets((current) =>
                          event.target.checked
                            ? [...current, rank.id]
                            : current.filter((id) => id !== rank.id))}
                      />
                      <span>
                        {rank.name}
                        {configuredRanks.has(rank.id) && (
                          <span className="text-warn"> · replaces its chain</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}

              <div>
                {perRaiser && (
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                    Other projects
                  </p>
                )}
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
              </div>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={() => setCopying(false)}>Cancel</Button>
            <Button
              disabled={(copyTargets.length + copyRankTargets.length) === 0
                || copy.isPending}
              onClick={() => copy.mutate()}
            >
              {copy.isPending
                ? "Copying…"
                : `Copy to ${copyTargets.length + copyRankTargets.length}`}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      <ConfirmModal
        isOpen={pendingRaiser !== null}
        title="Switch without saving?"
        message="Your changes to this chain will be lost."
        confirmLabel="Switch"
        danger
        onConfirm={() => {
          applyRaiser(pendingRaiser === "DEFAULT" ? null : pendingRaiser);
          setPendingRaiser(null);
        }}
        onClose={() => setPendingRaiser(null)}
      />
      <ConfirmModal
        isOpen={leaving}
        title="Leave without saving?"
        message="Your changes to this chain will be lost."
        confirmLabel="Leave"
        danger
        onConfirm={() => navigate(-1)}
        onClose={() => setLeaving(false)}
      />
    </div>
  );
}

/** What the chain on screen actually does, as a sentence — the unsaved steps, not the
 *  saved ones, so the admin reads the outcome of an edit before committing to it.
 *  Built from local state only: no request, so it keeps up with every drag. */
function FlowPreview({ label, projectName, raiserName, steps, policyLabel }: {
  label: string;
  projectName: string | null;
  raiserName: string | null;
  steps: CustomLadderStep[];
  policyLabel: string | null;
}) {
  return (
    <Card className="mt-5 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        What this means
      </p>
      <p className="text-sm">
        <span className="text-muted">A </span>
        <span className="font-medium">{label}</span>
        <span className="text-muted">
          {" "}raised {projectName ? `in ${projectName}` : "in any project"}
          {raiserName ? ` by a ${raiserName}` : ""} goes to:
        </span>
      </p>

      {steps.length === 0 ? (
        <p className="mt-2 text-[13px] text-warn">
          No steps yet — it would fall back to the raiser's reporting line.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px]">
          {steps.map((step, index) => {
            const seats = step.holders ?? [];
            const who = stepKind(step) === "rank"
              ? "whoever the raiser reports up to"
              : seats.length > 0
                ? seats.map((holder) => holder.name).join(", ")
                : "nobody seated — skipped";
            return (
              <span key={stepKey(step)} className="flex items-center gap-1.5">
                {index > 0 && <ArrowRight size={13} className="text-muted" />}
                <span className="rounded-md bg-content2 px-2 py-1">
                  <span className="font-medium">{step.name}</span>
                  <span className={seats.length === 0 && stepKind(step) !== "rank"
                    ? "text-warn" : "text-muted"}> · {who}</span>
                </span>
              </span>
            );
          })}
          <span className="flex items-center gap-1.5">
            <ArrowRight size={13} className="text-muted" />
            <span className="rounded-md bg-ok/10 px-2 py-1 font-medium text-ok">
              Approved
            </span>
          </span>
        </div>
      )}

      {policyLabel && (
        <p className="mt-2.5 text-xs text-muted">Self-approval: {policyLabel}</p>
      )}
    </Card>
  );
}

/** Every saved version, and what is still riding each one. */
function HistoryPanel({ docType, projectId, raiserRoleId, onClose, onRestored }: {
  docType: string;
  projectId: number | null;
  raiserRoleId: number | null;
  onClose: () => void;
  onRestored: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);

  // One rank's history, not the document's: the default chain and a rank's are
  // separate chains, and a Restore that crossed between them would move a chain into
  // a bucket it was never built for.
  const versions = useQuery({
    queryKey: ["approval-flow-versions", projectId, docType, raiserRoleId],
    queryFn: () => adminApi.flow.versions(projectId, docType, raiserRoleId),
  });
  const restore = useMutation({
    mutationFn: (workflowId: number) =>
      adminApi.flow.restore(projectId, docType, workflowId, raiserRoleId),
    onSuccess: (saved) => {
      toast.success(`Restored as v${saved.version}`);
      queryClient.invalidateQueries({ queryKey: ["approval-flow"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-chain"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-versions"] });
      onRestored();
    },
  });

  // Moving a document is the admin's one door through the freeze that keeps a saved
  // chain from touching documents already in approval, so it asks before it acts and
  // names where the document will land.
  const [moving, setMoving] = useState<FlowDocument | null>(null);
  const move = useMutation({
    mutationFn: (vars: { instanceId: number; workflowId: number }) =>
      adminApi.flow.moveDocument(vars.instanceId, vars.workflowId),
    onSuccess: (result) => {
      toast.success(`${result.doc_no ?? "Document"} now waiting at ${result.stage ?? "the first step"}`);
      setMoving(null);
      queryClient.invalidateQueries({ queryKey: ["approval-flow-versions"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow"] });
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" className="flex-1 bg-black/25"
              onClick={onClose} />
      <aside className="flex w-full max-w-lg flex-col bg-content1 shadow-xl">
        <header className="flex min-h-14 items-center border-b border-line/70 px-4">
          <h2 className="flex-1 text-base font-semibold">History</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </header>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          <ErrorBanner error={versions.error ?? restore.error ?? move.error} />
          {(versions.data ?? []).map((version) => (
            <VersionRow
              key={version.workflow_id}
              version={version}
              expanded={expanded === version.workflow_id}
              busy={restore.isPending}
              onToggle={() => setExpanded(
                expanded === version.workflow_id ? null : version.workflow_id)}
              onRestore={() => restore.mutate(version.workflow_id)}
              onMove={(document) => setMoving(document)}
            />
          ))}
          {(versions.data?.length ?? 0) === 0 && !versions.isLoading && (
            <p className="py-8 text-center text-sm text-muted">Never saved</p>
          )}
        </div>
      </aside>
      {moving && (
        <MoveDocumentModal
          document={moving}
          versions={(versions.data ?? []).filter(
            (version) => version.workflow_id !== moving.workflow_id)}
          busy={move.isPending}
          onClose={() => setMoving(null)}
          onMove={(workflowId) =>
            move.mutate({ instanceId: moving.id, workflowId })}
        />
      )}
    </div>
  );
}

/** Pick the version a document should climb instead. Deliberately not a one-press
 *  action on the row: it re-resolves who signs a live document, and the admin should
 *  read which chain that is before pressing. */
function MoveDocumentModal({ document, versions, busy, onClose, onMove }: {
  document: FlowDocument;
  versions: FlowVersion[];
  busy: boolean;
  onClose: () => void;
  onMove: (workflowId: number) => void;
}) {
  const [target, setTarget] = useState<string>(
    String(versions.find((version) => version.is_active)?.workflow_id ?? ""));

  return (
    <Modal isOpen onClose={onClose} size="lg">
      <ModalContent>
        <ModalHeader>Move {document.doc_no}</ModalHeader>
        <ModalBody className="space-y-3">
          <p className="text-sm text-muted">
            It is waiting at <span className="font-medium text-body">
              {document.stage ?? "the first step"}</span>. Moving it re-resolves who
            signs from the chain you pick and restarts it at that chain&apos;s first
            step — approvals already given were given by a chain that no longer governs
            it. The trail keeps every action.
          </p>
          <Select
            label="Move onto"
            value={target}
            onChange={setTarget}
            options={versions.map((version) => ({
              value: String(version.workflow_id),
              label: `v${version.version}${version.is_active ? " (live)" : ""} — ${
                version.summary || "no steps"}`,
            }))}
          />
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onMove(Number(target))}
                  disabled={!target || busy}>
            {busy ? "Moving…" : "Move document"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

const STEP_KIND_LABEL: Record<string, string> = {
  rank: "reporting line",
  local: "post",
  hcm: "HCM post",
};

function VersionRow({ version, expanded, busy, onToggle, onRestore, onMove }: {
  version: FlowVersion;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onMove: (document: FlowDocument) => void;
}) {
  const saved = version.saved_at
    ? new Date(version.saved_at).toLocaleDateString(undefined,
        { day: "numeric", month: "short", year: "numeric" })
    : null;

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${
      version.is_active ? "border-primary/50 bg-primary/5" : "border-line/70"
    }`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold tabular-nums">v{version.version}</span>
        {version.is_active && (
          <span className="rounded-full bg-ok/10 px-1.5 py-0.5 text-[11px] font-medium text-ok">
            Live
          </span>
        )}
        <span className="flex-1" />
        {!version.is_active && (
          <Button variant="ghost" onClick={onRestore} disabled={busy}>Restore</Button>
        )}
      </div>

      {/* The rungs in full, not the truncated one-liner: the whole reason to open a
          retired version is to see which step it differs by. */}
      {version.steps.length > 0 ? (
        <ol className="mt-1.5 space-y-1">
          {version.steps.map((step, index) => (
            <li key={`${step.sequence}-${step.name}`}
                className="flex items-start gap-2 text-[13px]">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center
                               rounded-full bg-content2 text-[11px] font-semibold
                               tabular-nums text-muted">
                {index + 1}
              </span>
              <span className="flex-1 leading-5">
                {step.name}
                <span className="ml-1.5 text-[11px] text-muted">
                  {STEP_KIND_LABEL[step.kind] ?? step.kind}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-0.5 text-[13px] text-muted">No steps</p>
      )}
      <p className="mt-1.5 text-xs text-muted">
        {[saved, version.saved_by].filter(Boolean).join(" · ") || "—"}
      </p>

      {version.documents.length > 0 && (
        <>
          <button
            type="button"
            onClick={onToggle}
            className="mt-1.5 min-h-11 text-xs font-medium text-primary"
          >
            {version.documents.length} document
            {version.documents.length > 1 ? "s" : ""} still on this version
          </button>
          {expanded && (
            <ul className="mt-1 space-y-1 border-t border-line/60 pt-1.5">
              {version.documents.map((document) => (
                <li key={document.id}
                    className="flex items-center gap-2 text-xs text-muted">
                  <span className="flex-1">
                    <span className="font-medium text-body">{document.doc_no}</span>
                    {document.stage && ` · at ${document.stage}`}
                    {document.started_by && ` · by ${document.started_by}`}
                  </span>
                  <Button variant="ghost" onClick={() => onMove(document)}
                          disabled={busy}>
                    Move
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
