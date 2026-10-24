import { useMemo, useState } from "react";
import { AlertTriangle, Boxes } from "lucide-react";
import { PackChips, packable, usePackOptions } from "@/shared/packing";
import { RepackDialog } from "./RepackDialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip } from "@heroui/react";
import {
  Button, Can, ConfirmModal, ErrorBanner, Field, Input, ResponsiveList, StatusPill,
  SubNav, Textarea, TONE_BLUE, TONE_PINK, TONE_RED, type Column,
} from "@/shared/components";
import { useAuth } from "@/shared/auth/AuthContext";
import { FilterBar, FilterSelect } from "./FilterBar";
import { Lookup } from "./Lookup";
import {
  binOptions, createProjectHold, lendProjectHold, listProjectHolds, listProjectLots,
  listSerials, projectOptions, releaseProjectHold, warehouseOptions,
} from "../api";
import { fmtDate, fmtQty } from "../format";
import type { ProjectHold, ProjectLot } from "../types";

/**
 * Project Lots — set stock aside for one project.
 *
 * A hold takes the quantity out of `available_qty` (it is reserved for the project),
 * so the fulfilment desk and every issue picker stop offering it to anybody else on
 * their own. Only that project's indents and material issues see it again. Another
 * project's urgent need is served by LENDING the lot, which is its own permission and
 * always carries a reason. The rules live on the server
 * (`warehouse/project_holds.py`); this screen only asks.
 */

const VIEWS = [
  { key: "lots", label: "Lots" },
  { key: "holds", label: "Holds" },
];

const LOT_FILTERS = [
  { value: "free", label: "Has free stock" },
  { value: "held", label: "Held for a project" },
];

const HOLD_STATUSES = [
  { value: "ACTIVE", label: "Active" },
  { value: "USED", label: "Used by the project" },
  { value: "RELEASED", label: "Released" },
];

const num = (v: unknown) => Number(v ?? 0) || 0;

function lotLabel(r: { item_code?: string | null; item_name?: string | null }) {
  return [r.item_code, r.item_name].filter(Boolean).join(" · ");
}

function where(r: { bin_code?: string | null; batch_no?: string | null }) {
  return [r.batch_no ? `Batch ${r.batch_no}` : "No batch", r.bin_code ?? "bulk"].join(" · ");
}

