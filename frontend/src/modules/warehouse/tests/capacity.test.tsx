import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CapacityBadge, CapacityMeter, fmtCount, fmtVol, volume, weight,
} from "../components/CapacityMeter";
import { PackSelector, packsNeeded } from "../components/PackSelector";
import type { CapacityGate, HandlingUnit, LocationOccupancy } from "../types";

/**
 * The meter is the one place a storekeeper learns whether the shelf they picked has
 * room. Three things are worth pinning down: it renders the SERVER's sentences rather
 * than composing its own, it draws all four gates rather than only the cube, and it
 * never quietly turns "not measured" into a zero.
 */

function gate(over: Partial<CapacityGate> = {}): CapacityGate {
  return {
    key: "VOLUME",
    label: "Cube",
    unit: "m³",
    status: "OK",
    capacity: 500,
    occupied: 100,
    projected: 110,
    free: 390,
    over_by: 0,
    pct: 22,
    detail: "390 m³ of 500 m³ free after this.",
    note: null,
    ...over,
  };
}

const base: LocationOccupancy = {
  location_id: 10,
  location_code: "BIN-A1",
  location_name: "A1",
  bin_type: "BIN",
  is_pickable: true,
  counts_locations: 1,
  capacity_volume: 500,
  stated_volume: 500,
  occupied_volume: 100,
  free_volume: 400,
  utilisation_pct: 20,
  projected_volume: 110,
  projected_free_volume: 390,
  projected_pct: 22,
  over_by: 0,
  gates: [gate()],
  capacity_units: 40,
  occupied_units: 10,
  projected_units: 11,
  unmeasured_items: 0,
  unmeasured_qty: 0,
  measured_items: 2,
  unmeasured_lines: 0,
  is_partial: false,
  item_id: 1,
  item_name: "Cable drum",
  qty: 40,
  item_packaging_id: 7,
  pack_name: "Carton",
  pack_base_qty: 4,
  pack_volume_cbm: 1,
  direction: "IN",
  move_volume: 10,
  move_units: 10,
  lines: [],
  status: "OK",
  headline: "BIN-A1 has room",
  detail: "390 m³ of 500 m³ free after this.",
};

describe("formatting", () => {
  it("trims trailing zeros rather than quoting false precision", () => {
    expect(fmtVol(0.5)).toBe("0.5");
    expect(fmtVol(12)).toBe("12");
    expect(fmtVol(1.25)).toBe("1.25");
  });

  it("keeps a small part from collapsing to zero", () => {
    // A washer really is 0.000004 m³. Rounding it to "0" would tell the storekeeper the
    // item takes no room at all.
    expect(fmtVol(0.000004)).not.toBe("0");
  });

  it("says nothing rather than zero when there is no figure", () => {
    expect(fmtVol(null)).toBe("—");
    expect(fmtVol(undefined)).toBe("—");
    expect(volume(null)).toBe("—");
    expect(volume(0.5)).toBe("0.5 m³");
    expect(weight(null)).toBe("—");
    expect(weight(18.5)).toBe("18.5 kg");
  });

  it("counts handling units as whole numbers", () => {
    // "3.000 cases" makes a storekeeper wonder what the decimals are hiding.
    expect(fmtCount(3)).toBe("3");
    expect(fmtCount(3.0)).toBe("3");
  });
});

describe("packsNeeded", () => {
  it("rounds a part pack up to a whole one", () => {
    // The rule the whole feature turns on, mirrored from `capacity.space_for`: half a
    // case still occupies a case's footprint.
    expect(packsNeeded(6, 10)).toBe(1);
    expect(packsNeeded(10, 10)).toBe(1);
    expect(packsNeeded(11, 10)).toBe(2);
    expect(packsNeeded(25, 10)).toBe(3);
  });

  it("says nothing rather than zero when the rung has no quantity", () => {
    expect(packsNeeded(50, null)).toBeNull();
    expect(packsNeeded(50, 0)).toBeNull();
  });
});

