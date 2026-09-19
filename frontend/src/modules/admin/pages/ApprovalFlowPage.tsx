/** Settings > Approval Flow — one screen for "who signs what".
 *
 *  A list of document types, each showing its chain in a line. Clicking one opens the
 *  chain editor at its own route, so Save is a real button on a real page rather than a
 *  modal's confirm.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Users } from "lucide-react";

import { Button, Card, ErrorBanner, PageHeader, Select } from "@/shared/components";
import { adminApi } from "../api";
import type { FlowRow } from "../types";
import { PostsDrawer } from "../components/PostsDrawer";
import { JourneyPanel } from "../components/JourneyPanel";

/** The project picked here is remembered across visits. An admin configures one
 *  project's chains document by document, and coming back to "All projects" after every
 *  save meant re-picking it a dozen times in a row. */
const PROJECT_KEY = "approval-flow.project";

export function ApprovalFlowPage() {
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<number | null>(() => {
    const saved = localStorage.getItem(PROJECT_KEY);
    return saved ? Number(saved) : null;
  });
  const [showPosts, setShowPosts] = useState(false);

  function pickProject(next: number | null) {
    setProjectId(next);
    if (next == null) localStorage.removeItem(PROJECT_KEY);
    else localStorage.setItem(PROJECT_KEY, String(next));
  }

  const options = useQuery({
    queryKey: ["ladder-options"],
    queryFn: adminApi.ladders.options,
  });
  const overview = useQuery({
    queryKey: ["approval-flow", projectId],
    queryFn: () => adminApi.flow.overview(projectId),
  });

  const groups = useMemo(() => {
    const out: { module: string; rows: FlowRow[] }[] = [];
    for (const row of overview.data?.items ?? []) {
      const last = out[out.length - 1];
      if (last && last.module === row.module) last.rows.push(row);
      else out.push({ module: row.module, rows: [row] });
    }
    return out;
  }, [overview.data]);

  const unset = (overview.data?.items ?? []).filter((row) => !row.is_configured).length;
  const projectName = (options.data?.projects ?? [])
    .find((project) => project.id === projectId)?.name ?? null;

  function openChain(code: string) {
    navigate(`/admin/approval-flow/${code}`
      + (projectId != null ? `?project=${projectId}` : ""));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        eyebrow="Settings"
        title="Approval Flow"
        actions={
          <Button variant="soft" onClick={() => setShowPosts(true)}>
            <Users size={16} className="mr-1.5" /> Posts
          </Button>
        }
      />

      <div className="mb-5 flex items-center gap-3">
        <div className="w-56">
          <Select
            ariaLabel="Project"
            value={projectId ?? ""}
            placeholder="All projects"
            onChange={(value) => pickProject(value ? Number(value) : null)}
            options={[
              { value: "", label: "All projects" },
              ...(options.data?.projects ?? []).map((p) => ({
                value: String(p.id), label: p.name,
              })),
            ]}
          />
        </div>
        {unset > 0 && (
          <span className="text-sm text-muted">{unset} not set up</span>
        )}
      </div>

      <ErrorBanner error={overview.error} />

      {overview.isLoading ? (
        <p className="py-16 text-center text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-5">
          {groups.map(({ module, rows }) => (
            <section key={module}>
              <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
                {module}
              </h2>
              <Card className="divide-y divide-line/60 overflow-hidden">
                {rows.map((row) => (
                  <button
                    key={row.code}
                    type="button"
                    onClick={() => openChain(row.code)}
                    className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-content2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{row.label}</span>
                        {row.in_flight > 0 && (
                          <span className="shrink-0 rounded-full bg-content2 px-1.5 py-0.5 text-[11px] tabular-nums text-muted">
                            {row.in_flight}
                          </span>
                        )}
                      </div>
                      <ChainLine row={row} />
                    </div>
                    <ChevronRight size={16} className="shrink-0 text-muted" />
                  </button>
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}

      {!overview.isLoading && (overview.data?.items.length ?? 0) > 0 && (
        <JourneyPanel
          rows={overview.data?.items ?? []}
          projectName={projectName}
          onOpen={openChain}
        />
      )}

      {showPosts && <PostsDrawer onClose={() => setShowPosts(false)} />}
    </div>
  );
}

/** The chain itself — the only thing on the row that matters. */
function ChainLine({ row }: { row: FlowRow }) {
  if (row.self_approval_policy === "NO_APPROVAL") {
    return <p className="mt-0.5 text-[13px] text-muted">No signature needed</p>;
  }
  if (!row.summary) {
    return (
      <p className="mt-0.5 text-[13px] text-warn">Not set up — uses the reporting line</p>
    );
  }
  return (
    <>
      <p className="mt-0.5 truncate text-[13px] text-muted">{row.summary}</p>
      {/* Ranks with a chain of their own. Without this the row shows the default chain
        * and says nothing about the four ranks that never travel it. */}
      {row.raiser_chains?.length > 0 && (
        <p className="mt-0.5 truncate text-[11px] text-muted">
          Different for {row.raiser_chains.map((entry) => entry.role_name).join(", ")}
        </p>
      )}
    </>
  );
}