export function ProjectLotsTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [view, setView] = useState("lots");
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState<number | "">("");
  const [lotFilter, setLotFilter] = useState("");
  const [holdStatus, setHoldStatus] = useState("ACTIVE");
  const [page, setPage] = useState(1);
  const [reserving, setReserving] = useState<ProjectLot | null>(null);
  const [releasing, setReleasing] = useState<{ hold: ProjectHold; lend: boolean } | null>(null);
  const [repacking, setRepacking] = useState<number | null>(null);

  const lots = useQuery({
    queryKey: ["project-lots", search, warehouseId, lotFilter, page],
    queryFn: () => listProjectLots({
      search: search || undefined, warehouse_id: warehouseId || undefined,
      held: (lotFilter || undefined) as "held" | "free" | undefined, page, size: 25,
    }),
    enabled: view === "lots",
  });
  const holds = useQuery({
    queryKey: ["project-holds", search, warehouseId, holdStatus, page],
    queryFn: () => listProjectHolds({
      search: search || undefined, warehouse_id: warehouseId || undefined,
      status: holdStatus || undefined, page, size: 25,
    }),
    enabled: view === "holds",
  });
  const packOptions = usePackOptions((lots.data?.items ?? []).map((r) => r.item_id),
                                     view === "lots");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["project-lots"] });
    qc.invalidateQueries({ queryKey: ["project-holds"] });
  };

  const lotColumns: Column<ProjectLot>[] = [
    {
      key: "lot_no", header: "Lot no.",
      render: (r) => <LotNos lots={r.lot_nos} />,
    },
    {
      key: "item", header: "Item",
      render: (r) => (
        <div className="max-w-[14rem] whitespace-normal [overflow-wrap:anywhere]">
          <div className="font-medium text-ink">{lotLabel(r)}</div>
          <div className="text-xs text-muted">{r.warehouse_name}</div>
        </div>
      ),
    },
    {
      key: "lot", header: "Batch · location",
      render: (r) => (
        <div className="max-w-[13rem] whitespace-normal [overflow-wrap:anywhere]">
          <div className="text-sm">{where(r)}</div>
          {r.expiry_date && <div className="text-xs text-muted">Expiry {fmtDate(r.expiry_date)}</div>}
          {/* The full path, folded in here (2026-10-12): as a column of its own it pushed
            * Packing and Repack off the screen on a 1440-wide display. */}
          {r.location_path && (
            <div className="mt-0.5 font-mono text-[11px] text-muted">{r.location_path}</div>
          )}
        </div>
      ),
    },
    {
      key: "bought", header: "Received for", hideOnNarrow: true,
      render: (r) => <span className="text-sm text-muted">{r.received_for_project ?? "—"}</span>,
    },
    {
      key: "qty", header: "On hand · free",
      render: (r) => (
        <div className="text-right">
          <div>{fmtQty(r.total_qty)} {r.uom_code}</div>
          <div className="text-xs text-muted">{fmtQty(r.available_qty)} free</div>
        </div>
      ),
    },
    {
      // How the quantity is bagged (2026-10-08), read off the packs on the shelf. A
      // part pack reads "1 Carton (350/500)"; one under its level's minimum is amber
      // and stays flagged until somebody repacks it (2026-10-11).
      key: "packing", header: "Packing",
      render: (r) => r.packs?.length ? (
        <div className="space-y-0.5">
          <PackChips entries={r.packs} uom={r.uom_code} showHierarchy={false} />
          <PackFlags lot={r} />
        </div>
      ) : <span className="text-sm text-muted">Loose</span>,
    },
    {
      key: "held", header: "Held for",
      render: (r) => r.holds.length ? (
        <div className="flex flex-wrap gap-1">
          {r.holds.map((h) => (
            <Chip key={h.id} size="sm" variant="flat" color="secondary">
              {h.project_name} · {fmtQty(h.quantity)}{h.serial_count ? ` (${h.serial_count} units)` : ""}
            </Chip>
          ))}
        </div>
      ) : <span className="text-sm text-muted">—</span>,
    },
    {
      key: "act", header: "",
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Can do="stock.repack">
            <RepackButton lot={r} packable={packable(packOptions.data?.[r.item_id]).length > 0}
                          loading={packOptions.isLoading} onRepack={() => setRepacking(r.stock_id)} />
          </Can>
          <Can do="stock.project_hold.manage">
            <Button className={TONE_BLUE} disabled={num(r.available_qty) <= 0}
                    title={num(r.available_qty) <= 0 ? "Nothing free on this lot to hold" : undefined}
                    onClick={() => setReserving(r)}>
              Reserve
            </Button>
          </Can>
        </div>
      ),
    },
  ];

  const holdColumns: Column<ProjectHold>[] = [
    {
      key: "no", header: "Hold",
      render: (h) => (
        <div>
          <div className="font-mono text-sm">{h.hold_no}</div>
          <div className="text-xs text-muted">{fmtDate(h.created_at)} · {h.created_by_name}</div>
        </div>
      ),
    },
    { key: "project", header: "Project", render: (h) => <span className="font-medium">{h.project_name}</span> },
    {
      key: "item", header: "Item · lot",
      render: (h) => (
        <div>
          <div>{lotLabel(h)}</div>
          <div className="text-xs text-muted">{h.warehouse_name} · {where(h)}</div>
        </div>
      ),
    },
    {
      key: "qty", header: "Held",
      render: (h) => (
        <div className="text-right">
          <div>{fmtQty(h.quantity)} <span className="text-xs text-muted">of {fmtQty(h.held_qty)}</span></div>
          {h.serial_numbers?.length ? <div className="text-xs text-muted">{h.serial_numbers.length} named units</div> : null}
        </div>
      ),
    },
    {
      key: "status", header: "Status",
      render: (h) => (
        <div>
          <StatusPill status={h.status} />
          {h.release_order_no && (
            <div className="mt-1 text-xs text-warning">
              Releasing {fmtQty(h.release_qty ?? 0)} to {h.release_destination} · {h.release_order_no}
              {h.pending_lend_project_name ? ` · for ${h.pending_lend_project_name}` : ""}
            </div>
          )}
          {h.released_for_project_name && (
            <div className="mt-1 text-xs text-muted">Lent to {h.released_for_project_name}</div>
          )}
        </div>
      ),
    },
    { key: "reason", header: "Reason", hideOnNarrow: true,
      render: (h) => <span className="text-xs text-muted">{h.release_reason ?? h.reason ?? "—"}</span> },
    {
      key: "act", header: "",
      render: (h) => h.status !== "ACTIVE" || h.release_order_no ? null : (
        <div className="flex justify-end gap-2">
          <Can do="stock.project_hold.manage">
            <Button className={TONE_RED} onClick={() => setReleasing({ hold: h, lend: false })}>Release</Button>
          </Can>
          <Can do="stock.project_hold.override">
            <Button className={TONE_PINK} onClick={() => setReleasing({ hold: h, lend: true })}>Lend</Button>
          </Can>
        </div>
      ),
    },
  ];

  const data = view === "lots" ? lots.data : holds.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.size || 25))) : 1;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-content1 p-4 text-sm text-body">
        A held lot is set aside for one project. Other projects' indents, the Fulfilment
        Desk and material issues no longer see it. Only that project's indents and
        material issues can draw it. <b>Release</b> and <b>Lend</b> raise a Stock Movement
        Order that moves the stock off the reserved lot to a location you pick. It goes
        through that order's approval and inspection, and the hold drops once it completes.
      </div>

      <SubNav label="Project lots" items={VIEWS} value={view} onChange={(v) => { setView(v); setPage(1); }} />

      <FilterBar
        search={search}
        onSearch={(v) => { setSearch(v); setPage(1); }}
        placeholder="Search lot no., item, batch, location or project…"
        onReset={() => { setSearch(""); setLotFilter(""); setHoldStatus("ACTIVE"); setWarehouseId(""); }}
      >
        <div className="min-w-56">
          <Lookup name="wh-options" load={warehouseOptions} value={warehouseId}
                  placeholder="Any warehouse" onChange={(id) => { setWarehouseId(id); setPage(1); }} />
        </div>
        {view === "lots" ? (
          <FilterSelect label="Show" allLabel="Every lot" value={lotFilter}
                        onChange={(v) => { setLotFilter(v); setPage(1); }} options={LOT_FILTERS} />
        ) : (
          <FilterSelect label="Status" allLabel="Any status" value={holdStatus}
                        onChange={(v) => { setHoldStatus(v); setPage(1); }} options={HOLD_STATUSES} />
        )}
      </FilterBar>

      <ErrorBanner error={view === "lots" ? lots.error : holds.error} />

      <div className="overflow-hidden rounded-xl border border-line/50 bg-content1 shadow-sm">
        {view === "lots" ? (
          <ResponsiveList
            data={lots.data?.items ?? []}
            columns={lotColumns}
            keyOf={(r) => r.stock_id}
            loading={lots.isLoading}
            empty="No lots match these filters."
            page={page} totalPages={totalPages} onPageChange={setPage}
            renderCard={(r) => (
              <div className="space-y-1 p-1">
                <LotNos lots={r.lot_nos} />
                <div className="font-medium">{lotLabel(r)}</div>
                <div className="text-xs text-muted">{r.warehouse_name} · {where(r)}</div>
                {r.location_path && <div className="font-mono text-xs text-body">{r.location_path}</div>}
                <div className="text-sm">{fmtQty(r.total_qty)} on hand · {fmtQty(r.available_qty)} free</div>
                {!!r.packs?.length && <PackChips entries={r.packs} uom={r.uom_code} showHierarchy={false} />}
                <PackFlags lot={r} />
                {r.holds.map((h) => (
                  <div key={h.id} className="text-xs text-secondary">Held for {h.project_name}: {fmtQty(h.quantity)}</div>
                ))}
                <div className="flex flex-wrap gap-2 pt-1">
                  {can("stock.repack") && (
                    <RepackButton lot={r} packable={packable(packOptions.data?.[r.item_id]).length > 0}
                                  loading={packOptions.isLoading} onRepack={() => setRepacking(r.stock_id)} />
                  )}
                  {can("stock.project_hold.manage") && num(r.available_qty) > 0 && (
                    <Button className={TONE_BLUE} onClick={() => setReserving(r)}>Reserve</Button>
                  )}
                </div>
              </div>
            )}
          />
        ) : (
          <ResponsiveList
            data={holds.data?.items ?? []}
            columns={holdColumns}
            keyOf={(h) => h.id}
            loading={holds.isLoading}
            empty="No holds match these filters."
            page={page} totalPages={totalPages} onPageChange={setPage}
            renderCard={(h) => (
              <div className="space-y-1 p-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm">{h.hold_no}</span>
                  <StatusPill status={h.status} />
                </div>
                <div className="font-medium">{h.project_name}</div>
                <div className="text-xs text-muted">{lotLabel(h)} · {where(h)}</div>
                <div className="text-sm">{fmtQty(h.quantity)} held of {fmtQty(h.held_qty)}</div>
                {h.release_order_no && (
                  <div className="text-xs text-warning">Releasing via {h.release_order_no}</div>
                )}
                {h.status === "ACTIVE" && !h.release_order_no && (
                  <div className="flex gap-2 pt-1">
                    <Can do="stock.project_hold.manage">
                      <Button className={TONE_RED} onClick={() => setReleasing({ hold: h, lend: false })}>Release</Button>
                    </Can>
                    <Can do="stock.project_hold.override">
                      <Button className={TONE_PINK} onClick={() => setReleasing({ hold: h, lend: true })}>Lend</Button>
                    </Can>
                  </div>
                )}
              </div>
            )}
          />
        )}
      </div>

      {repacking != null && (
        <RepackDialog stockId={repacking} onClose={() => setRepacking(null)}
                      onDone={() => { setRepacking(null); refresh(); }} />
      )}
      {reserving && (
        <ReserveDialog lot={reserving} onClose={() => setReserving(null)} onDone={() => { setReserving(null); refresh(); }} />
      )}
      {releasing && (
        <ReleaseDialog
          hold={releasing.hold}
          lend={releasing.lend}
          onClose={() => setReleasing(null)}
          onDone={() => { setReleasing(null); refresh(); }}
        />
      )}
    </div>
  );
}

