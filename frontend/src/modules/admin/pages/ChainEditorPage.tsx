/** One document type's approval chain: build it, save it, see its history.
 *
 *  Its own route rather than a modal, so Save and Cancel are real buttons and leaving
 *  with unsaved changes asks first.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, History, Plus, Users } from "lucide-react";

import {
  Button, Card, ConfirmModal, ErrorBanner, PageHeader, Select, useToast,
} from "@/shared/components";
import { adminApi } from "../api";
import { StepList, stepKey } from "../components/StepList";
import { PostsDrawer } from "../components/PostsDrawer";
import type {
  CustomLadderStep, FlowRung, FlowVersion, SelfApprovalPolicy, StepKind,
} from "../types";

const PICKER_GROUPS: { kind: StepKind; label: string }[] = [
  { kind: "local", label: "Posts" },
  { kind: "rank", label: "Reporting line" },
  { kind: "hcm", label: "HCM posts" },
];

/** The hover text behind a chip: what this rung is, in the numbers that decide whether
 *  it is the right one. Two ranks can share a name (HCM's cutover left old role ids in
 *  place), and the size is what separates the live one from the leftover. */
function rungHint(kind: StepKind, rung: FlowRung): string | undefined {
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
  const [params] = useSearchParams();
  const projectId = params.get("project") ? Number(params.get("project")) : null;

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

  const chain = useQuery({
    queryKey: ["approval-flow-chain", projectId, docType],
    queryFn: () => adminApi.flow.chain(projectId, docType),
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

  const save = useMutation({
    mutationFn: () => adminApi.flow.save(projectId, docType, steps, {
      self_approval_policy: policy,
      fallback_position_id: chain.data?.fallback_position_id ?? null,
    }),
    onSuccess: (saved) => {
      toast.success(`Saved as v${saved.version}`);
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["approval-flow"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-chain"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-versions"] });
    },
  });

  function update(next: CustomLadderStep[]) {
    setSteps(next);
    setDirty(true);
  }

  const chosen = useMemo(() => new Set(steps.map(stepKey)), [steps]);
  const noApproval = policy === "NO_APPROVAL";
  const label = chain.data?.label ?? docType;

  function add(kind: StepKind, rung: FlowRung) {
    if (chosen.has(`${kind}:${rung.id}`)) return;
    update([...steps, {
      sequence: steps.length + 1,
      name: rung.name,
      kind,
      position_id: kind === "hcm" ? rung.id : null,
      post_id: kind === "local" ? rung.id : null,
      position_role_id: kind === "rank" ? rung.id : null,
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
      : kind === "rank" ? rungs.data?.ranks : rungs.data?.hcm) ?? [],
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

      {showPosts && <PostsDrawer onClose={() => setShowPosts(false)} />}
      {showHistory && (
        <HistoryPanel
          docType={docType}
          projectId={projectId}
          onClose={() => setShowHistory(false)}
          onRestored={() => { setLoaded(false); setDirty(false); setShowHistory(false); }}
        />
      )}
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

/** Every saved version, and what is still riding each one. */
function HistoryPanel({ docType, projectId, onClose, onRestored }: {
  docType: string;
  projectId: number | null;
  onClose: () => void;
  onRestored: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);

  const versions = useQuery({
    queryKey: ["approval-flow-versions", projectId, docType],
    queryFn: () => adminApi.flow.versions(projectId, docType),
  });
  const restore = useMutation({
    mutationFn: (workflowId: number) =>
      adminApi.flow.restore(projectId, docType, workflowId),
    onSuccess: (saved) => {
      toast.success(`Restored as v${saved.version}`);
      queryClient.invalidateQueries({ queryKey: ["approval-flow"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-chain"] });
      queryClient.invalidateQueries({ queryKey: ["approval-flow-versions"] });
      onRestored();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" className="flex-1 bg-black/25"
              onClick={onClose} />
      <aside className="flex w-full max-w-md flex-col bg-content1 shadow-xl">
        <header className="flex min-h-14 items-center border-b border-line/70 px-4">
          <h2 className="flex-1 text-base font-semibold">History</h2>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </header>
        <div className="flex-1 space-y-2 overflow-y-auto p-4">
          <ErrorBanner error={versions.error ?? restore.error} />
          {(versions.data ?? []).map((version) => (
            <VersionRow
              key={version.workflow_id}
              version={version}
              expanded={expanded === version.workflow_id}
              busy={restore.isPending}
              onToggle={() => setExpanded(
                expanded === version.workflow_id ? null : version.workflow_id)}
              onRestore={() => restore.mutate(version.workflow_id)}
            />
          ))}
          {(versions.data?.length ?? 0) === 0 && !versions.isLoading && (
            <p className="py-8 text-center text-sm text-muted">Never saved</p>
          )}
        </div>
      </aside>
    </div>
  );
}

function VersionRow({ version, expanded, busy, onToggle, onRestore }: {
  version: FlowVersion;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
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

      <p className="mt-0.5 truncate text-[13px] text-muted">
        {version.summary || "No steps"}
      </p>
      <p className="mt-0.5 text-xs text-muted">
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
                <li key={document.id} className="text-xs text-muted">
                  <span className="font-medium text-body">{document.doc_no}</span>
                  {document.stage && ` · at ${document.stage}`}
                  {document.started_by && ` · by ${document.started_by}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
