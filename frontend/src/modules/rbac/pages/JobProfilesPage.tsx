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
 *
 * LAYOUT: one card per module, named exactly as the left rail names it, holding
 * BOTH halves of the grant — the screens under that module and the actions inside
 * it. They used to be two separate matrices, so every module appeared twice under
 * two different spellings ("Purchasing" in one, "procurement" in the other) and the
 * module tick in one half could not reach the other. A half-granted module is the
 * shape of an access bug, so the two now move together, under one name.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, BarChart3, Boxes, Check, CheckCircle, ChevronRight, Database,
  FileText, Home, Package, RotateCcw, Settings as SettingsIcon, Shield,
  ShoppingCart, Truck, Undo2, Users,
} from "lucide-react";
import {
  Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select,
  ScrollBox, useToast,
} from "@/shared/components";
import { rbacApi } from "../api";
import type { JobProfileMatrix, ScopeRung } from "../types";

type MatrixPage = JobProfileMatrix["pages"][number];
type MatrixFeature = JobProfileMatrix["features"][number];

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

/** Compared on letters alone: the menu says "Warehouse", the permission catalogue
 *  says "warehouse". */
const letters = (value: string) => value.replace(/[^a-z]/gi, "").toLowerCase();

/** The two halves of a grant name three modules differently. The menu name wins —
 *  it is the word the admin sees everywhere else in the app — so the permission
 *  catalogue's spelling is translated into it before anything is grouped.
 *  Without this, ticking "Purchasing" granted its screens and none of its actions. */
const MODULE_ALIAS: Record<string, string> = {
  procurement: "purchasing",   // menu: Purchasing
  admin: "settings",           // menu: Settings
  indent: "indents",
  master: "masters",
  report: "reports",
  logistics: "warehouse",      // the endpoints moved; the screens are under Warehouse
};

const moduleKey = (name: string) => {
  const key = letters(name);
  return MODULE_ALIAS[key] ?? key;
};

const ICONS: Record<string, typeof Boxes> = {
  home: Home,
  indents: FileText,
  approvals: CheckCircle,
  purchasing: ShoppingCart,
  warehouse: Truck,
  inventory: Package,
  masters: Database,
  reports: BarChart3,
  rbac: Shield,
  settings: SettingsIcon,
};

/** One module = one card: the screens filed under it, and the actions inside it. */
export interface AccessSection {
  /** Exactly the name the module carries in the left rail. */
  name: string;
  pages: MatrixPage[];
  features: MatrixFeature[];
}

/**
 * Group the whole grant by module, in menu order.
 *
 * Pages come already sorted by the backend (`sort_order`), so pushing them in order
 * keeps every card and every row reading the way the rail does. Actions join the
 * card their module names; an action whose module has no screens at all still gets
 * a card of its own rather than silently disappearing.
 */
export function buildAccessSections(
  pages: MatrixPage[], features: MatrixFeature[],
): AccessSection[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const sections: AccessSection[] = [];
  const index = new Map<string, AccessSection>();

  const section = (name: string) => {
    const key = moduleKey(name);
    const found = index.get(key);
    if (found) return found;
    const created: AccessSection = { name, pages: [], features: [] };
    index.set(key, created);
    sections.push(created);
    return created;
  };

  for (const page of pages) {
    const parent = page.parent_id ? byId.get(page.parent_id) : undefined;
    section(parent ? parent.name : page.name).pages.push(page);
  }
  for (const feature of features) {
    const key = moduleKey(feature.module);
    const target = index.get(key)
      ?? section(feature.module.charAt(0).toUpperCase() + feature.module.slice(1));
    target.features.push(feature);
  }
  return sections;
}

/**
 * The one line under a module name that answers "what will they actually see?"
 * without opening the card — the screens, by the names they carry in the app.
 * A module granted actions but no screens says so: that combination is almost
 * always a mistake, and it is invisible otherwise.
 */
export function sectionSummary(granted: string[], actionsOn: number): string {
  if (granted.length) {
    const shown = granted.slice(0, 3).join(", ");
    return `Sees ${shown}${granted.length > 3 ? ` +${granted.length - 3} more` : ""}`;
  }
  if (actionsOn) return `${actionsOn} action${actionsOn === 1 ? "" : "s"}, no screens`;
  return "No access";
}

