import {
  Button, Card, ErrorBanner, Field, Input, PageHeader, Select,
} from "@/shared/components";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@heroui/react";
import { ArrowLeft } from "lucide-react";
import { Section } from "../../components/DocumentMeta";
import { flattenBins } from "../../components/BinTree";
import { createBin, getBinTree, listStorageTypes, locationVolumeBudget, updateBin } from "../../api";
import type { Bin, BinWrite, StorageType, VolumeBudget } from "../../types";
import {
  activeTypes, canStandAlone, defaultChildType, eligibleParents, isColdChain,
  parentTypesOf, typeOfLocation,
} from "../../storageTypes";

const cleanDraft = (draft: BinWrite): BinWrite => ({
  ...draft,
  name: draft.name?.trim() || null,
  description: draft.description?.trim() || null,
  barcode: draft.barcode?.trim() || null,
  floor_level: draft.floor_level ?? null,
  shelf_level: draft.shelf_level ?? null,
});

/** A bay inside a cold room is at the cold room's temperature until somebody says
 *  otherwise, so the band is inherited from the parent rather than typed again. The
 *  KIND is not inherited — that is the whole point of choosing one. */
const coldDefaultsFrom = (parent: Bin | null) => ({
  temperature_controlled: !!parent?.temperature_controlled,
  humidity_percentage: parent?.humidity_percentage ?? null,
  target_temperature_celsius: parent?.target_temperature_celsius ?? null,
  min_temperature_celsius: parent?.min_temperature_celsius ?? null,
  max_temperature_celsius: parent?.max_temperature_celsius ?? null,
});

function GateSummary({ draft }: { draft: BinWrite }) {
  const sides = [draft.length_cm, draft.width_cm, draft.height_cm].map(Number);
  const boxed = sides.every((n) => Number.isFinite(n) && n > 0);
  const stated = Number(draft.capacity_volume);
  const gross = Number.isFinite(stated) && stated > 0
    ? stated
    : boxed ? (sides[0] * sides[1] * sides[2]) / 1_000_000 : null;
  const share = Number(draft.fill_efficiency_pct);
  const derated = Number.isFinite(share) && share > 0 && share < 100;
  const usable = gross == null ? null : derated ? (gross * share) / 100 : gross;

  const gates: { label: string; on: boolean; says: string }[] = [
    { label: "Cube", on: usable != null,
      says: usable == null
        ? "no volume and no sides"
        : `${usable.toPrecision(3)} m³ usable` +
          (derated ? ` of ${gross!.toPrecision(3)} m³` : "") },
    { label: "Payload", on: Number(draft.max_weight_capacity) > 0,
      says: Number(draft.max_weight_capacity) > 0
        ? `${draft.max_weight_capacity} kg` : "no weight limit" },
    { label: "Opening", on: boxed,
      says: boxed
        ? `${sides[0]} × ${sides[1]} × ${sides[2]} cm`
        : "sides not measured" },
    { label: "Unit limit", on: Number(draft.max_handling_units) > 0,
      says: Number(draft.max_handling_units) > 0
        ? `${draft.max_handling_units} handling unit` +
          (Number(draft.max_handling_units) === 1 ? "" : "s")
        : "worked out from the sides" },
  ];
  const live = gates.filter((g) => g.on).length;

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          What a putaway will be checked on
        </span>
        <span className={`text-[11px] font-semibold ${live === 0 ? "text-warn" : "text-muted"}`}>
          {live} of 4 gates set
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {gates.map((gate) => (
          <div
            key={gate.label}
            className={`rounded-lg border px-2.5 py-1.5 ${
              gate.on ? "border-ok/30 bg-ok-bg/40" : "border-line bg-content1"
            }`}
          >
            <div className={`text-[10px] font-semibold uppercase tracking-wider ${
              gate.on ? "text-ok" : "text-muted"
            }`}>
              {gate.label}
            </div>
            <div className={`tabular truncate text-xs ${gate.on ? "text-ink" : "text-muted"}`}
                 title={gate.says}>
              {gate.says}
            </div>
          </div>
        ))}
      </div>
      {live === 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-warn">
          Nothing is set, so this location can never say whether a pack fits it. It
          still accepts stock — capacity warns, it never blocks — but every putaway
          into it reports “no capacity set”.
        </p>
      )}
    </div>
  );
}

