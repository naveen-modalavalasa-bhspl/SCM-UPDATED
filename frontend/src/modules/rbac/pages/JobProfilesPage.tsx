/* RBAC > Job Profiles.
 *
 * The screen the Page/Feature Control matrices should have been. Those grant
 * against an HCM role, and HCM role 29 "MANAGER" covers fifteen unrelated jobs —
 * Inventory Manager, Chief Procurement Officer, Logistics Executive, four Senior
 * Executives. Tick Inventory there and all fifteen get Inventory.
 *
 * A job profile is the real job, derived from the position (see the backend
 * profiles.py for the rule). 3,733 live positions collapse to ~42 profiles:
 * DEO's 957 become one row, and MANAGER splits into the twelve it always was.
 *
 * Nothing here changes behaviour until a profile is saved. An unconfigured
 * profile still resolves through its old HCM role, which is why the list leads
 * with that badge — it is the only thing that tells you what is live.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, Check, Layers, RotateCcw, Users,
} from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select,
  ScrollBox, useToast,
} from "@/shared/components";
import { rbacApi } from "../api";
import type { JobProfileMatrix, ScopeRung } from "../types";

const SCOPE_HELP: Record<ScopeRung, string> = {
  SELF: "Only documents this person raised.",
  OFFICE: "Everything in their own office.",
  SUBTREE: "Their position and everyone reporting under it.",
  PROJECT: "Everything in their HCM project.",
  ALL: "The whole network. Nothing is hidden.",
};

const SCOPE_LABEL: Record<ScopeRung, string> = {
  SELF: "Own documents",
  OFFICE: "Own office",
  SUBTREE: "Own reporting line",
  PROJECT: "Own project",
  ALL: "Everything",
};

/** Pages grouped under their parent, so the matrix reads like the left rail does. */
const pageTree = (pages: JobProfileMatrix["pages"]) => {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const groups = new Map<string, { name: string; pages: typeof pages }>();
  for (const page of pages) {
    const parent = page.parent_id ? byId.get(page.parent_id) : undefined;
    const label = parent ? parent.name : page.name;
    const group = groups.get(label) ?? { name: label, pages: [] };
    group.pages.push(page);
    groups.set(label, group);
  }
  return [...groups.values()];
};