/** What a lot's packs need saying about: packs under their minimum, and packs that
 *  claim more than the balance. Both are fixed by a repack. */
function PackFlags({ lot }: { lot: ProjectLot }) {
  return (
    <>
      {!!lot.pack_below_min && (
        <div className="flex items-center gap-1 text-[11px] font-medium text-warn">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {lot.pack_below_min} pack{lot.pack_below_min === 1 ? "" : "s"} below minimum — repack
        </div>
      )}
      {lot.pack_unreconciled && (
        <div className="text-[11px] text-warn">Packs exceed the balance — repack to tidy</div>
      )}
    </>
  );
}

/** Repack, on every lot holding stock (2026-10-11) — stock put away before packing
 *  existed is loose, and this is how it gets packed. Amber when a pack is under its
 *  minimum. An item with no pack levels says where to add them instead of hiding. */
/** Lots are segregated here, never repacked (2026-10-23): packs change only where
 *  the master says — putaway shelves in Storage containers, and the issue counter
 *  opens them when the item is issued in smaller ones. */
const REPACK_ON_LOTS = false;

function RepackButton({ lot, packable: hasLevels, loading, onRepack }: {
  lot: ProjectLot; packable: boolean; loading: boolean; onRepack: () => void;
}) {
  if (!REPACK_ON_LOTS || num(lot.total_qty) <= 0) return null;
  const urgent = !!lot.pack_below_min || lot.pack_unreconciled;
  const missing = !loading && !hasLevels;
  return (
    <Button variant="subtle" onClick={onRepack} disabled={missing}
            className={urgent ? "!bg-warn-bg !text-warn" : undefined}
            title={missing ? "This item has no pack levels — add them on the item master's Packaging tab first."
              : urgent ? "A pack here is under its minimum or out of step with the balance." : undefined}>
      {urgent ? <AlertTriangle className="h-4 w-4" /> : <Boxes className="h-4 w-4" />} Repack
    </Button>
  );
}

