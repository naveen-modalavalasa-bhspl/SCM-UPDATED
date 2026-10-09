/** Settings > Approval Flow — one screen for "who signs what".
 *
 *  A list of document types, each showing its chain in a line. Clicking one opens the
 *  chain editor at its own route, so Save is a real button on a real page rather than a
 *  modal's confirm.
 */
import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Users } from "lucide-react";

import { Button, Card, ErrorBanner, PageHeader, Select } from "@/shared/components";
import { adminApi } from "../api";
import type { FlowRow } from "../types";
import { PostsDrawer } from "../components/PostsDrawer";
import { JourneyPanel } from "../components/JourneyPanel";

/** The project lives in the URL, NEVER in `localStorage`.
 *
 *  It decides what the screen says — a ladder is configured per project per document
 *  type (rule 8) — so remembering it per browser meant two people on one deployment
 *  reading different answers to "who signs a purchase return", with nothing on screen
 *  saying why. `localStorage` is per origin and per browser profile, so the same admin
 *  on `localhost:5173` and on `10.2.1.30:5173` is two different memories.
 *
 *  The URL keeps what the remembered value was there for: the chain editor is opened
 *  with `?project=` already, and its `navigate(-1)` lands back on this URL, so
 *  configuring one project document by document still never returns to "All projects".
 *  And the link an admin sends a colleague now shows them the same screen. */

export function ApprovalFlowPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get("project"));
  const projectId = Number.isInteger(raw) && raw > 0 ? raw : null;
  const [showPosts, setShowPosts] = useState(false);

  function pickProject(next: number | null) {
    const nextParams = new URLSearchParams(params);
    if (next == null) nextParams.delete("project");
    else nextParams.set("project", String(next));
    // `replace`: picking a project refines this view rather than making a place to come
    // back to, or leaving the screen would cost one Back press per project tried.
    setParams(nextParams, { replace: true });
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