export function JobProfilesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["rbac", "job-profiles"],
    queryFn: rbacApi.jobProfiles.matrix,
  });

  const [search, setSearch] = useState("");
  // "" = every project. A profile is keyed by project, so this is the axis the list
  // is actually organised along — not a convenience filter.
  const [project, setProject] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pageCodes, setPageCodes] = useState<Set<string>>(new Set());
  const [featureCodes, setFeatureCodes] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<ScopeRung>("SELF");
  const [showHolders, setShowHolders] = useState(false);

  const profiles = data?.items ?? [];
  const selected = useMemo(
    () => profiles.find((p) => p.key === selectedKey) ?? null,
    [profiles, selectedKey],
  );

  // Land on the first profile, and reload the draft whenever the selection moves.
  useEffect(() => {
    if (!selectedKey && profiles.length) setSelectedKey(profiles[0].key);
  }, [profiles, selectedKey]);
  useEffect(() => {
    if (!selected) return;
    setPageCodes(new Set(selected.page_codes));
    setFeatureCodes(new Set(selected.permission_codes));
    setScope(selected.scope);
    setShowHolders(false);
  }, [selected]);

  const holders = useQuery({
    queryKey: ["rbac", "job-profiles", selectedKey, "holders"],
    queryFn: () => rbacApi.jobProfiles.holders(selectedKey as string),
    enabled: showHolders && !!selectedKey,
  });

  const save = useMutation({
    mutationFn: () => rbacApi.jobProfiles.setAccess(selected!.key, {
      page_codes: [...pageCodes],
      permission_codes: [...featureCodes],
      scope,
      name: selected!.name,
    }),
    onSuccess: () => {
      toast.success(`${selected?.name} saved`);
      queryClient.invalidateQueries({ queryKey: ["rbac", "job-profiles"] });
    },
    onError: () => toast.error("Could not save this profile"),
  });

  const reset = useMutation({
    mutationFn: () => rbacApi.jobProfiles.reset(selected!.key),
    onSuccess: () => {
      toast.success(`${selected?.name} handed back to its HCM role`);
      queryClient.invalidateQueries({ queryKey: ["rbac", "job-profiles"] });
    },
    onError: () => toast.error("Could not reset this profile"),
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return profiles.filter((p) => {
      // The company-wide default survives a project filter: it is what the filtered
      // project falls back to when it has no default of its own, so hiding it would
      // hide the rule actually in force.
      if (project && !p.is_company_default && String(p.project_id) !== project) {
        return false;
      }
      if (!needle) return true;
      return p.key.toLowerCase().includes(needle)
        || p.name.toLowerCase().includes(needle)
        || p.project_name.toLowerCase().includes(needle)
        || p.hcm_roles.some((r) => r.toLowerCase().includes(needle))
        || p.positions.some((pos) => pos.name.toLowerCase().includes(needle));
    });
  }, [profiles, search, project]);

  // Counted off the unfiltered list so the numbers stay put while you filter.
  const perProject = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of profiles) counts.set(p.project_id, (counts.get(p.project_id) ?? 0) + 1);
    return counts;
  }, [profiles]);

  const groups = useMemo(() => pageTree(data?.pages ?? []), [data?.pages]);
  const featureModules = useMemo(() => {
    const byModule = new Map<string, JobProfileMatrix["features"]>();
    for (const feature of data?.features ?? []) {
      byModule.set(feature.module, [...(byModule.get(feature.module) ?? []), feature]);
    }
    return [...byModule.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data?.features]);

  const toggle = (set: Set<string>, code: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    apply(next);
  };

  const dirty = !!selected && (
    scope !== selected.scope
    || [...pageCodes].sort().join() !== [...selected.page_codes].sort().join()
    || [...featureCodes].sort().join() !== [...selected.permission_codes].sort().join()
  );

  if (error) return <ErrorBanner error={error} />;

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="RBAC" title="Job Profiles" />
      <p className="-mt-2 text-sm text-muted">
        {data
          ? `${data.total} real jobs derived from ${data.position_total} HCM positions. `
            + "Granting here replaces the position's HCM role."
          : "Deriving jobs from HCM positions…"}
      </p>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* ------------------------------ profiles ------------------------------ */}
        <Card className="p-0 overflow-hidden">
          <div className="p-3 border-b border-default-200 space-y-2">
            <Input
              aria-label="Search job profiles"
              placeholder="Search job, project, HCM role, position…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              ariaLabel="Project"
              value={project}
              onChange={setProject}
              placeholder="All projects"
              // Explicit "All projects" row: the placeholder only shows while nothing
              // is picked, so without it there is no way back out of a project.
              options={[
                { value: "", label: `All projects (${profiles.length})` },
                ...(data?.projects ?? []).map(([id, name]) => ({
                  value: String(id),
                  label: `${name} (${perProject.get(id) ?? 0})`,
                })),
              ]}
            />
          </div>
          <ScrollBox className="max-h-[70vh]">
            {isLoading && <div className="p-4 text-sm text-default-500">Loading…</div>}
            {!isLoading && !filtered.length && (
              <EmptyState title="No job profile matches that" />
            )}
            <ul>
              {filtered.map((profile) => (
                <li key={profile.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(profile.key)}
                    className={`w-full text-left px-4 py-3 min-h-[44px] border-l-2 transition
                      ${profile.key === selectedKey
                        ? "border-primary bg-primary-50/60"
                        : "border-transparent hover:bg-default-100"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm truncate">{profile.name}</span>
                      {profile.is_default
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary-100
                                           text-primary-700 whitespace-nowrap">
                            {profile.configured ? "DEFAULT" : "NOT SET"}
                          </span>
                        : profile.configured
                          ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-100
                                             text-success-700 whitespace-nowrap">LIVE</span>
                          : <span className="text-[10px] px-1.5 py-0.5 rounded bg-default-200
                                             text-default-600 whitespace-nowrap">HCM ROLE</span>}
                    </div>
                    {/* The project is half the profile's identity, not a detail:
                     *  "4:DEO" and "6:DEO" are two grant units, and the name alone
                     *  cannot tell them apart. Always shown, never truncated away. */}
                    <div className="text-[11px] text-primary-600 truncate">
                      {profile.project_name}
                    </div>
                    {profile.is_default ? (
                      <div className="text-xs text-default-500 mt-0.5">
                        Used by any job here nobody has configured
                      </div>
                    ) : (
                      <>
                        <div className="text-xs text-default-500 mt-0.5 truncate">
                          {profile.holder_count} people · {profile.position_count} positions
                        </div>
                        <div className="text-[11px] text-default-400 truncate">
                          was: {profile.hcm_roles.join(", ") || "—"}
                        </div>
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollBox>
        </Card>

        {/* ------------------------------- matrix ------------------------------- */}
        <div className="space-y-4">
          {!selected && <Card className="p-6"><EmptyState title="Pick a job profile" /></Card>}

          {selected && (
            <>
              <Card className="p-4 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-primary" />
                      <h2 className="text-lg font-semibold">{selected.name}</h2>
                      <code className="text-xs text-default-500">{selected.key}</code>
                    </div>
                    {selected.is_default ? (
                      <>
                        <p className="text-sm text-default-500 mt-1">
                          <span className="font-medium text-primary-600">
                            {selected.project_name}
                          </span>
                          {" · "}the starting point for any job here that nobody has
                          configured
                        </p>
                        <p className="text-xs text-default-400 mt-0.5">
                          {selected.configured
                            ? "New and unconfigured jobs see this instead of their HCM role."
                            : "Not set — unconfigured jobs still fall through to their "
                              + "HCM role. Save once to take over."}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-default-500 mt-1">
                          <span className="font-medium text-primary-600">
                            {selected.project_name}
                          </span>
                          {" · "}
                          {selected.holder_count} people across {selected.position_count}{" "}
                          position{selected.position_count === 1 ? "" : "s"}
                          {selected.hcm_roles.length
                            ? ` · currently inside HCM role ${selected.hcm_roles.join(", ")}`
                            : ""}
                        </p>
                        {/* Saving grants this job in THIS project only. Worth saying
                         *  out loud: the list shows one row per project, so the same
                         *  job name can appear more than once, granted separately. */}
                        <p className="text-xs text-default-400 mt-0.5">
                          Grants apply to {selected.job} in {selected.project_name} only.
                        </p>
                      </>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="subtle" onClick={() => setShowHolders((v) => !v)}>
                      <Users className="w-4 h-4" /> Who is this?
                    </Button>
                    {selected.configured && (
                      <Button
                        variant="danger"
                        disabled={reset.isPending}
                        onClick={() => reset.mutate()}
                      >
                        <RotateCcw className="w-4 h-4" /> Hand back to HCM role
                      </Button>
                    )}
                    <Button
                      disabled={!dirty || save.isPending}
                      onClick={() => save.mutate()}
                    >
                      <Check className="w-4 h-4" /> Save
                    </Button>
                  </div>
                </div>

                {!selected.configured && (
                  <div className="flex gap-2 text-sm rounded-lg bg-warning-50 text-warning-800 p-3">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      Not live yet. These {selected.holder_count} people still get whatever
                      HCM role <b>{selected.hcm_roles.join(", ") || "—"}</b> grants — shared
                      with every other job in that role. Saving once takes them off it.
                    </span>
                  </div>
                )}

                {!pageCodes.size && (
                  <div className="rounded-lg bg-default-100 p-3 text-sm text-default-600">
                    No pages ticked — these {selected.holder_count} people will see the
                    Home screen and nothing else once you save.
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Data scope" hint={SCOPE_HELP[scope]}>
                    <Select
                      ariaLabel="Data scope"
                      value={scope}
                      onChange={(value) => setScope(value as ScopeRung)}
                      options={(data?.scopes ?? []).map((rung) => ({
                        value: rung, label: SCOPE_LABEL[rung],
                      }))}
                    />
                  </Field>
                  <div className="text-xs text-default-500 self-end pb-2">
                    HCM suggests <b>{SCOPE_LABEL[selected.suggested_scope]}</b> from{" "}
                    {selected.office_levels.join(", ") || "no office level"}.
                    <br />
                    Scope is recorded now; list filtering lands with the scope filter.
                  </div>
                </div>

                {showHolders && (
                  <ScrollBox className="max-h-56 border border-default-200 rounded-lg">
                    {holders.isLoading && <div className="p-3 text-sm">Loading…</div>}
                    <ul className="divide-y divide-default-100">
                      {(holders.data?.items ?? []).map((h) => (
                        <li key={`${h.employee_id}-${h.position_name}`}
                            className="px-3 py-2 text-sm flex justify-between gap-3">
                          <span className="truncate">{h.name}
                            <span className="text-default-400"> · {h.emp_code}</span></span>
                          <span className="text-default-500 truncate text-right">
                            {h.position_name}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {!holders.isLoading && !holders.data?.items.length && (
                      <div className="p-3 text-sm text-default-500">
                        No active holders — the positions exist but nobody is in them.
                      </div>
                    )}
                  </ScrollBox>
                )}
              </Card>

              <Card className="p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="font-semibold">Pages</h3>
                  <div className="flex gap-2">
                    <Button variant="subtle" onClick={() => setPageCodes(new Set(
                      (data?.pages ?? []).filter((p) => !p.always_on).map((p) => p.code),
                    ))}>Select all</Button>
                    {/* Clear all leaves Home, which has no required_permission — this is
                     *  how you make someone who only needs to log in see nothing else. */}
                    <Button variant="subtle" onClick={() => setPageCodes(new Set())}>
                      Clear all
                    </Button>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {groups.map((group) => (
                    <div key={group.name}>
                      <div className="text-xs font-semibold uppercase text-default-500 mb-1">
                        {group.name}
                      </div>
                      <ul className="space-y-1">
                        {group.pages.map((page) => (
                          <li key={page.code}>
                            <label className="flex items-center gap-2 min-h-[32px] text-sm
                                              cursor-pointer">
                              <input
                                type="checkbox"
                                className="w-4 h-4"
                                disabled={page.always_on}
                                checked={page.always_on || pageCodes.has(page.code)}
                                onChange={() =>
                                  toggle(pageCodes, page.code, setPageCodes)}
                              />
                              <span className={page.always_on ? "text-default-400" : ""}>
                                {page.name}
                                {page.always_on && " (always on)"}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="font-semibold">Actions</h3>
                  <Button variant="subtle" onClick={() => setFeatureCodes(new Set())}>
                    Clear all
                  </Button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {featureModules.map(([module, features]) => (
                    <div key={module}>
                      <div className="text-xs font-semibold uppercase text-default-500 mb-1">
                        {module}
                      </div>
                      <ul className="space-y-1">
                        {features.map((feature) => (
                          <li key={feature.code}>
                            <label className="flex items-start gap-2 min-h-[32px] text-sm
                                              cursor-pointer">
                              <input
                                type="checkbox"
                                className="w-4 h-4 mt-0.5"
                                checked={featureCodes.has(feature.code)}
                                onChange={() =>
                                  toggle(featureCodes, feature.code, setFeatureCodes)}
                              />
                              <span>{feature.description}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