/** What ticking a page actually does, said plainly. Shown on hover, because "Put-away"
 *  tells an admin nothing about what the holder will be able to reach. */
const pageHint = (page: MatrixPage) =>
  page.always_on
    ? `${page.name} is always visible — every login can open it, and it cannot be `
      + "taken away here."
    : `Lets the holder open ${page.name} and see what is on it.`
      + (page.required_permission
         ? ` Grants "${page.required_permission}".`
         : " This screen has no permission of its own, so it is visible to anyone "
           + "who can reach the module.");

/** An action is a verb, not a screen: it decides whether the button works. */
const featureHint = (feature: MatrixFeature) =>
  `${feature.description}. Grants "${feature.code}" — the backend checks this on every `
  + "request, so it is the real permission, not just a visible button.";

/* --------------------------------------------------------------------------- *
 *  Small local controls. Nothing here restyles a shared primitive — they are
 *  compositions of tokens the kit does not carry a component for.
 * --------------------------------------------------------------------------- */

function Tick({
  checked, indeterminate, disabled, onChange, label, hint,
}: {
  checked: boolean; indeterminate?: boolean; disabled?: boolean;
  onChange: () => void; label: ReactNode; hint?: string;
}) {
  return (
    <label
      title={hint}
      className={`flex min-h-9 items-start gap-2.5 rounded-lg px-2 py-1.5 text-sm
        ${disabled ? "cursor-default" : "cursor-pointer hover:bg-brand-050/70"}`}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
        disabled={disabled}
        checked={checked}
        ref={(el) => { if (el) el.indeterminate = !!indeterminate && !checked; }}
        onChange={onChange}
      />
      <span className={disabled ? "text-muted" : "text-body"}>{label}</span>
    </label>
  );
}

