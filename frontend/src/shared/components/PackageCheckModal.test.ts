import { describe, expect, it } from "vitest";
import { innerLost, packGroups, packMix, packageTree, packPathLabel } from "./PackageCheckModal";

/** The package check's tree and strip roll-up, tested without a screen (2026-10-28). */

const carton = { code: "PK-WH-1549-0000572", name: "Carton" };
const box7 = { code: "PK-WH-1549-0000597", name: "Box" };
const packages = [
  { code: "PK-WH-1549-0000593", name: "Box", carries: 100, path: [carton] },
  { code: "PK-WH-1549-0000594", name: "Box", carries: 100, path: [carton] },
  { code: "PK-WH-1549-0000611", name: "Strip", carries: 10, path: [carton, box7] },
  { code: "PK-WH-1549-0000612", name: "Strip", carries: 10, path: [carton, box7] },
];

describe("packageTree", () => {
  it("draws 2 boxes + 2 strips as one carton, the strips under their opened box", () => {
    const tree = packageTree(packages);
    expect(tree).toHaveLength(1);
    expect(tree[0].ref?.code).toBe(carton.code);
    const [b1, b2, opened] = tree[0].children;
    expect([b1.pkg?.code, b2.pkg?.code]).toEqual(["PK-WH-1549-0000593", "PK-WH-1549-0000594"]);
    expect(opened.ref?.code).toBe(box7.code);
    expect(opened.children.map((n) => n.pkg?.code)).toEqual(["PK-WH-1549-0000611", "PK-WH-1549-0000612"]);
  });

  it("names the mix and the path", () => {
    expect(packMix(packages)).toBe("2 boxes + 2 strips");
    expect(packPathLabel([carton, box7])).toBe("carton …0572 › box …0597");
    expect(packGroups(packages).map(([k, list]) => [k, list.length]))
      .toEqual([["carton …0572", 2], ["carton …0572 › box …0597", 2]]);
  });
});

describe("innerLost", () => {
  it("rolls strips rejected whole and units out of a strip up into the box", () => {
    const box = {
      code: "B", carries: 100,
      inner: Array.from({ length: 10 }, (_, i) => ({ code: `S${i}`, carries: 10 })),
    };
    expect(innerLost(box, { lost: ["S0", "S1"], partial: { S2: 3 } })).toBe(23);
    expect(innerLost(box, undefined)).toBe(0);
  });
});