/** A row's lot numbers: the first in full, the rest on hover. */
function LotNos({ lots }: { lots: string[] }) {
  if (!lots.length) return <span className="text-sm text-muted">—</span>;
  return (
    <div className="max-w-[11rem] whitespace-normal font-mono text-xs text-ink [overflow-wrap:anywhere]"
         title={lots.join(", ")}>
      {lots[0]}
      {lots.length > 1 && <span className="ml-1 text-muted">+{lots.length - 1} more</span>}
    </div>
  );
}

/** The units of one lot that nothing is holding — what a hold may name. */
function UnitChooser({ lot, value, onChange, max, heldBy }: {
  lot: { item_id: number; warehouse_id: number; bin_id?: number | null; batch_id?: number | null };
  value: string[];
  onChange: (v: string[]) => void;
  max: number;
  heldBy?: string;
}) {
  const [search, setSearch] = useState("");
  const units = useQuery({
    queryKey: ["project-lot-units", lot.item_id, lot.warehouse_id, lot.bin_id, lot.batch_id, heldBy, search],
    queryFn: () => listSerials({
      item_id: lot.item_id, warehouse_id: lot.warehouse_id,
      bin_id: lot.bin_id ?? undefined, batch_id: lot.batch_id ?? undefined,
      unbatched: !lot.batch_id, status: heldBy ? undefined : "available",
      claim_free: !heldBy, search: heldBy ? undefined : search || undefined, size: 200,
    }),
  });
  const rows = useMemo(
    () => (units.data?.items ?? []).filter((u) => !heldBy || u.remarks === heldBy),
    [units.data, heldBy],
  );
  const toggle = (code: string) =>
    onChange(value.includes(code) ? value.filter((v) => v !== code)
      : value.length >= max ? value : [...value, code]);
  return (
    <div className="space-y-2">
      {!heldBy && <Input placeholder="Search a serial / IMEI / code" value={search}
                         onChange={(e) => setSearch(e.target.value)} />}
      <div className="max-h-48 overflow-auto rounded-lg border border-line p-2">
        {units.isLoading ? <div className="text-sm text-muted">Loading units…</div>
          : rows.length === 0 ? <div className="text-sm text-muted">No free units on this lot.</div>
          : rows.map((u) => {
            const code = u.serial_number;
            return (
              <label key={u.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={value.includes(code)} onChange={() => toggle(code)} />
                <span className="font-mono">{code}</span>
                {u.imei && <span className="text-xs text-muted">IMEI {u.imei}</span>}
                {(u.asset_code || u.consumable_code) && (
                  <span className="text-xs text-muted">{u.asset_code ?? u.consumable_code}</span>
                )}
              </label>
            );
          })}
      </div>
      <div className="text-xs text-muted">{value.length} of {max} named</div>
    </div>
  );
}

function ReserveDialog({ lot, onClose, onDone }: { lot: ProjectLot; onClose: () => void; onDone: () => void }) {
  const [projectId, setProjectId] = useState<number | "">("");
  const [qty, setQty] = useState(String(num(lot.available_qty)));
  const [reason, setReason] = useState("");
  const [units, setUnits] = useState<string[]>([]);
  const [byUnit, setByUnit] = useState(false);
  const save = useMutation({
    mutationFn: () => createProjectHold({
      stock_id: lot.stock_id, project_id: Number(projectId),
      quantity: byUnit ? units.length : Number(qty), serial_numbers: byUnit ? units : [],
      reason: reason.trim(),
    }),
    onSuccess: onDone,
  });
  const quantity = byUnit ? units.length : Number(qty);
  const invalid = !projectId || reason.trim().length < 3 || !(quantity > 0)
    || quantity > num(lot.available_qty);
  return (
    <ConfirmModal
      isOpen
      title={`Reserve ${lotLabel(lot)}`}
      message={`${lot.warehouse_name} · ${where(lot)} — ${fmtQty(lot.available_qty)} free to hold.`}
      confirmLabel="Reserve for project"
      busy={save.isPending}
      confirmDisabled={invalid}
      error={save.error}
      onConfirm={() => save.mutate()}
      onClose={onClose}
    >
      <div className="space-y-3">
        <Field label="Project" required>
          <Lookup name="project-options" load={projectOptions} value={projectId}
                  placeholder="Pick the project" onChange={(id) => setProjectId(id)} />
        </Field>
        {lot.is_unit_tracked && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={byUnit} onChange={(e) => setByUnit(e.target.checked)} />
            Name the exact units (serial / IMEI / code)
          </label>
        )}
        {byUnit ? (
          <UnitChooser lot={lot} value={units} onChange={setUnits} max={Math.trunc(num(lot.available_qty))} />
        ) : (
          <Field label="Quantity" required hint={`Up to ${fmtQty(lot.available_qty)} ${lot.uom_code ?? ""}`}>
            <Input type="number" min={0} max={num(lot.available_qty)} value={qty}
                   onChange={(e) => setQty(e.target.value)} />
          </Field>
        )}
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Bought on PO … for project 104 rollout" />
        </Field>
      </div>
    </ConfirmModal>
  );
}