function Badge({ tone, children }: { tone: "ok" | "brand" | "warn" | "muted";
                                     children: ReactNode }) {
  const TONE = {
    ok: "bg-ok-bg text-ok",
    brand: "bg-brand-050 text-brand",
    warn: "bg-warn-bg text-warn",
    muted: "bg-neutral-bg text-neutral",
  }[tone];
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px]
                      font-bold uppercase tracking-wide ${TONE}`}>
      {children}
    </span>
  );
}

/** Plain-text button for the small "all / none" links inside a card. */
function MiniButton({ onClick, children }: { onClick: () => void;
                                             children: ReactNode }) {
  return (
    <button type="button" onClick={onClick}
            className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-brand
                       hover:bg-brand-050">
      {children}
    </button>
  );
}

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
  const [status, setStatus] = useState<"all" | "live" | "hcm">("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pageCodes, setPageCodes] = useState<Set<string>>(new Set());
  const [featureCodes, setFeatureCodes] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<ScopeRung>("SELF");
  const [showHolders, setShowHolders] = useState(false);
  const [matrixSearch, setMatrixSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const profiles = data?.items ?? [];
  const selected = useMemo(
    () => profiles.find((p) => p.key === selectedKey) ?? null,
    [profiles, selectedKey],
  );

  /** Puts the draft back to what is saved — both on selecting a profile and on
   *  "Discard changes". */
  const loadDraft = () => {
    if (!selected) return;
    setPageCodes(new Set(selected.page_codes));
    setFeatureCodes(new Set(selected.permission_codes));
    setScope(selected.scope);
  };

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
    setOpen(new Set());
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
      if (status === "live" && !p.configured) return false;
      if (status === "hcm" && p.configured) return false;
      if (!needle) return true;
      return p.key.toLowerCase().includes(needle)
        || p.name.toLowerCase().includes(needle)
        || p.project_name.toLowerCase().includes(needle)
        || p.hcm_roles.some((r) => r.toLowerCase().includes(needle))
        || p.positions.some((pos) => pos.name.toLowerCase().includes(needle));
    });
  }, [profiles, search, project, status]);

  // Counted off the unfiltered list so the numbers stay put while you filter.
  const perProject = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of profiles) counts.set(p.project_id, (counts.get(p.project_id) ?? 0) + 1);
    return counts;
  }, [profiles]);

  const sections = useMemo(
    () => buildAccessSections(data?.pages ?? [], data?.features ?? []),
    [data?.pages, data?.features],
  );

  /** Typing in the matrix search narrows every card to the rows that match, and
   *  drops the cards left with nothing. */
  const visibleSections = useMemo(() => {
    const needle = matrixSearch.trim().toLowerCase();
    if (!needle) return sections;
    const hit = (text: string) => text.toLowerCase().includes(needle);
    return sections
      .map((section) => ({
        ...section,
        pages: hit(section.name)
          ? section.pages
          : section.pages.filter((p) => hit(p.name) || hit(p.code)),
        features: hit(section.name)
          ? section.features
          : section.features.filter((f) => hit(f.description) || hit(f.code)),
      }))
      .filter((section) => section.pages.length || section.features.length);
  }, [sections, matrixSearch]);

  const fullSections = useMemo(
    () => new Map(sections.map((section) => [section.name, section])),
    [sections],
  );

  const selectablePages = (section: AccessSection) =>
    section.pages.filter((page) => !page.always_on).map((page) => page.code);

  const sectionState = (section: AccessSection) => {
    const pages = selectablePages(section);
    const features = section.features.map((f) => f.code);
    const total = pages.length + features.length;
    const on = pages.filter((c) => pageCodes.has(c)).length
      + features.filter((c) => featureCodes.has(c)).length;
    return { total, on, all: total > 0 && on === total, some: on > 0 && on < total };
  };

  const apply = (current: Set<string>, codes: string[], on: boolean) => {
    const next = new Set(current);
    for (const code of codes) on ? next.add(code) : next.delete(code);
    return next;
  };

  /** One tick for a whole module: every screen under it AND every action in it. Two
   *  half-granted modules is the shape of an access bug, so they move together. */
  const setSection = (section: AccessSection, on: boolean) => {
    setPageCodes(apply(pageCodes, selectablePages(section), on));
    setFeatureCodes(apply(featureCodes, section.features.map((f) => f.code), on));
  };

  const toggle = (set: Set<string>, code: string, put: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    put(next);
  };

  const toggleOpen = (name: string) => {
    const next = new Set(open);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setOpen(next);
  };

  // A search is a request to see what matched — no point making the admin open ten
  // cards to find it.
  const isOpen = (name: string) => !!matrixSearch.trim() || open.has(name);

  const totals = useMemo(() => {
    const pages = (data?.pages ?? []).filter((p) => !p.always_on);
    return {
      pages: pages.length,
      pagesOn: pages.filter((p) => pageCodes.has(p.code)).length,
      features: data?.features.length ?? 0,
      featuresOn: featureCodes.size,
    };
  }, [data?.pages, data?.features, pageCodes, featureCodes]);

  const dirty = !!selected && (
    scope !== selected.scope
    || [...pageCodes].sort().join() !== [...selected.page_codes].sort().join()
    || [...featureCodes].sort().join() !== [...selected.permission_codes].sort().join()
  );

  if (error) return <ErrorBanner error={error} />;

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="RBAC"
        title="Job Profiles"
        actions={data && (
          <span className="text-sm text-muted">
            <b className="text-ink tabular">{data.total}</b> jobs from{" "}
            <b className="text-ink tabular">{data.position_total}</b> HCM positions
          </span>
        )}
      />
      <p className="-mt-3 text-sm text-muted">
        Pick a job on the left, then tick the screens and actions it should have.
        Saving here replaces whatever the position's HCM role was granting.
      </p>

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* ------------------------------ profiles ------------------------------ */}
        <Card className="overflow-hidden p-0">
          <div className="space-y-2.5 border-b border-line bg-content1 p-3">
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
            {/* Says what it filters on in the same words the rows are badged with,
             *  so picking one is never a guess about what it means. */}
            <div className="flex rounded-lg border border-line p-0.5">
              {([
                ["all", "All jobs"],
                ["live", "Set up here"],
                ["hcm", "On HCM role"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatus(value)}
                  className={`min-h-9 flex-1 rounded-md px-1 text-xs font-semibold
                    transition ${status === value
                      ? "bg-brand text-white"
                      : "text-muted hover:bg-brand-050 hover:text-brand"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-4 text-muted">
              <b className="text-ok">Set up here</b> — access comes from this screen.{" "}
              <b className="text-neutral">On HCM role</b> — nothing saved yet, so the
              old HCM role still decides.
            </p>
          </div>
          <ScrollBox className="max-h-[68vh] overflow-y-auto">
            {isLoading && <div className="p-4 text-sm text-muted">Loading…</div>}
            {!isLoading && !filtered.length && (
              <EmptyState title="No job profile matches that" />
            )}
            <ul className="divide-y divide-line">
              {filtered.map((profile) => (
                <li key={profile.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(profile.key)}
                    aria-current={profile.key === selectedKey}
                    className={`min-h-11 w-full border-l-[3px] px-3.5 py-2.5 text-left
                      transition ${profile.key === selectedKey
                        ? "border-brand bg-brand-050"
                        : "border-transparent hover:bg-surface"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-ink">
                        {profile.name}
                      </span>
                      {profile.is_default
                        ? <Badge tone={profile.configured ? "brand" : "warn"}>
                            {profile.configured ? "Default" : "Not set"}
                          </Badge>
                        : profile.configured
                          ? <Badge tone="ok">Set up</Badge>
                          : <Badge tone="muted">HCM role</Badge>}
                    </div>
                    {/* The project is half the profile's identity, not a detail:
                     *  "4:DEO" and "6:DEO" are two grant units, and the name alone
                     *  cannot tell them apart. Always shown, never truncated away. */}
                    <div className="truncate text-[11px] font-medium text-brand">
                      {profile.project_name}
                    </div>
                    {profile.is_default ? (
                      <div className="mt-0.5 text-xs text-muted">
                        Used by any job here nobody has configured
                      </div>
                    ) : (
                      <>
                        <div className="mt-0.5 truncate text-xs text-muted">
                          {profile.holder_count} people · {profile.position_count} positions
                        </div>
                        <div className="truncate text-[11px] text-muted/80">
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
              <Card className="space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-xl font-bold text-ink">
                        {selected.name}
                      </h2>
                      {selected.configured
                        ? <Badge tone="ok">Set up here</Badge>
                        : <Badge tone="muted">On HCM role</Badge>}
                      <code className="mono text-[11px] text-muted">{selected.key}</code>
                    </div>
                    {selected.is_default ? (
                      <>
                        <p className="mt-1 text-sm text-muted">
                          <span className="font-semibold text-brand">
                            {selected.project_name}
                          </span>
                          {" · "}the starting point for any job here that nobody has
                          configured
                        </p>
                        <p className="mt-0.5 text-xs text-muted">
                          {selected.configured
                            ? "New and unconfigured jobs see this instead of their HCM role."
                            : "Not set — unconfigured jobs still fall through to their "
                              + "HCM role. Save once to take over."}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="mt-1 text-sm text-muted">
                          <span className="font-semibold text-brand">
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
                        <p className="mt-0.5 text-xs text-muted">
                          Grants apply to {selected.job} in {selected.project_name} only.
                        </p>
                      </>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="subtle" onClick={() => setShowHolders((v) => !v)}>
                      <Users className="h-4 w-4" />
                      {showHolders ? "Hide people" : "Who is this?"}
                    </Button>
                    {selected.configured && (
                      <Button
                        variant="dangerSoft"
                        disabled={reset.isPending}
                        onClick={() => reset.mutate()}
                      >
                        <RotateCcw className="h-4 w-4" /> Hand back to HCM role
                      </Button>
                    )}
                    <Button
                      disabled={!dirty || save.isPending}
                      onClick={() => save.mutate()}
                    >
                      <Check className="h-4 w-4" /> Save
                    </Button>
                  </div>
                </div>

                {!selected.configured && (
                  <div className="flex gap-2 rounded-xl bg-warn-bg p-3 text-sm text-warn">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Not live yet. These {selected.holder_count} people still get whatever
                      HCM role <b>{selected.hcm_roles.join(", ") || "—"}</b> grants — shared
                      with every other job in that role. Saving once takes them off it.
                    </span>
                  </div>
                )}

                {!pageCodes.size && (
                  <div className="rounded-xl bg-neutral-bg p-3 text-sm text-body">
                    No screens ticked — these {selected.holder_count} people will see the
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
                  <div className="self-end pb-2 text-xs text-muted">
                    HCM suggests <b className="text-body">
                      {SCOPE_LABEL[selected.suggested_scope]}
                    </b> from {selected.office_levels.join(", ") || "no office level"}.
                    <br />
                    Scope is recorded now; list filtering lands with the scope filter.
                  </div>
                </div>

                {showHolders && (
                  <ScrollBox className="max-h-56 rounded-xl border border-line">
                    {holders.isLoading && <div className="p-3 text-sm">Loading…</div>}
                    <ul className="divide-y divide-line">
                      {(holders.data?.items ?? []).map((h) => (
                        <li key={`${h.employee_id}-${h.position_name}`}
                            className="flex justify-between gap-3 px-3 py-2 text-sm">
                          <span className="truncate text-body">{h.name}
                            <span className="text-muted"> · {h.emp_code}</span></span>
                          <span className="truncate text-right text-muted">
                            {h.position_name}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {!holders.isLoading && !holders.data?.items.length && (
                      <div className="p-3 text-sm text-muted">
                        No active holders — the positions exist but nobody is in them.
                      </div>
                    )}
                  </ScrollBox>
                )}
              </Card>

              {/* --------------------------- access cards --------------------------- */}
              <Card className="p-3 sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm text-muted">
                    <b className="text-ink tabular">{totals.pagesOn}</b> of {totals.pages}{" "}
                    screens · <b className="text-ink tabular">{totals.featuresOn}</b> of{" "}
                    {totals.features} actions
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-full sm:w-60">
                      <Input
                        aria-label="Find a screen or action"
                        placeholder="Find a screen or action…"
                        value={matrixSearch}
                        onChange={(e) => setMatrixSearch(e.target.value)}
                      />
                    </div>
                    <Button
                      variant="subtle"
                      onClick={() => setOpen(new Set(
                        open.size === sections.length ? [] : sections.map((s) => s.name),
                      ))}
                    >
                      {open.size === sections.length ? "Collapse all" : "Expand all"}
                    </Button>
                  </div>
                </div>

                <div className="mt-3 space-y-2">
                  {visibleSections.map((section) => {
                    // The card body shows what the search matched; its header always
                    // speaks for the whole module, or the tick would quietly mean
                    // "everything I can currently see".
                    const full = fullSections.get(section.name) ?? section;
                    const state = sectionState(full);
                    const granted = full.pages
                      .filter((p) => p.always_on || pageCodes.has(p.code))
                      .map((p) => p.name);
                    const Icon = ICONS[moduleKey(section.name)] ?? Boxes;
                    return (
                      <div
                        key={section.name}
                        className={`overflow-hidden rounded-xl border transition
                          ${state.on ? "border-brand/40 bg-brand-050/30" : "border-line"}`}
                      >
                        {/* Header: the module tick and the summary, both readable
                         *  without opening the card. */}
                        <div className="flex items-center gap-2 px-2 py-2 sm:px-3">
                          <input
                            type="checkbox"
                            aria-label={`Give this job the whole ${section.name} module`}
                            title={`Turn the whole ${section.name} module on or off — `
                              + "every screen under it and every action in it."}
                            className="h-4.5 w-4.5 shrink-0 accent-brand"
                            checked={state.all}
                            ref={(el) => {
                              if (el) el.indeterminate = state.some;
                            }}
                            onChange={() => setSection(section, !state.all)}
                          />
                          <button
                            type="button"
                            onClick={() => toggleOpen(section.name)}
                            aria-expanded={isOpen(section.name)}
                            className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5
                                       rounded-lg px-1 text-left"
                          >
                            <Icon className={`h-4.5 w-4.5 shrink-0
                              ${state.on ? "text-brand" : "text-muted"}`} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-bold text-ink">
                                {section.name}
                              </span>
                              <span className="block truncate text-xs text-muted">
                                {sectionSummary(
                                  granted,
                                  section.features
                                    .filter((f) => featureCodes.has(f.code)).length,
                                )}
                              </span>
                            </span>
                            <span className="shrink-0 tabular text-xs font-semibold text-muted">
                              {state.on}/{state.total}
                            </span>
                            <ChevronRight
                              className={`h-4 w-4 shrink-0 text-muted transition-transform
                                ${isOpen(section.name) ? "rotate-90" : ""}`}
                            />
                          </button>
                        </div>

                        {isOpen(section.name) && (
                          <div className="grid gap-4 border-t border-line bg-content1 px-2
                                          py-3 sm:px-3 md:grid-cols-2">
                            <div>
                              <div className="mb-1 flex items-center justify-between gap-2
                                              px-2">
                                <span className="text-[11px] font-bold uppercase
                                                 tracking-wider text-muted">
                                  Screens they can open
                                </span>
                                <span className="flex gap-1">
                                  <MiniButton onClick={() => setPageCodes(apply(
                                    pageCodes, selectablePages(section), true))}>
                                    All
                                  </MiniButton>
                                  <MiniButton onClick={() => setPageCodes(apply(
                                    pageCodes, selectablePages(section), false))}>
                                    None
                                  </MiniButton>
                                </span>
                              </div>
                              {!section.pages.length && (
                                <p className="px-2 text-xs text-muted">
                                  No screens of its own.
                                </p>
                              )}
                              {section.pages.map((page) => (
                                <Tick
                                  key={page.code}
                                  hint={pageHint(page)}
                                  disabled={page.always_on}
                                  checked={page.always_on || pageCodes.has(page.code)}
                                  onChange={() =>
                                    toggle(pageCodes, page.code, setPageCodes)}
                                  label={
                                    <>
                                      {page.name}
                                      {page.always_on && (
                                        <span className="ml-1.5 text-[11px] text-muted">
                                          (always on)
                                        </span>
                                      )}
                                    </>
                                  }
                                />
                              ))}
                            </div>

                            <div className="md:border-l md:border-line md:pl-3">
                              <div className="mb-1 flex items-center justify-between gap-2
                                              px-2">
                                <span className="text-[11px] font-bold uppercase
                                                 tracking-wider text-muted">
                                  What they can do
                                </span>
                                <span className="flex gap-1">
                                  <MiniButton onClick={() => setFeatureCodes(apply(
                                    featureCodes,
                                    section.features.map((f) => f.code), true))}>
                                    All
                                  </MiniButton>
                                  <MiniButton onClick={() => setFeatureCodes(apply(
                                    featureCodes,
                                    section.features.map((f) => f.code), false))}>
                                    None
                                  </MiniButton>
                                </span>
                              </div>
                              {!section.features.length && (
                                <p className="px-2 text-xs text-muted">
                                  Nothing to switch on beyond the screens.
                                </p>
                              )}
                              {section.features.map((feature) => (
                                <Tick
                                  key={feature.code}
                                  hint={featureHint(feature)}
                                  checked={featureCodes.has(feature.code)}
                                  onChange={() =>
                                    toggle(featureCodes, feature.code, setFeatureCodes)}
                                  label={feature.description}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {!visibleSections.length && (
                    <EmptyState title="Nothing matches that" />
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setPageCodes(new Set((data?.pages ?? [])
                        .filter((p) => !p.always_on).map((p) => p.code)));
                      setFeatureCodes(new Set((data?.features ?? []).map((f) => f.code)));
                    }}
                  >
                    Give everything
                  </Button>
                  {/* Clearing leaves Home, which has no required_permission — this is
                   *  how you make someone who only needs to log in see nothing else. */}
                  <Button
                    variant="ghost"
                    onClick={() => { setPageCodes(new Set()); setFeatureCodes(new Set()); }}
                  >
                    Take everything away
                  </Button>
                </div>
              </Card>

              {/* The list above runs long, so Save follows you down it. Cleared of the
               *  phone's bottom module bar. */}
              {dirty && (
                <div className="sticky bottom-19 z-10 md:bottom-4">
                  <div className="flex flex-wrap items-center justify-between gap-3
                                  rounded-xl border border-brand/40 bg-content1/95 px-3
                                  py-2.5 shadow-lg backdrop-blur">
                    <span className="text-sm font-semibold text-ink">
                      Unsaved changes to {selected.name}
                    </span>
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={loadDraft}>
                        <Undo2 className="h-4 w-4" /> Discard
                      </Button>
                      <Button disabled={save.isPending} onClick={() => save.mutate()}>
                        <Check className="h-4 w-4" /> Save changes
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