/** The cube this draft comes to — stated, else worked out from its three sides.
 *  The same rule the server applies (`capacity.gross_volume`), so the panel below and
 *  the save can never disagree about how big this location is. */
const grossVolume = (draft: BinWrite): number | null => {
  const stated = Number(draft.capacity_volume);
  if (Number.isFinite(stated) && stated > 0) return stated;
  const sides = [draft.length_cm, draft.width_cm, draft.height_cm].map(Number);
  return sides.every((n) => Number.isFinite(n) && n > 0)
    ? (sides[0] * sides[1] * sides[2]) / 1_000_000
    : null;
};

const m3 = (value: number | string | null | undefined) =>
  value == null || value === "" ? "—" : `${Number(Number(value).toFixed(3))} m\u00b3`;

/**
 * Does this location fit inside the one it hangs off, and does what is inside it
 * still fit this?
 *
 * Every rung of the tree is measured, not just the bays — a floor has a cube, a lane
 * has a cube, a rack has a cube — and the rule that makes those numbers mean anything
 * is that **a location is at least as big as everything directly inside it**. Without
 * it a 2 m³ rack could be given four 1 m³ shelves and the building would be described
 * as holding twice what it can.
 *
 * The server enforces it on save. This panel is the same arithmetic shown while the
 * form is being filled in, because a refusal after pressing Save tells somebody they
 * were wrong without telling them by how much.
 *
 * An unmeasured location is not a zero-volume one: it is left out of the sum and
 * counted separately, and said out loud, because a budget that quietly treats four
 * unmeasured shelves as taking no space is worse than one that admits it cannot
 * answer.
 */
