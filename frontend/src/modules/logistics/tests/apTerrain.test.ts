import { describe, expect, it } from "vitest";
import { AP_MAP_DATA } from "../components/apMapData";
import { buildLayers, districtAt, elevationAt, niceScale } from "../components/apTerrain";

const layers = buildLayers(AP_MAP_DATA);

describe("the base map", () => {
  it("knows the 26 districts and which one a place is in", () => {
    expect(layers.districts).toHaveLength(26);
    expect(districtAt(layers, 16.5062, 80.648)?.full).toBe("NTR");               // Vijayawada
    expect(districtAt(layers, 17.6868, 83.2185)?.full).toBe("Visakhapatnam");
    expect(districtAt(layers, 13.6288, 79.4192)?.full).toBe("Tirupati");
    expect(districtAt(layers, 16.7333, 82.2167)).toBeNull();                      // Yanam
  });

  it("carries the real relief: the Ghats high, the delta low, the sea flat", () => {
    expect(elevationAt(layers.terrain, 18.33, 82.87)).toBeGreaterThan(800);      // Araku valley
    expect(elevationAt(layers.terrain, 16.5062, 80.648)).toBeLessThan(80);       // Vijayawada
    expect(elevationAt(layers.terrain, 15.0, 83.0)).toBe(0);                     // Bay of Bengal
  });

  it("names the great rivers", () => {
    const names = layers.rivers.map((river) => river.name);
    expect(names).toEqual(expect.arrayContaining(["Godavari", "Krishna", "Penna"]));
  });
});

describe("the scale bar", () => {
  it("reads in round kilometres", () => {
    expect(niceScale(1, 120)).toEqual({ km: 100, px: 100 });
    expect(niceScale(4, 120)).toEqual({ km: 20, px: 80 });
    expect(niceScale(0, 120)).toEqual({ km: 0, px: 0 });
  });
});