function ReleaseDialog({ hold, lend, onClose, onDone }: {
  hold: ProjectHold;
  lend: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const full = hold;
  const named = full.serial_numbers?.length ?? 0;
  const [qty, setQty] = useState(String(num(hold.quantity)));
  const [reason, setReason] = useState("");
  const [projectId, setProjectId] = useState<number | "">("");
  const [destination, setDestination] = useState<number | "">("");
  const [units, setUnits] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const whole = Number(qty) === num(hold.quantity);
  // A movement names one unit per unit moved. A hold that names its units releases
  // them itself when released whole; otherwise the storekeeper picks which.
  const pickUnits = !!hold.is_unit_tracked && !(named > 0 && whole);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        quantity: Number(qty), reason: reason.trim(),
        serial_numbers: pickUnits ? units : [],
        for_project_id: lend ? Number(projectId) : null,
        destination_bin_id: Number(destination),
      };
      return lend ? lendProjectHold(hold.id, body) : releaseProjectHold(hold.id, body);
    },
    onSuccess: (result) => setDone(
      `${result.order_no ?? "Movement order"} raised — ${result.order_status === "COMPLETED"
        ? "completed, the stock has moved"
        : "waiting for its approval and inspection on Stock Movements"}.`),
  });
  const invalid = reason.trim().length < 3 || !(Number(qty) > 0) || Number(qty) > num(hold.quantity)
    || (lend && !projectId) || !destination
    || (pickUnits && units.length !== Number(qty));
  if (done) {
    return (
      <ConfirmModal isOpen title="Release raised" message={done} confirmLabel="Done"
                    onConfirm={onDone} onClose={onDone} />
    );
  }
  return (
    <ConfirmModal
      isOpen
      title={lend ? `Lend ${hold.hold_no} to another project` : `Release ${hold.hold_no}`}
      message={`Raises a Stock Movement Order moving the stock from ${hold.bin_code ?? "the held lot"} to the location you pick. ${lend
        ? `${hold.project_name} gives it up for another project's urgent need.`
        : "Once moved it is free for any project."}`}
      confirmLabel={lend ? "Raise lend movement" : "Raise release movement"}
      danger={!lend}
      busy={save.isPending}
      confirmDisabled={invalid}
      error={save.error}
      onConfirm={() => save.mutate()}
      onClose={onClose}
    >
      <div className="space-y-3">
        {lend && (
          <Field label="Lend to project" required>
            <Lookup name="project-options" load={projectOptions} value={projectId}
                    placeholder="The project with the urgent need" onChange={(id) => setProjectId(id)} />
          </Field>
        )}
        <Field label="Quantity" required hint={`${fmtQty(hold.quantity)} held`}>
          <Input type="number" min={0} max={num(hold.quantity)} value={qty}
                 onChange={(e) => { setQty(e.target.value); setUnits([]); }} />
        </Field>
        <Field label="Move to location" required hint="The released stock becomes a new lot there.">
          <Lookup
            name={`release-bins-${hold.warehouse_id}`}
            load={(search) => binOptions(hold.warehouse_id, search, null, null, null, true, hold.bin_id)}
            value={destination}
            placeholder="Pick a location in this warehouse"
            onChange={(id) => setDestination(id)}
          />
        </Field>
        {pickUnits && (
          <Field label="Units to move" required>
            <UnitChooser
              lot={full}
              value={units}
              onChange={setUnits}
              max={Math.trunc(Number(qty) || 0)}
              heldBy={named > 0 ? `Held for project ${full.project_id} by hold ${full.id}` : undefined}
            />
          </Field>
        )}
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder={lend ? "e.g. Critical indent IND0091 for project 207" : "e.g. Project 104 no longer needs it"} />
        </Field>
      </div>
    </ConfirmModal>
  );
}
