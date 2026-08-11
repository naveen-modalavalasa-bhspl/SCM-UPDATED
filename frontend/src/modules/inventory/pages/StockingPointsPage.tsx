import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, MapPin, Star, Trash2 } from "lucide-react";
import {
  Button, Card, PageHeader, ResponsiveList, Select, StatCard, StatusPill, type Column,
} from "@/shared/components";
import {
  listStockingPointTags, tagStockingPoint, untagStockingPoint, classifyMove,
  getWarehouses, searchPositions,
} from "../api";
import type { PositionLocationTag, PositionSearchHit } from "../types";

/** Tier colouring, so the chain reads at a glance rather than by reading numbers. */
const TIER_TONE: Record<number, string> = {
  1: "bg-brand-050 text-brand-700",
  2: "bg-warn/10 text-warn",
  3: "bg-success/10 text-success",
};

function TierBadge({ tier, label }: { tier: number; label: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${TIER_TONE[tier] ?? "bg-content2 text-muted"}`}>
      {label}
    </span>
  );
}

/** Which stocking points each position draws from.
 *
 *  This is the one place the MDP/LIP chain is declared. Everything downstream — who
 *  sees whose stock, whether a move is an issue or a transfer, whether the Inventory
 *  Manager has to approve it — is computed from these rows, so a wrong tag here is
 *  felt everywhere. The tier itself is NOT set here: it comes from the warehouse's
 *  own type, so a point cannot be an MDP on one tag and a LIP on another.
 */
export function StockingPointsPage() {
  const queryClient = useQueryClient();
  const [positionId, setPositionId] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [picked, setPicked] = useState<PositionSearchHit | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);

  // Only asks once there are two characters to go on — a one-letter search returns
  // half the org and is slower than typing the rest.
  const positionHits = useQuery({
    queryKey: ["inventory", "position-search", personQuery],
    queryFn: () => searchPositions(personQuery),
    enabled: personQuery.trim().length >= 2 && !picked,
  });
  const hits = positionHits.data ?? [];

  // Typed filters. Held apart from what is SENT (`applied` below) so a keystroke
  // does not fire a request per letter across a 2,000-row tagging.
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [page, setPage] = useState(1);
  const [applied, setApplied] = useState("");
  const SIZE = 25;

  useEffect(() => {
    const timer = setTimeout(() => { setApplied(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const tags = useQuery({
    queryKey: ["inventory", "stocking-points", "tags",
               applied, tierFilter, projectFilter, page],
    queryFn: () => listStockingPointTags({
      search: applied || undefined,
      tier: tierFilter ? (Number(tierFilter) as PositionLocationTag["tier"]) : undefined,
      project_id: projectFilter ? Number(projectFilter) : undefined,
      page, size: SIZE,
    }),
    // Keeps the rows on screen while the next page loads, so filtering does not
    // flash an empty table between every keystroke.
    placeholderData: (previous) => previous,
  });
  const warehouses = useQuery({
    queryKey: ["inventory", "warehouses"],
    queryFn: () => getWarehouses(),
  });

  const save = useMutation({
    mutationFn: () => tagStockingPoint({
      position_id: Number(positionId),
      warehouse_id: Number(warehouseId),
      project_id: projectId ? Number(projectId) : 0,
      project_name: projectName || null,
      is_primary: isPrimary,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["inventory", "stocking-points"] });
      setPositionId(""); setWarehouseId(""); setProjectId(""); setProjectName("");
      setPersonQuery(""); setPicked(null);
      setIsPrimary(false);
    },
  });

  const remove = useMutation({
    mutationFn: (tagId: number) => untagStockingPoint(tagId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inventory", "stocking-points"] }),
  });

  const rows = tags.data?.items ?? [];
  const total = tags.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / SIZE));
  // Counted by the server over the whole filtered, scoped set. Counting the rows in
  // hand was the bug behind "Warehouses 0": the cards described one page, and no page
  // holds a warehouse tag when 2,001 MDP and LIP tags sort ahead of it.
  const byTier = useMemo(() => {
    const counts = tags.data?.tier_counts ?? {};
    return { warehouses: counts["1"] ?? 0, mdps: counts["2"] ?? 0, lips: counts["3"] ?? 0 };
  }, [tags.data]);

  // Projects come from the rows themselves — the tagging is where a project is
  // captured, so there is no separate list to keep in step.
  const projectOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const row of rows) {
      if (row.project_id) seen.set(row.project_id, row.project_name ?? String(row.project_id));
    }
    return [...seen].map(([value, label]) => ({ value: String(value), label }));
  }, [rows]);

  const columns: Column<PositionLocationTag>[] = [
    {
      key: "position",
      header: "Position",
      render: (row) => <div>
        <strong className="text-ink">{row.position_name ?? `Position ${row.position_id}`}</strong>
        {row.is_primary && <p className="flex items-center gap-1 text-xs text-muted">
          <Star className="h-3 w-3" /> issues from here by default
        </p>}
      </div>,
    },
    {
      key: "point",
      header: "Stocking point",
      render: (row) => <div>
        <strong className="text-ink">{row.warehouse_name ?? `#${row.warehouse_id}`}</strong>
        <p className="font-mono text-xs text-muted">{row.warehouse_code ?? "—"}</p>
      </div>,
    },
    { key: "tier", header: "Tier", render: (row) => <TierBadge tier={row.tier} label={row.tier_label} /> },
    {
      key: "project",
      header: "Project",
      hideOnNarrow: true,
      render: (row) => row.project_name ?? (row.project_id ? String(row.project_id) : "—"),
    },
    {
      key: "action",
      header: "",
      render: (row) => <Button
        variant="ghost"
        disabled={remove.isPending}
        onClick={() => remove.mutate(row.id)}
      >
        <Trash2 className="h-4 w-4" /> Remove
      </Button>,
    },
  ];

  const field = "min-h-11 w-full rounded-xl border border-line bg-content1 px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-brand-500";

  return <>
    <PageHeader eyebrow="Inventory" title="Stocking points" />
    <p className="mb-4 text-sm text-body">
      Which points each position draws from. A position can hold several — one OE
      covering two MDPs is normal. The tier comes from the warehouse's own type, so it
      is set once on the warehouse and never contradicted here. Everything else reads
      these rows: who sees whose stock, and whether a move is an issue, a transfer or
      a bin change.
    </p>

    <div className="mb-2 grid grid-cols-3 gap-3">
      <StatCard label="Warehouses" value={byTier.warehouses} icon={<Building2 className="h-4 w-4" />} />
      <StatCard label="MDPs" value={byTier.mdps} icon={<MapPin className="h-4 w-4" />} />
      <StatCard label="LIPs" value={byTier.lips} icon={<MapPin className="h-4 w-4" />} />
    </div>
    {/* A zero here is a real state, not a loading one, and it is worth naming: the
        screen lists TAGGINGS, so a warehouse nobody is tagged to is not on it. Said
        plainly, because the alternative is reading the card as a missing warehouse. */}
    {!tags.isLoading && byTier.warehouses === 0 && (
      <p className="mb-4 rounded-xl bg-content2 px-4 py-3 text-sm text-body">
        No position is tagged to a top-tier warehouse yet, so none appears below —
        this screen lists taggings, not warehouses. Tag someone to the central
        warehouse above and it will show up here and in their stock screens.
      </p>
    )}

    <Card className="mb-4 p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Tag a position</p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
        {/* A person, not a number. The field used to want hcm_positions.id, which
            meant looking the id up in the database before anyone could tag anybody —
            so in practice nobody did, and field staff went untagged. */}
        <label className="relative block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Position</span>
          <input
            className={field}
            aria-label="Search person, employee code or position"
            placeholder="Name, HR-EMP-… or post"
            value={personQuery}
            onChange={(e) => {
              // Typing again means "I want a different person", so the previous
              // choice is dropped and the list is allowed to reopen.
              setPersonQuery(e.target.value);
              setPositionId("");
              setPicked(null);
            }}
          />
          {picked && <span className="mt-1 block text-xs text-success">
            {picked.position_name}
            {picked.tagged_to ? ` · already at ${picked.tagged_to}` : ""}
          </span>}
          {!picked && hits.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-line bg-content1 shadow-lg">
              {hits.map((hit) => (
                <li key={hit.position_id}>
                  <button
                    type="button"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-content2"
                    onClick={() => {
                      setPositionId(String(hit.position_id));
                      setPicked(hit);
                      setPersonQuery(hit.employee_name ?? hit.position_name);
                    }}
                  >
                    <strong className="text-ink">{hit.employee_name ?? "Vacant post"}</strong>
                    {hit.employee_code ? <span className="text-muted"> · {hit.employee_code}</span> : null}
                    <span className="block text-xs text-muted">{hit.position_name}</span>
                    {hit.tagged_to && <span className="block text-xs text-warn">
                      already tagged to {hit.tagged_to}
                    </span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </label>
        <Select
          label="Stocking point"
          placeholder="Pick a warehouse"
          value={warehouseId}
          onChange={setWarehouseId}
          options={(warehouses.data ?? []).map((w: any) => ({
            value: String(w.id),
            label: `${w.name}${w.warehouse_type ? ` · ${w.warehouse_type}` : ""}`,
          }))}
        />
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Project id</span>
          <input
            className={field}
            type="number"
            aria-label="Project id"
            placeholder="0 = unassigned"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Project name</span>
          <input
            className={field}
            aria-label="Project name"
            placeholder="Snapshot, for display"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
          />
        </label>
        <div className="flex items-end gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm text-body">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
            />
            Primary
          </label>
          <Button
            disabled={!positionId || !warehouseId || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Tag"}
          </Button>
        </div>
      </div>
      {save.error && <p className="mt-3 rounded-xl bg-danger/10 p-3 text-sm text-danger">
        {(save.error as Error).message}
      </p>}
      <p className="mt-3 text-xs text-muted">
        Project is snapshotted on the tag because a stocking point has no project of its
        own. It is what decides whether a transfer crosses a boundary and needs the
        Inventory Manager.
      </p>
    </Card>

    {/* Find a tagging. Everything here narrows on the server, on top of the scope
        this login already has — a filter can only ever show LESS than the rung does,
        never more, so clearing one cannot reveal another project's tagging. */}
    <Card className="mb-4 p-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <label className="block lg:col-span-2">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">Search</span>
          <input
            className={field}
            aria-label="Search stocking point tags"
            placeholder="Position, point name, code or project…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Select
          label="Tier"
          placeholder="Any tier"
          value={tierFilter}
          onChange={(next) => { setTierFilter(next); setPage(1); }}
          options={[
            { value: "1", label: "Warehouse" },
            { value: "2", label: "MDP" },
            { value: "3", label: "LIP" },
          ]}
        />
        <Select
          label="Project"
          placeholder="Any project"
          value={projectFilter}
          onChange={(next) => { setProjectFilter(next); setPage(1); }}
          options={projectOptions}
        />
      </div>
      {(applied || tierFilter || projectFilter) && (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-xs text-muted">
            {total} {total === 1 ? "tag" : "tags"} match
          </span>
          <Button
            variant="ghost"
            onClick={() => {
              setSearch(""); setTierFilter(""); setProjectFilter(""); setPage(1);
            }}
          >
            Clear
          </Button>
        </div>
      )}
    </Card>

    <ResponsiveList
      data={rows}
      columns={columns}
      keyOf={(row) => row.id}
      loading={tags.isLoading}
      empty={applied || tierFilter || projectFilter
        ? "No tagging matches those filters."
        : "No positions are tagged to a stocking point yet."}
      renderCard={(row) => <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <strong className="text-ink">{row.position_name ?? `Position ${row.position_id}`}</strong>
          <TierBadge tier={row.tier} label={row.tier_label} />
        </div>
        <p className="text-sm text-body">{row.warehouse_name ?? `#${row.warehouse_id}`}</p>
        <p className="text-xs text-muted">{row.project_name ?? "No project"}</p>
        <Button variant="ghost" onClick={() => remove.mutate(row.id)}>
          <Trash2 className="h-4 w-4" /> Remove
        </Button>
      </div>}
    />

    {pages > 1 && (
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-sm text-muted">
          Page {page} of {pages} · {total} tags
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={page <= 1 || tags.isFetching}
            onClick={() => setPage((n) => Math.max(1, n - 1))}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            disabled={page >= pages || tags.isFetching}
            onClick={() => setPage((n) => Math.min(pages, n + 1))}
          >
            Next
          </Button>
        </div>
      </div>
    )}
  </>;
}

/** Read-only strip showing what a from/to pair resolves to.
 *
 *  Exported so the transfer and issue forms can drop it straight in: the user picks
 *  the two points and a reason, and this states the consequence. Deriving the kind
 *  rather than asking for it is what stops "pick Movement" being a way to skip the
 *  Inventory Manager on a cross-project transfer.
 */
export function MovementKindStrip({ fromWarehouseId, toWarehouseId }: {
  fromWarehouseId?: number | null;
  toWarehouseId?: number | null;
}) {
  const query = useQuery({
    queryKey: ["inventory", "classify", fromWarehouseId, toWarehouseId],
    queryFn: () => classifyMove(fromWarehouseId, toWarehouseId),
    enabled: Boolean(fromWarehouseId && toWarehouseId),
  });
  if (!fromWarehouseId || !toWarehouseId || !query.data) return null;

  const { movement_kind, needs_inventory_manager, explanation } = query.data;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-line/70 bg-content2 p-3">
      <StatusPill status={movement_kind} />
      <span className="text-sm text-body">{explanation}</span>
      {needs_inventory_manager && <StatusPill status="NEEDS INVENTORY MANAGER" />}
    </div>
  );
}
