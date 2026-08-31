import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CapacityBadge, CapacityMeter, fmtVol, volume } from "../components/CapacityMeter";
import type { LocationOccupancy } from "../types";

/**
 * The meter is the one place a storekeeper learns whether the shelf they picked has
 * room. Two things are worth pinning down: it renders the SERVER's sentences rather
 * than composing its own, and it never quietly turns "not measured" into a zero.
 */

const base: LocationOccupancy = {
  location_id: 10,
  location_code: "BIN-A1",
  location_name: "A1",
  bin_type: "BIN",
  is_pickable: true,
  counts_locations: 1,
  capacity_volume: 500,
  occupied_volume: 100,
  free_volume: 400,
  utilisation_pct: 20,
  unmeasured_items: 0,
  unmeasured_qty: 0,
  measured_items: 2,
  unmeasured_lines: 0,
  is_partial: false,
  item_id: 1,
  item_name: "Cable drum",
  unit_volume_cbm: 0.25,
  qty: 40,
  direction: "IN",
  move_volume: 10,
  lines: [],
  projected_volume: 110,
  projected_free_volume: 390,
  projected_pct: 22,
  over_by: 0,
  status: "OK",
  headline: "BIN-A1 has room",
  detail: "390 m³ of 500 m³ free after this.",
};

describe("volume formatting", () => {
  it("trims trailing zeros rather than quoting false precision", () => {
    expect(fmtVol(0.5)).toBe("0.5");
    expect(fmtVol(12)).toBe("12");
    expect(fmtVol(1.25)).toBe("1.25");
  });

  it("keeps a small part from collapsing to zero", () => {
    // A washer really is 0.000004 m³. Rounding it to "0" would tell the storekeeper
    // the item takes no room at all.
    expect(fmtVol(0.000004)).not.toBe("0");
  });

  it("says nothing rather than zero when there is no figure", () => {
    expect(fmtVol(null)).toBe("—");
    expect(fmtVol(undefined)).toBe("—");
    expect(volume(null)).toBe("—");
    expect(volume(0.5)).toBe("0.5 m³");
  });
});

describe("CapacityMeter", () => {
  it("shows what is left and what this move costs", () => {
    render(<CapacityMeter data={base} />);
    expect(screen.getByText("BIN-A1 has room")).toBeInTheDocument();
    // The user's own example: 500 capacity, 100 used, 400 left.
    expect(screen.getByText("500 m³")).toBeInTheDocument();
    expect(screen.getByText("100 m³")).toBeInTheDocument();
    expect(screen.getByText("+10 m³")).toBeInTheDocument();
    expect(screen.getByText("390 m³")).toBeInTheDocument();
  });

  it("renders the server's words, not its own", () => {
    // Wording lives in `capacity.py` so putaway and material issue say the same
    // thing. If a screen starts composing sentences, they drift.
    render(<CapacityMeter data={{ ...base, headline: "Something the server said" }} />);
    expect(screen.getByText("Something the server said")).toBeInTheDocument();
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
    }} />);
    expect(screen.getByText("Over capacity")).toBeInTheDocument();
    expect(screen.getByText("Over by")).toBeInTheDocument();
    expect(screen.getByText("15 m³")).toBeInTheDocument();
    // It must say the work goes ahead — a warning that reads like a refusal sends
    // the storekeeper looking for a different bin they do not have.
    expect(screen.getByText(/Nothing is stopped/)).toBeInTheDocument();
  });

  it("admits what it could not count instead of showing a tidy total", () => {
    render(<CapacityMeter data={{
      ...base,
      is_partial: true,
      unmeasured_items: 2,
      unmeasured_qty: 400,
    }} />);
    expect(screen.getByText(/no measured volume/)).toBeInTheDocument();
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
      projected_volume: 90,
      projected_free_volume: 410,
      headline: "BIN-A1 frees up 10 m³",
    }} />);
    expect(screen.getByText("Leaving")).toBeInTheDocument();
    expect(screen.getByText("−10 m³")).toBeInTheDocument();
  });

  it("draws nothing at all when there is nothing to say", () => {
    const { container } = render(<CapacityMeter data={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CapacityBadge", () => {
  it("stays out of the way when the location has no capacity set", () => {
    // A bin nobody sized must not render as 0% — that reads as empty.
    const { container } = render(<CapacityBadge capacity={null} occupied={5} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says how much room is left", () => {
    render(<CapacityBadge capacity={100} occupied={60} status="OK" />);
    expect(screen.getByText("40 free")).toBeInTheDocument();
  });

  it("says full rather than a negative number", () => {
    render(<CapacityBadge capacity={100} occupied={140} status="OVER" />);
    expect(screen.getByText("full")).toBeInTheDocument();
  });
});
