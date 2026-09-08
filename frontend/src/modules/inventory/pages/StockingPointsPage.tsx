import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Boxes, Building2, Layers, MapPin, Plus, Star, Trash2, X } from "lucide-react";
import {
  Button, Card, KpiTiles, PageHeader, ResponsiveList, Select, StatusPill,
  type Column, type KpiTileSpec,
} from "@/shared/components";
import {
  listStockingPointTags, tagStockingPoint, untagStockingPoint, classifyMove,
  getWarehouses, searchPositions,
  listWarehouseFloors, listFloorAccess, grantFloorAccess, revokeFloorAccess,
} from "../api";
import type { PositionLocationTag, PositionSearchHit } from "../types";
import { DetailSheet } from "../components/DetailSheet";

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
/** Whole numbers where the stock is whole, otherwise three places — the same way the
 *  stock screens render a quantity, so the two never look like different figures. */
const qty = (value: number) => value.toLocaleString(undefined, {
  maximumFractionDigits: 3,
});

export function StockingPointsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [positionId, setPositionId] = useState("");
  const [personQuery, setPersonQuery] = useState("");
  const [picked, setPicked] = useState<PositionSearchHit | null>(null);
  const [warehouseId, setWarehouseId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [floorRow, setFloorRow] = useState<PositionLocationTag | null>(null);
  const [extraFloorId, setExtraFloorId] = useState("");

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

  const floors = useQuery({
    queryKey: ["warehouse", "floors", floorRow?.warehouse_id],
    queryFn: () => listWarehouseFloors(floorRow!.warehouse_id),
    enabled: Boolean(floorRow),
  });
  const floorAccess = useQuery({
    queryKey: ["inventory", "floor-access", floorRow?.position_id],
    queryFn: () => listFloorAccess(floorRow!.position_id),
    enabled: Boolean(floorRow),
  });
  const grantFloor = useMutation({
    mutationFn: () => grantFloorAccess(floorRow!.position_id, Number(extraFloorId)),
    onSuccess: () => {
      setExtraFloorId("");
      queryClient.invalidateQueries({ queryKey: ["inventory", "floor-access", floorRow?.position_id] });
    },
  });
  const revokeFloor = useMutation({
    mutationFn: revokeFloorAccess,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["inventory", "floor-access", floorRow?.position_id] }),
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
        {/* Who actually stands in the post. Without it the list answers with a post
            name and leaves the reader to work out whose stock they are looking at —
            which is the whole question this screen is opened to settle. */}
        {(row.holders ?? []).length > 0 && (
          <p className="truncate text-xs text-body">
            {(row.holders ?? []).map((h) => h.employee_name ?? h.employee_code).join(", ")}
            <span className="font-mono text-muted">
              {" "}· {(row.holders ?? []).map((h) => h.employee_code).filter(Boolean).join(", ")}
            </span>
          </p>
        )}
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
    {
      key: "stock",
      header: "Stock",
      // Clickable, because the number always raises the next question. Straight to
      // Stock Balance filtered to this point, rather than making the reader find the
      // screen and re-pick the warehouse out of a thousand-row dropdown.
      render: (row) => (row.stock_qty ?? 0) > 0
        ? <button
            type="button"
            className="text-left"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/inventory/stock-balance?warehouse_id=${row.warehouse_id}`);
            }}
          >
            <strong className="tabular text-ink underline decoration-line underline-offset-4">
              {qty(row.stock_qty ?? 0)}
            </strong>
            <span className="block text-xs text-muted">{row.stock_items ?? 0} items</span>
          </button>
        : <span className="text-sm text-muted">—</span>,
    },
    { key: "tier", header: "Tier", render: (row) => <TierBadge tier={row.tier} label={row.tier_label} /> },
    {
      key: "floor",
      header: "HCM section / floor",
      render: (row) => row.location_id
        ? <div><strong className="text-ink">{row.section_name ?? `Floor ${row.location_id}`}</strong><p className="text-xs text-success">Auto mapped</p></div>
        : <span className="text-sm text-muted">Warehouse-wide</span>,
    },
    {
      key: "project",
      header: "Project",
      hideOnNarrow: true,
      render: (row) => row.project_name ?? (row.project_id ? String(row.project_id) : "—"),
    },
    {
      key: "action",
      header: "",
      render: (row) => <div className="flex gap-1">
        <Button variant="ghost" onClick={() => { setFloorRow(row); setExtraFloorId(""); }}>
          <Layers className="h-4 w-4" /> Access
        </Button>
        <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(row.id)}>
          <Trash2 className="h-4 w-4" /> Remove
        </Button>
      </div>,
    },
  ];

  const field = "min-h-11 w-full rounded-xl border border-line/60 bg-content1 px-3 text-sm text-ink shadow-sm outline-none placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/25";

  return <>
    <PageHeader eyebrow="Inventory" title="Stocking points" />
    <p className="mb-4 text-sm text-muted">
      Who draws from which point. Tag a person to a point below; stock screens follow automatically.
    </p>

    {/* Counted by the server over the WHOLE filtered set. Search an employee code and
        these four become that person's answer: how many MDPs, how many LIPs, and what
        is sitting on them altogether. */}
    {/* The three tier tiles ARE the tier filter — pressing one narrows the list to
        that rung and pressing it again clears it. "Stock on hand" is a quantity, not a
        set of rows, so it takes no press: there is no list a total can open. */}
    <KpiTiles label="Stocking point tiers" className="mb-2" tiles={[
      ...([
        ["wh", "Warehouses", byTier.warehouses, Building2, "brand", "1"],
        ["mdp", "MDPs", byTier.mdps, MapPin, "warn", "2"],
        ["lip", "LIPs", byTier.lips, MapPin, "ok", "3"],
      ] as const).map(([key, label, value, icon, tone, tier]) => ({
        key, label, value, icon, tone,
        active: tierFilter === tier,
        onPress: () => { setTierFilter((on) => (on === tier ? "" : tier)); setPage(1); },
      })),
      // A quantity, not a set of rows — so no press. There is no list a total opens,
      // and a tile that looks pressable and does nothing is worse than a plain one.
      // The two figures that qualify it ride in the label, where the old card carried
      // them in a second line inside the value.
      {
        key: "qty",
        label: `Stock on hand · ${tags.data?.stock_items ?? 0} items · ${
          tags.data?.stock_points ?? 0} points stocked`,
        value: qty(tags.data?.stock_qty ?? 0), icon: Boxes, tone: "info",
      },
    ] satisfies KpiTileSpec[]} />
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

    {floorRow && <DetailSheet open onClose={() => setFloorRow(null)} title="Floor access" subtitle={floorRow.warehouse_name}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Floor access</p>
          <h3 className="text-base font-semibold text-ink">{floorRow.position_name}</h3>
          <p className="text-sm text-body">
            Default from HCM: {floorRow.section_name ?? "Not mapped"}. Extra access widens stock visibility and material issue rights without changing approvals.
          </p>
        </div>
        <Button variant="ghost" onClick={() => setFloorRow(null)}><X className="h-4 w-4" /> Close</Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
        <Select label="Add warehouse location" placeholder="Select floor, block or location" value={extraFloorId}
          onChange={setExtraFloorId}
          options={(floors.data ?? []).filter((floor) => floor.is_active !== false && floor.id !== floorRow.location_id
            && !(floorAccess.data ?? []).some((access) => access.location_id === floor.id)
            && (!floor.code.startsWith("HCM-") || /warehouse|floor|block/i.test(floor.name ?? "")))
            .map((floor) => {
              const path: string[] = [];
              const seen = new Set<number>();
              let node: typeof floor | undefined = floor;
              while (node && !seen.has(node.id)) {
                seen.add(node.id);
                path.unshift(`${node.name ?? node.code} (${node.code})`);
                node = (floors.data ?? []).find((parent) => parent.id === node?.parent_id);
              }
              return { value: String(floor.id), label: `${floorRow.warehouse_name} / ${path.join(" / ")}` };
            })} />
        <div className="flex items-end"><Button disabled={!extraFloorId || grantFloor.isPending} onClick={() => grantFloor.mutate()}>
          <Plus className="h-4 w-4" /> Grant access
        </Button></div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <span className="rounded-full bg-success/10 px-3 py-1 text-xs text-success">
          Default: {floorRow.location_id ? (floorRow.section_name ?? `Floor ${floorRow.location_id}`) : "Not mapped yet"}
        </span>
        {(floorAccess.data ?? []).map((access) => <span key={access.id} className="inline-flex items-center gap-1 rounded-full bg-brand-050 px-3 py-1 text-xs text-brand-700">
          {access.location_name ?? access.location_code ?? `Floor ${access.location_id}`}
          <button type="button" aria-label="Revoke floor access" onClick={() => revokeFloor.mutate(access.id)}><X className="h-3 w-3" /></button>
        </span>)}
      </div>
      {(floors.error || floorAccess.error || grantFloor.error || revokeFloor.error) && <p role="alert" className="mt-3 text-sm text-danger">
        {(floors.error || floorAccess.error || grantFloor.error || revokeFloor.error)?.message}
      </p>}
    </DetailSheet>}

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
            placeholder="HR-EMP-…, person, post, point or project"
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
        {(row.holders ?? []).length > 0 && <p className="text-xs text-body">
          {(row.holders ?? []).map((h) => h.employee_name ?? h.employee_code).join(", ")}
        </p>}
        <p className="text-sm text-body">{row.warehouse_name ?? `#${row.warehouse_id}`}</p>
        <p className="text-sm text-ink">
          {(row.stock_qty ?? 0) > 0
            ? <>{qty(row.stock_qty ?? 0)} <span className="text-muted">on hand · {row.stock_items ?? 0} items</span></>
            : <span className="text-muted">Nothing on hand</span>}
        </p>
        <p className="text-xs text-muted">{row.project_name ?? "No project"}</p>
        <Button variant="ghost" onClick={() => { setFloorRow(row); setExtraFloorId(""); }}>
          <Layers className="h-4 w-4" /> Access
        </Button>
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
