import { Box, Layers, RotateCcw, Ruler, Scale, Check } from "lucide-react";
import type { HandlingUnit } from "../types";
import { fmtCount, volume, weight } from "./CapacityMeter";

/**
 * Which pack is being handled — the choice every bin check downstream is built on.
 *
 * A quantity on its own says nothing about the space it needs. 1500 SIM cards are
 * three pallets, thirty cartons or 1500 loose eaches depending only on how they turned
 * up on the dock, and a bay that takes one of those takes neither of the others. So
 * this is a first-class choice on the putaway screen rather than a hidden default, and
 * the card for each option shows what picking it would mean: how many units, what cube,
 * what weight.
 *
 * Everything shown comes from the item's own ladder as the server resolved it
 * (`GET /warehouse/items/{id}/handling-units`, via the task) — including which rung is
 * the default and whether a box was measured on the rung or inherited from the
 * container type. The screen computes only `ceil(qty / base)`, which it must show live
 * as the storekeeper edits the quantity, and which mirrors `capacity.space_for`.
 */

/** Whole packs, always rounded up: half a case still occupies a case's footprint.
 *  Mirrors `capacity.space_for` — the same rule on both sides, because this is a
 *  preview of what the server will compute and a preview that disagrees is worse than
 *  no preview. */
export function packsNeeded(qty: number, basePerPack?: number | null): number | null {
  const per = Number(basePerPack ?? 0);
  if (!Number.isFinite(per) || per <= 0) return null;
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return Math.ceil(qty / per);
}

function Spec({ icon: Icon, children }: {
  icon: typeof Box; children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted">
      <Icon className="h-3 w-3 shrink-0" />
      {children}
    </span>
  );
}

export function PackSelector({
  packs, value, onChange, qty, uom, itemLabel, className = "",
}: {
  packs: HandlingUnit[];
  /** `null` means "whatever the server picks" — the flagged default, else the lowest
   *  measured rung. Left null on an untouched screen so the choice is the master
   *  data's until somebody actually makes one. */
  value: number | null;
  onChange: (id: number | null) => void;
  qty: number;
  uom?: string | null;
  itemLabel: string;
  className?: string;
}) {
  if (packs.length === 0) {
    return (
      <div className={`rounded-xl border border-line bg-content2 px-4 py-3 ${className}`}>
        <div className="font-display text-sm font-bold text-ink">Handling unit</div>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {itemLabel} has no packaging ladder, so there is no handling unit to measure
          and no location can say whether it fits. Add one under Masters &gt; Items on
          the item&rsquo;s Packaging tab — a level, a container type, and how many go in
          one.
        </p>
      </div>
    );
  }

  // What the server would pick if the screen says nothing, so the highlighted card and
  // the meter below it always agree about which rung is in play.
  const fallback = packs.find((p) => p.is_default) ?? packs[0];
  const selectedId = value ?? fallback?.item_packaging_id ?? null;

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Handling unit — what is being put away
        </span>
        <span className="text-[11px] text-muted">
          The bin is checked against whole packs, not loose volume.
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {packs.map((pack) => {
          const selected = pack.item_packaging_id === selectedId;
          const units = packsNeeded(qty, pack.base_qty);
          const cube = pack.volume_cbm == null || units == null
            ? null : pack.volume_cbm * units;
          const load = pack.gross_weight_kg == null || units == null
            ? null : pack.gross_weight_kg * units;

          return (
            <button
              key={pack.item_packaging_id ?? pack.level}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(pack.item_packaging_id ?? null)}
              className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                selected
                  ? "border-brand bg-brand/[0.06] ring-1 ring-brand/30"
                  : "border-line bg-content1 hover:border-brand/40 hover:bg-content2"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-display text-sm font-bold text-ink">
                      {pack.package_name ?? `Level ${pack.level}`}
                    </span>
                    {pack.is_default && !selected && (
                      <span className="rounded-full bg-content2 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-muted">
                        default
                      </span>
                    )}
                    {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    Level {pack.level} · holds{" "}
                    <span className="tabular font-semibold text-body">
                      {fmtCount(pack.base_qty)}
                    </span>{" "}
                    {pack.uom_code ?? uom ?? "units"}
                  </div>
                </div>
              </div>

              {/* What choosing this one MEANS for the load in hand. The whole reason
                * the choice is a card rather than a dropdown entry. */}
              <div className="mt-2 border-t border-line/70 pt-2">
                {units == null ? (
                  <span className="text-[11px] text-warn">
                    This level has no quantity, so it cannot be counted.
                  </span>
                ) : (
                  <div className="flex items-baseline gap-1.5">
                    <span className="tabular font-display text-lg font-black leading-none text-ink">
                      {fmtCount(units)}
                    </span>
                    <span className="text-[11px] text-muted">
                      {units === 1 ? "unit" : "units"} for {fmtCount(qty)}{" "}
                      {uom ?? "units"}
                    </span>
                  </div>
                )}
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                  {pack.is_measured ? (
                    <>
                      <Spec icon={Box}>{volume(cube)}</Spec>
                      {load != null && <Spec icon={Scale}>{weight(load)}</Spec>}
                      <Spec icon={Ruler}>
                        {fmtCount(pack.length_cm)} × {fmtCount(pack.width_cm)} ×{" "}
                        {fmtCount(pack.height_cm)} cm
                        {pack.dims_from === "PACKAGE" && (
                          <span className="italic"> (container type)</span>
                        )}
                      </Spec>
                    </>
                  ) : (
                    <span className="text-[11px] text-warn">
                      Not measured — no location can say whether this fits.
                    </span>
                  )}
                  {pack.max_stack_tiers != null && (
                    <Spec icon={Layers}>
                      {pack.max_stack_tiers === 1
                        ? "do not stack"
                        : `stack ${pack.max_stack_tiers} high`}
                    </Spec>
                  )}
                  {pack.is_rotatable === false && (
                    <Spec icon={RotateCcw}>do not turn</Spec>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
