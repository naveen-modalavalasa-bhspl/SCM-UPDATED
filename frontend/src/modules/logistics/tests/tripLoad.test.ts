import { describe, expect, it } from "vitest";
import {
  distanceWord, fillTone, needsMeasuring, safeHref, volumeText, weightText,
} from "../components/tripLoad";

describe("how the planner words a load", () => {
  it("says which figures are firm and puts ~ in front of a guess", () => {
    expect(weightText({ weight_kg: 20, weight_basis: "WEIGHED" })).toBe("20 kg weighed");
    expect(weightText({ weight_kg: 36, weight_basis: "ASSUMED" })).toBe("~36 kg assumed per package");
    expect(volumeText({ volume_cbm: 0.12, volume_basis: "ESTIMATED" }))
      .toBe("~0.12 m³ estimated from items");
    expect(weightText({ weight_kg: 0, weight_basis: null })).toBe("weight not recorded");
  });

  it("asks for the scale only when something is not weighed and measured", () => {
    expect(needsMeasuring({ weight_basis: "WEIGHED", volume_basis: "MEASURED" })).toBe(false);
    expect(needsMeasuring({ weight_basis: "WEIGHED", volume_basis: "ASSUMED" })).toBe(true);
    expect(needsMeasuring({ weight_basis: null, volume_basis: null })).toBe(true);
  });

  it("names the distance basis, estimate by default", () => {
    expect(distanceWord("ROAD")).toBe("Road km");
    expect(distanceWord("MIXED")).toMatch(/partly estimated/);
    expect(distanceWord(undefined)).toBe("Estimated km");
  });

  it("colours a bar by how full it is", () => {
    expect(fillTone(40)).toBe("ok");
    expect(fillTone(90)).toBe("warn");
    expect(fillTone(101)).toBe("bad");
  });
});

describe("a carrier's proof-of-delivery link", () => {
  it("is a link only when it is plain http(s)", () => {
    expect(safeHref("https://pod.example/stop-2.jpg")).toBe("https://pod.example/stop-2.jpg");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("https://a b")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});
