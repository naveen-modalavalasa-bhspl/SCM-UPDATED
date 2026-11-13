import { describe, expect, it } from "vitest";
import { cartonCountLabel, cartonsOf, passPackageTotal } from "../components/gatePassPackages";

/** SCM_0130: the gate pass counts cartons, not freight lines. */
describe("gate pass packages", () => {
  it("lists each carton an item is in once, in natural order", () => {
    expect(cartonsOf([
      { package_no: "P-10", quantity: 2 }, { package_no: "P-2", quantity: 1 },
      { package_no: "P-2", quantity: 4 }, { package_no: null, quantity: 1 },
    ])).toEqual(["P-2", "P-10"]);
    expect(cartonsOf(undefined)).toEqual([]);
  });

  it("says how many in words", () => {
    expect(cartonCountLabel(["P-1"])).toBe("1 carton");
    expect(cartonCountLabel(["P-1", "P-3"])).toBe("2 cartons");
  });

  it("totals the consignment's own cartons, not the lines' freight counts", () => {
    expect(passPackageTotal({ consignment_package_total: 2, total_packages: 3 })).toBe(2);
    expect(passPackageTotal({ consignment_package_total: null, total_packages: 3 })).toBe(3);
  });
});