describe("CapacityMeter", () => {
  it("leads with the load in the pack it moves in", () => {
    // The line the old volume-only meter could not draw, and the arithmetic every gate
    // below it is built from.
    render(<CapacityMeter data={base} />);
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText(/Cartons/)).toBeInTheDocument();
  });

  it("renders the server's words, not its own", () => {
    // Wording lives in `capacity.py` so putaway and material issue say the same thing.
    // If a screen starts composing sentences, they drift.
    render(<CapacityMeter data={{ ...base, headline: "Something the server said" }} />);
    expect(screen.getByText("Something the server said")).toBeInTheDocument();
  });

  it("draws every gate, not only the cube", () => {
    render(<CapacityMeter data={{
      ...base,
      gates: [
        gate(),
        gate({ key: "WEIGHT", label: "Payload", unit: "kg", capacity: 250,
               projected: 300, status: "OVER", over_by: 50,
               detail: "This puts 50 kg more on BIN-A1 than it is rated to carry." }),
        gate({ key: "UNITS", label: "Handling units", unit: "units", capacity: 40,
               projected: 11, detail: "11 of 40 handling units in BIN-A1 after this." }),
      ],
    }} />);
    expect(screen.getByText("Cube")).toBeInTheDocument();
    expect(screen.getByText("Payload")).toBeInTheDocument();
    // Twice: the gate's own row, and the summary figure under it.
    expect(screen.getAllByText("Handling units").length).toBeGreaterThan(0);
    expect(screen.getByText(/rated to carry/)).toBeInTheDocument();
  });

  it("names the footprint verdict, which is not a fraction of anything", () => {
    // A pallet either enters the bay or it does not, and a bar would imply it half
    // does. The verdict gate carries no numbers on purpose.
    render(<CapacityMeter data={{
      ...base,
      status: "WONT_FIT",
      headline: "1 unit (Pallet) will not go into BIN-A1",
      detail: "Pallet measures 200 × 10 × 10 cm and BIN-A1 opens to 100 × 100 × 100 cm, so it does not go in. Nothing is stopped.",
      gates: [gate(), gate({
        key: "FOOTPRINT", label: "Fit", unit: null, status: "WONT_FIT",
        capacity: null, occupied: null, projected: null, free: null, over_by: null,
        pct: null, detail: "Pallet measures 200 × 10 × 10 cm and it does not go in.",
      })],
    }} />);
    expect(screen.getByText("Does not fit")).toBeInTheDocument();
    expect(screen.getByText("Will not fit")).toBeInTheDocument();
    // It must still say the work goes ahead — a warning that reads like a refusal sends
    // the storekeeper looking for a different bin they do not have.
    expect(screen.getByText(/Nothing is stopped/)).toBeInTheDocument();
  });

  it("names an overload and how far over it goes", () => {
    render(<CapacityMeter data={{
      ...base,
      status: "OVER",
      projected_volume: 515,
      projected_free_volume: -15,
      over_by: 15,
      headline: "BIN-A1 does not have room",
      detail: "This puts 15 m³ more into BIN-A1 than it holds. Nothing is stopped.",
      gates: [gate({ status: "OVER", projected: 515, free: 0, over_by: 15,
                     detail: "This puts 15 m³ more into BIN-A1 than it holds." })],
    }} />);
    expect(screen.getByText("Over capacity")).toBeInTheDocument();
    expect(screen.getByText("Over by")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is stopped/)).toBeInTheDocument();
  });

  it("shows the gate's own caveat rather than hiding a derated capacity", () => {
    render(<CapacityMeter data={{
      ...base,
      fill_efficiency_pct: 80,
      gates: [gate({ note: "Derated to 80.0% of 500.000 m³ for void space." })],
    }} />);
    expect(screen.getByText(/Derated to 80.0%/)).toBeInTheDocument();
  });

  it("admits what it could not count instead of showing a tidy total", () => {
    render(<CapacityMeter data={{
      ...base,
      is_partial: true,
      unmeasured_items: 2,
      unmeasured_qty: 400,
    }} />);
    expect(screen.getByText(/no measured pack/)).toBeInTheDocument();
    expect(screen.getByText(/the real figure is higher/)).toBeInTheDocument();
  });

  it("says a rack's figure covers everything under it", () => {
    render(<CapacityMeter data={{ ...base, counts_locations: 12 }} />);
    expect(screen.getByText(/covers 12 locations/)).toBeInTheDocument();
  });

  it("shows an outward move as space coming back", () => {
    render(<CapacityMeter data={{
      ...base,
      direction: "OUT",
      move_volume: 10,
      move_units: 3,
      projected_volume: 90,
      headline: "BIN-A1 frees up 3 units (Carton)",
    }} />);
    expect(screen.getByText("−3")).toBeInTheDocument();
    expect(screen.getByText(/frees up/)).toBeInTheDocument();
  });

  it("draws nothing at all when there is nothing to say", () => {
    const { container } = render(<CapacityMeter data={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CapacityBadge", () => {
  it("stays out of the way when the location has no limit of any kind", () => {
    // A bin nobody sized must not render as 0% — that reads as empty.
    const { container } = render(<CapacityBadge capacity={null} occupied={5} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says how much room is left, in the unit it is measured in", () => {
    // `volume()` carries the unit on purpose: a bare "40 free" beside a bay measured
    // in cubic metres and a bay slotted in pallets is the ambiguity this whole
    // component exists to remove.
    render(<CapacityBadge capacity={100} occupied={60} status="OK" />);
    expect(screen.getByText("40 m³ free")).toBeInTheDocument();
  });

  it("says full rather than a negative number", () => {
    render(<CapacityBadge capacity={100} occupied={140} status="OVER" />);
    expect(screen.getByText("full")).toBeInTheDocument();
  });

  it("draws the discrete limit where a bay has one and no cube", () => {
    // "This bay takes one pallet" is a real limit, and a chip that can only draw cubes
    // would show nothing at all for it.
    render(<CapacityBadge capacity={null} units={1} capacityUnits={1} status="FULL" />);
    expect(screen.getByText("1/1 units")).toBeInTheDocument();
  });
});

describe("PackSelector", () => {
  const carton: HandlingUnit = {
    item_packaging_id: 1, level: 1, package_id: 100, package_name: "Carton",
    base_qty: 50, uom_code: "NOS", length_cm: 40, width_cm: 30, height_cm: 25,
    volume_cbm: 0.03, gross_weight_kg: 12, is_default: true, is_measured: true,
    dims_from: "PACKAGE",
  };
  const pallet: HandlingUnit = {
    item_packaging_id: 2, level: 2, package_id: 101, package_name: "Pallet",
    base_qty: 1000, uom_code: "NOS", length_cm: 120, width_cm: 100, height_cm: 150,
    volume_cbm: 1.8, gross_weight_kg: 260, is_default: false, is_measured: true,
    max_stack_tiers: 2, dims_from: "PACKAGE",
  };

  it("shows what choosing each pack would mean for the load in hand", () => {
    // The reason this is a card and not a dropdown entry: 1500 units is 30 cartons or
    // 2 pallets, and a bay that takes one takes neither of the others.
    render(<PackSelector packs={[carton, pallet]} value={null} onChange={() => {}}
                         qty={1500} uom="NOS" itemLabel="Cable drum" />);
    expect(screen.getByText("30")).toBeInTheDocument();   // 1500 / 50
    expect(screen.getByText("2")).toBeInTheDocument();    // 1500 / 1000
  });

  it("says a rung is unmeasured rather than costing it at zero", () => {
    render(<PackSelector packs={[{ ...carton, is_measured: false, volume_cbm: null }]}
                         value={null} onChange={() => {}} qty={100} uom="NOS"
                         itemLabel="Cable drum" />);
    expect(screen.getByText(/Not measured/)).toBeInTheDocument();
  });

  it("points at the fix when an item has no ladder at all", () => {
    render(<PackSelector packs={[]} value={null} onChange={() => {}} qty={100}
                         uom="NOS" itemLabel="Cable drum" />);
    expect(screen.getByText(/no packaging ladder/)).toBeInTheDocument();
  });

  it("carries the handling rules a slotting check depends on", () => {
    render(<PackSelector packs={[pallet]} value={2} onChange={() => {}} qty={1000}
                         uom="NOS" itemLabel="Cable drum" />);
    expect(screen.getByText(/stack 2 high/)).toBeInTheDocument();
  });
});