function ContainmentPanel({
  draft, budget, parentBudget, selfId,
}: {
  draft: BinWrite;
  /** What is inside THIS location. Absent while creating — nothing is inside it yet. */
  budget?: VolumeBudget | null;
  /** What is inside its parent, so this one's share can be measured against it. */
  parentBudget?: VolumeBudget | null;
  selfId: number | null;
}) {
  const own = grossVolume(draft);

  // Inside this one.
  const insideUsed = budget?.children_volume ?? 0;
  const burst = own != null && budget != null && insideUsed > own;

  // Inside its parent — everything else in there, plus what this is about to claim.
  const siblings = (parentBudget?.children ?? []).filter((c) => c.id !== selfId);
  const siblingsUsed = siblings.reduce((sum, c) => sum + Number(c.volume ?? 0), 0);
  const parentGross = parentBudget?.gross_volume ?? null;
  const spare = parentGross == null ? null : parentGross - siblingsUsed;
  const tooBig = spare != null && own != null && own > spare;

  if (!parentBudget && !budget) return null;

  return (
    <div className="mt-4 grid gap-3 lg:grid-cols-2">
      {parentBudget && (
        <div className={`rounded-xl border px-3 py-2.5 ${
          tooBig ? "border-bad/40 bg-bad-bg/30" : "border-line bg-content1"
        }`}>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Room inside {parentBudget.code}
          </div>
          {parentGross == null ? (
            <p className="mt-1 text-xs text-muted">
              {parentBudget.code} has no volume and no sides, so nothing can be checked
              against it. Measure it and this location gets a budget.
            </p>
          ) : (
            <>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className={`tabular font-semibold ${tooBig ? "text-bad" : "text-ink"}`}>
                  {m3(spare)}
                </span>
                <span className="text-xs text-muted">
                  free of {m3(parentGross)} — {siblings.length} other location
                  {siblings.length === 1 ? "" : "s"} take {m3(siblingsUsed)}
                </span>
              </div>
              <p className={`mt-1 text-xs ${tooBig ? "text-bad" : "text-muted"}`}>
                {own == null
                  ? "This location is unmeasured, so it claims none of that yet."
                  : tooBig
                    ? `This is ${m3(own)} and only ${m3(spare)} is left. Make it smaller, `
                      + `or make ${parentBudget.code} bigger — a location cannot hold more `
                      + "than the one it sits in."
                    : `This takes ${m3(own)} of it.`}
              </p>
              {!!parentBudget.unmeasured_children && (
                <p className="mt-1 text-[11px] text-warn">
                  {parentBudget.unmeasured_children} location
                  {parentBudget.unmeasured_children === 1 ? " inside it is" : "s inside it are"}{" "}
                  unmeasured and not counted here.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {budget && budget.child_count > 0 && (
        <div className={`rounded-xl border px-3 py-2.5 ${
          burst ? "border-bad/40 bg-bad-bg/30" : "border-line bg-content1"
        }`}>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            What is inside this one
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className={`tabular font-semibold ${burst ? "text-bad" : "text-ink"}`}>
              {m3(insideUsed)}
            </span>
            <span className="text-xs text-muted">
              across {budget.child_count} location{budget.child_count === 1 ? "" : "s"}
            </span>
          </div>
          <p className={`mt-1 text-xs ${burst ? "text-bad" : "text-muted"}`}>
            {own == null
              ? "This location is unmeasured, so what is inside it cannot be checked."
              : burst
                ? `They come to more than the ${m3(own)} this holds. Make this bigger, `
                  + "or make them smaller."
                : `${m3(own - insideUsed)} of ${m3(own)} still unclaimed.`}
          </p>
          {!!budget.unmeasured_children && (
            <p className="mt-1 text-[11px] text-warn">
              {budget.unmeasured_children} of them{" "}
              {budget.unmeasured_children === 1 ? "is" : "are"} unmeasured and not counted.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function BinForm() {
  const { id, bin_id } = useParams();
  const location = useLocation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const warehouseId = Number(id);
  const editing = !!bin_id;

  const urlParams = new URLSearchParams(location.search);
  const parentParam = urlParams.get("parent_id");

  const [draft, setDraft] = useState<BinWrite | null>(null);

  const { data: bins = [], isLoading: binsLoading } = useQuery({
    queryKey: ["wh-bins", id],
    queryFn: () => getBinTree(warehouseId),
  });

  // What kinds of location this company has, and which of them may hold which. The
  // form used to carry its own array of eleven kinds and a ladder that guessed a
  // child's kind from its parent's; both are the master's answer now.
  const { data: storageTypes = [], isLoading: typesLoading } = useQuery({
    queryKey: ["wh-storage-types"],
    queryFn: listStorageTypes,
  });
  const kinds = useMemo(() => activeTypes(storageTypes), [storageTypes]);

  const flat = useMemo(() => flattenBins(bins), [bins]);

  // The two budgets the containment rule is checked against, SERVED rather than
  // worked out here — see `ContainmentPanel`. Both are read-only questions about the
  // saved tree; what the form is about to write is layered over them in the panel.
  const parentId = draft?.parent_id ?? null;
  const { data: parentBudget } = useQuery({
    queryKey: ["wh-volume-budget", parentId],
    queryFn: () => locationVolumeBudget(Number(parentId)),
    enabled: !!parentId,
  });
  const { data: ownBudget } = useQuery({
    queryKey: ["wh-volume-budget", bin_id],
    queryFn: () => locationVolumeBudget(Number(bin_id)),
    enabled: editing && !!bin_id,
  });

  useEffect(() => {
    if (binsLoading || typesLoading) return;
    if (editing) {
      const bin = flat.find((b) => String(b.id) === bin_id);
      if (bin && !draft) {
        setDraft({
          warehouse_id: warehouseId,
          code: bin.code,
          name: bin.name ?? "",
          description: bin.description ?? "",
          parent_id: bin.parent_id ?? null,
          bin_type: bin.bin_type ?? "BIN",
          capacity_qty: bin.capacity_qty ?? null,
          storage_type_id: bin.storage_type_id ?? null,
          barcode: bin.barcode ?? "",
          floor_level: bin.floor_level ?? null,
          shelf_level: bin.shelf_level ?? null,
          capacity_volume: bin.capacity_volume ?? null,
          max_weight_capacity: bin.max_weight_capacity ?? null,
          length_cm: bin.length_cm ?? null,
          width_cm: bin.width_cm ?? null,
          height_cm: bin.height_cm ?? null,
          max_handling_units: bin.max_handling_units ?? null,
          fill_efficiency_pct: bin.fill_efficiency_pct ?? null,
          aisle_width_meters: bin.aisle_width_meters ?? null,
          temperature_controlled: bin.temperature_controlled ?? false,
          humidity_percentage: bin.humidity_percentage ?? null,
          target_temperature_celsius: bin.target_temperature_celsius ?? null,
          min_temperature_celsius: bin.min_temperature_celsius ?? null,
          max_temperature_celsius: bin.max_temperature_celsius ?? null,
          is_active: bin.is_active,
        });
      }
    } else if (!draft) {
      const parent = parentParam ? flat.find((b) => String(b.id) === parentParam) ?? null : null;
      const cold = coldDefaultsFrom(parent);
      // The first kind, in rung order, that the master says may sit inside this
      // parent — so "Add under Rack 1" opens on Shelf without the form knowing what a
      // rack is.
      const suggested = defaultChildType(parent, storageTypes);
      setDraft({
        warehouse_id: warehouseId,
        code: "",
        name: "",
        description: "",
        parent_id: parent?.id ?? null,
        bin_type: suggested?.code ?? null,
        storage_type_id: suggested?.id ?? null,
        capacity_qty: null,
        barcode: "",
        floor_level: null,
        shelf_level: null,
        capacity_volume: null,
        max_weight_capacity: null,
        length_cm: null,
        width_cm: null,
        height_cm: null,
        max_handling_units: null,
        fill_efficiency_pct: null,
        aisle_width_meters: null,
        ...cold,
        temperature_controlled:
          cold.temperature_controlled || isColdChain(suggested),
        is_active: true,
      });
    }
  }, [binsLoading, typesLoading, editing, bin_id, flat, warehouseId, parentParam,
      draft, storageTypes]);

  const saveBin = useMutation({
    mutationFn: () => {
      const body = cleanDraft(draft!);
      return editing ? updateBin(Number(bin_id), body) : createBin(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wh-bins", id] });
      nav(`/warehouse/masters/warehouses/${id}`);
    },
  });

  if (binsLoading || typesLoading || !draft) {
    return <div className="py-16 text-center text-muted">Loading…</div>;
  }

  // Everything below reads off the master rather than off a constant in this file:
  // which kind this is, which kinds may hold it, and therefore which of the nine
  // hundred locations in the building are offered as its parent.
  const kind = typeOfLocation(draft, storageTypes);
  const parentKinds = parentTypesOf(kind, storageTypes);
  const parents = eligibleParents(flat, kind, storageTypes, editing ? Number(bin_id) : null);
  const topLevelAllowed = canStandAlone(kind);
  const wantsCold = !!draft.temperature_controlled || isColdChain(kind);
  const kindCode = (kind?.code ?? draft.bin_type ?? "").toUpperCase();
  /** The walk down to the parent, so the strip above the form can read the whole path
   *  back. Off the tree's own `path`, which the server derives from the parent links. */
  const parentPath = (() => {
    const parent = flat.find((row) => row.id === draft.parent_id);
    if (!parent) return [] as string[];
    return (parent.path ?? parent.code).split("/").filter(Boolean);
  })();

  /** Choosing a kind re-answers three things at once: what this is, whether the
   *  location it was going to hang off may still hold it, and whether it needs a
   *  temperature band. Doing them together is what stops a form sitting in a state the
   *  server would refuse. */
  const chooseKind = (next: StorageType | null) => {
    const stillFits = eligibleParents(flat, next, storageTypes,
                                      editing ? Number(bin_id) : null)
      .some((row) => row.id === draft.parent_id);
    setDraft({
      ...draft,
      bin_type: next?.code ?? null,
      storage_type_id: next?.id ?? null,
      parent_id: stillFits ? draft.parent_id : null,
      temperature_controlled: isColdChain(next) || !!draft.temperature_controlled,
    });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Storage Location Master"
        title={editing ? `Edit ${draft.code}` : "New Storage Location"}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(`/warehouse/masters/warehouses/${id}`)}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button
              onClick={() => saveBin.mutate()}
              disabled={saveBin.isPending || !draft.code.trim() || !kind}
            >
              {saveBin.isPending ? "Saving…" : "Save location"}
            </Button>
          </>
        }
      />

      <ErrorBanner error={saveBin.error} />

      {/* Where this location will END UP, spelled out. The form asks for a kind and a
          parent as two separate fields; what a storekeeper actually pictures is the walk
          down to the bay, and reading it back is how a wrong parent gets caught before
          the save rather than on the floor a week later. */}
      <Card className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Will sit at
        </span>
        {parentPath.map((step) => (
          <span key={step} className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted">{step}</span>
            <span className="text-muted">/</span>
          </span>
        ))}
        <span className="font-mono text-xs font-bold text-ink">
          {draft.code.trim() || "…"}
        </span>
        {kind && (
          <span className="rounded-md bg-content2 px-2 py-0.5 text-[11px] font-medium text-body">
            {kind.name}
          </span>
        )}
        {kind?.is_pickable && (
          <span className="rounded-md bg-ok-bg px-2 py-0.5 text-[11px] font-medium text-ok">
            Holds stock
          </span>
        )}
      </Card>

      <Section title="Identity" hint="Basic information to identify this storage location.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Code" hint="Required">
            <Input
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
              placeholder="A-01-03"
            />
          </Field>
          <Field label="Name">
            <Input
              value={draft.name ?? ""}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Aisle A, rack 1, shelf 3"
            />
          </Field>
          <Field
            label="Type"
            hint={kind?.description ?? "What kind of storage location this is"}
          >
            <Select
              value={kind ? String(kind.id) : ""}
              onChange={(value) =>
                chooseKind(kinds.find((row) => String(row.id) === value) ?? null)}
              options={kinds.map((row) => ({ value: String(row.id), label: row.name }))}
              placeholder="Choose a type"
              ariaLabel="Storage type"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <Input
                value={draft.description ?? ""}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Purpose, dimensions, or handling notes"
              />
            </Field>
          </div>

          {/* The parent TYPE is not chosen — it follows from the type above, because
              the storage-type master already says where a kind sits. Stated so the
              short list of parents below reads as the rule it is rather than as
              missing data. */}
          <Field label="Parent type" hint="Follows from the type — set on Storage types">
            <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-content2 px-3 py-2">
              {parentKinds.length > 0 ? (
                parentKinds.map((row) => (
                  <span
                    key={row.id}
                    className="rounded-md bg-content1 px-2 py-0.5 text-xs font-medium text-body"
                  >
                    {row.name}
                  </span>
                ))
              ) : (
                <span className="text-xs text-muted">
                  {kind
                    ? `A ${kind.name.toLowerCase()} sits at the top of a warehouse.`
                    : "Choose a type first."}
                </span>
              )}
            </div>
          </Field>

          <Field
            label="Parent location"
            hint={
              parentKinds.length
                ? `Only ${parentKinds.map((row) => row.name.toLowerCase()).join(", ")} are offered`
                : undefined
            }
          >
            <Select
              value={draft.parent_id == null ? "" : String(draft.parent_id)}
              onChange={(value) => {
                const parent = value ? flat.find((row) => row.id === Number(value)) ?? null : null;
                setDraft({ ...draft, parent_id: parent?.id ?? null, ...coldDefaultsFrom(parent) });
              }}
              options={[
                ...(topLevelAllowed ? [{ value: "", label: "Top level" }] : []),
                ...parents.map((row) => ({
                  value: String(row.id),
                  label: `${row.path ?? row.code} (${
                    typeOfLocation(row, storageTypes)?.name ?? row.bin_type ?? "Location"
                  })`,
                })),
              ]}
              placeholder={topLevelAllowed ? undefined : "Choose where it sits"}
              ariaLabel="Parent location"
            />
          </Field>
          {kind && parents.length === 0 && parentKinds.length > 0 && (
            <p className="text-xs leading-relaxed text-warn sm:col-span-2 lg:col-span-3">
              This warehouse has no{" "}
              {parentKinds.map((row) => row.name.toLowerCase()).join(" or ")} yet, so
              there is nowhere to put a {kind.name.toLowerCase()}. Add one first, or
              change what a {kind.name.toLowerCase()} may sit inside on Storage types.
            </p>
          )}
        </div>
      </Section>

      <Section title="Specific Dimensions" hint="Levels and aisle spacing relevant to specific bin types.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kindCode === "FLOOR" && (
            <Field label="Floor level number">
              <Input
                type="number"
                value={draft.floor_level ?? ""}
                onChange={(e) => setDraft({
                  ...draft,
                  floor_level: e.target.value === "" ? null : Number(e.target.value),
                })}
              />
            </Field>
          )}
          {kindCode === "LANE" && (
            <Field label="Aisle width (metres)">
              <Input
                type="number"
                value={draft.aisle_width_meters == null ? "" : String(draft.aisle_width_meters)}
                onChange={(e) => setDraft({
                  ...draft,
                  aisle_width_meters: e.target.value === "" ? null : Number(e.target.value),
                })}
              />
            </Field>
          )}
          {kindCode === "SHELF" && (
            <Field label="Shelf level number">
              <Input
                type="number"
                value={draft.shelf_level ?? ""}
                onChange={(e) => setDraft({
                  ...draft,
                  shelf_level: e.target.value === "" ? null : Number(e.target.value),
                })}
              />
            </Field>
          )}
          {!!kind?.is_pickable && (
            <Field label="Barcode">
              <Input
                value={draft.barcode ?? ""}
                onChange={(e) => setDraft({ ...draft, barcode: e.target.value })}
              />
            </Field>
          )}
        </div>
      </Section>

      <Section
        title="Capacity & Limits"
        hint="Every storage location is measured, not just the bays — a floor, a lane and a rack each hold a cube, and each has to be at least as big as everything inside it."
      >
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Capacity" hint="In the item's own unit. Leave blank for no limit.">
              <Input
                type="number"
                value={draft.capacity_qty == null ? "" : String(draft.capacity_qty)}
                onChange={(e) =>
                  setDraft({ ...draft, capacity_qty: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </Field>
            <Field
              label="Volume capacity (m³)"
              hint="Cubic metres this holds — the bay, the rack, the lane or the whole floor. Leave blank and it is worked out from the three sides below."
            >
              <Input
                type="number"
                min="0"
                step="0.001"
                value={draft.capacity_volume == null ? "" : String(draft.capacity_volume)}
                onChange={(e) => setDraft({
                  ...draft,
                  capacity_volume: e.target.value === "" ? null : Number(e.target.value),
                })}
              />
            </Field>
          </div>
          
          <ContainmentPanel
            draft={draft}
            budget={ownBudget}
            parentBudget={parentBudget}
            selfId={editing ? Number(bin_id) : null}
          />

          <div className="rounded-xl border border-line bg-content2 p-5 shadow-sm">
            <div className="font-display text-base font-bold text-ink">
              Physical gates
            </div>
            <p className="mb-4 mt-1 text-sm leading-relaxed text-muted">
              A putaway is checked against all of these, not just the cube: the
              pack has to fit through the opening, the rack has to carry the
              weight, and a bay that takes one pallet takes one pallet however
              much air is left around it. Each one is optional.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              {([
                ["length_cm", "Depth (cm)"],
                ["width_cm", "Width (cm)"],
                ["height_cm", "Height (cm)"],
              ] as const).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Input
                    type="number"
                    min="0"
                    step="0.1"
                    value={draft[key] == null ? "" : String(draft[key])}
                    onChange={(e) => setDraft({
                      ...draft,
                      [key]: e.target.value === "" ? null : Number(e.target.value),
                    })}
                  />
                </Field>
              ))}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field
                label="Maximum weight (kg)"
                hint="What this can carry, loaded."
              >
                <Input
                  type="number"
                  min="0"
                  step="0.1"
                  value={draft.max_weight_capacity == null ? "" : String(draft.max_weight_capacity)}
                  onChange={(e) => setDraft({
                    ...draft,
                    max_weight_capacity: e.target.value === "" ? null : Number(e.target.value),
                  })}
                />
              </Field>
              <Field
                label="Handling units"
                hint="e.g. 1 pallet, or 4 totes. Blank calculates from sides."
              >
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={draft.max_handling_units == null ? "" : String(draft.max_handling_units)}
                  onChange={(e) => setDraft({
                    ...draft,
                    max_handling_units: e.target.value === "" ? null : Number(e.target.value),
                  })}
                />
              </Field>
              <Field
                label="Usable share (%)"
                hint="Void space you cannot fill. Blank means all of it."
              >
                <Input
                  type="number"
                  min="1"
                  max="100"
                  step="1"
                  value={draft.fill_efficiency_pct == null ? "" : String(draft.fill_efficiency_pct)}
                  onChange={(e) => setDraft({
                    ...draft,
                    fill_efficiency_pct: e.target.value === "" ? null : Number(e.target.value),
                  })}
                />
              </Field>
            </div>
            <GateSummary draft={draft} />
          </div>
        </div>
      </Section>

      <Section title="Environment & Settings" hint="Control temperature constraints and picking status.">
        <div className="space-y-4">
          <label className="flex items-center gap-3">
            <Switch
              isSelected={!!draft.temperature_controlled}
              onValueChange={(value) => setDraft({ ...draft, temperature_controlled: value })}
              aria-label="Temperature controlled"
            />
            <span className="text-sm text-body">Temperature controlled</span>
          </label>
          {isColdChain(kind) && (
            <p className="text-xs leading-relaxed text-muted">
              {kind!.name} is a cold-chain type, so this location keeps a temperature
              band whether or not the switch above is on. Which types are cold chain is
              set on Storage types — there is no second "refrigeration type" to pick,
              because the kind of location IS the answer.
            </p>
          )}
          {wantsCold && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Target temperature °C">
                <Input
                  type="number"
                  value={draft.target_temperature_celsius == null ? "" : String(draft.target_temperature_celsius)}
                  onChange={(e) => setDraft({
                    ...draft,
                    temperature_controlled: true,
                    target_temperature_celsius: e.target.value === "" ? null : Number(e.target.value),
                  })}
                />
              </Field>
              <Field label="Minimum temperature °C">
                <Input
                  type="number"
                  value={draft.min_temperature_celsius == null ? "" : String(draft.min_temperature_celsius)}
                  onChange={(e) => setDraft({
                    ...draft,
                    temperature_controlled: true,
                    min_temperature_celsius: e.target.value === "" ? null : Number(e.target.value),
                  })}
                />
              </Field>
              <Field label="Maximum temperature °C">
                <Input
                  type="number"
                  value={draft.max_temperature_celsius == null ? "" : String(draft.max_temperature_celsius)}
                  onChange={(e) => setDraft({
                    ...draft,
                    temperature_controlled: true,
                    max_temperature_celsius: e.target.value === "" ? null : Number(e.target.value),
                  })}
                />
              </Field>
              <Field label="Humidity %">
                <Input
                  type="number"
                  value={draft.humidity_percentage == null ? "" : String(draft.humidity_percentage)}
                  onChange={(e) => setDraft({
                    ...draft,
                    humidity_percentage: e.target.value === "" ? null : Number(e.target.value),
                  })}
                />
              </Field>
            </div>
          )}

          <label className="flex items-start gap-3 pt-2">
            <Switch
              isSelected={draft.is_active}
              onValueChange={(v) => setDraft({ ...draft, is_active: v })}
              aria-label="Active"
            />
            <span>
              <span className="block text-sm font-medium text-body">Active</span>
              <span className="block text-xs text-muted">
                {kind?.is_pickable
                  ? "Picking may take stock from here."
                  : "Structure only — stock is held in the locations underneath this."}
              </span>
            </span>
          </label>
        </div>
      </Section>
    </div>
  );
}
