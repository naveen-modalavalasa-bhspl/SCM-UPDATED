import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ITEM_SECTIONS, ItemSectionTabs, brandsForGeneralName, itemCodePreview,
  manufacturersForBrand, missingRequiredTags, packagingBreakupText,
} from "../components/ItemMasterTab";
import type { MasterBrand, MasterCategoryTag, MasterGeneralName } from "../types";

const manufacturers = [
  { id: 10, code: "ACME", name: "Acme", is_active: true },
  { id: 20, code: "OTHER", name: "Other", is_active: true },
];

const brands: MasterBrand[] = [
  { id: 1, code: "DOLO", name: "Dolo", manufacturer_ids: [], manufacturer_names: [], is_active: true },
  { id: 2, code: "CROCIN", name: "Crocin", manufacturer_ids: [], manufacturer_names: [], is_active: true },
];
const generalName = (brand_ids: number[]): MasterGeneralName => ({
  id: 5, code: "PARACET", name: "Paracetamol", brand_ids,
  brand_names: [], is_active: true,
});

describe("item master identity", () => {
  it("shows only active manufacturers mapped to the selected brand", () => {
    const rows = manufacturersForBrand(manufacturers, [
      {
        id: 1, brand_id: 7, manufacturer_id: 10,
        manufacturer_code: "ACME", manufacturer_name: "Acme", is_active: true,
      },
      {
        id: 2, brand_id: 7, manufacturer_id: 20,
        manufacturer_code: "OTHER", manufacturer_name: "Other", is_active: false,
      },
    ]);

    expect(rows.map((row) => row.code)).toEqual(["ACME"]);
  });

  it("shows only the brands mapped to the selected general name", () => {
    expect(brandsForGeneralName(brands, generalName([2])).map((row) => row.code))
      .toEqual(["CROCIN"]);
  });

  it("falls back to every brand when the general name has no mapping", () => {
    // The mapping table starts empty. Narrowing to nothing would mean no item could
    // be created until every general name had been mapped first.
    expect(brandsForGeneralName(brands, generalName([]))).toHaveLength(2);
    expect(brandsForGeneralName(brands, undefined)).toHaveLength(2);
  });

  it("previews the generated L1/L2/L3-general code", () => {
    expect(itemCodePreview("101010", 1))
      .toBe("101010-001");
    expect(itemCodePreview(null, 1)).toBe("");
  });

  it("shows #### for the serial until the server allocates one", () => {
    // The serial is a locked MAX+1 on the server. Guessing it in the browser would
    // show a number that another user may already have taken.
    expect(itemCodePreview("101010"))
      .toBe("101010-###");
  });

  it("pads a serial to three digits", () => {
    expect(itemCodePreview("101010", 42))
      .toBe("101010-042");
  });
});

describe("what a category insists on", () => {
  const tag = (over: Partial<MasterCategoryTag>): MasterCategoryTag => ({
    id: 1, category_id: 5, tag_type: "SPEC", tag_id: 9, tag_code: "VOLTAGE",
    tag_name: "Voltage", is_required: true, is_active: true, ...over,
  });

  it("names the required fields that are still blank", () => {
    const tags = [tag({}), tag({ id: 2, tag_code: "COLOUR", tag_name: "Colour",
                                 tag_type: "ATTRIBUTE", is_required: false })];
    expect(missingRequiredTags(tags, {}).map((t) => t.tag_name)).toEqual(["Voltage"]);
    expect(missingRequiredTags(tags, { "SPEC:VOLTAGE": "240" })).toEqual([]);
  });

  it("treats whitespace as an unanswered field", () => {
    expect(missingRequiredTags([tag({})], { "SPEC:VOLTAGE": "  " })).toHaveLength(1);
  });

  it("ignores a required field that has been deactivated", () => {
    expect(missingRequiredTags([tag({ is_active: false })], {})).toEqual([]);
  });

  it("requires a mandatory feature to be selected, not merely present", () => {
    const feature = tag({
      tag_type: "FEATURE", tag_code: "FRAGILE", tag_name: "Fragile",
    });
    expect(missingRequiredTags([feature], { "FEATURE:FRAGILE": "" })).toEqual([feature]);
    expect(missingRequiredTags([feature], { "FEATURE:FRAGILE": "false" })).toEqual([feature]);
    expect(missingRequiredTags([feature], { "FEATURE:FRAGILE": "true" })).toEqual([]);
  });
});

describe("item form sections", () => {
  it("shows every section without a horizontal scrolling strip", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ItemSectionTabs selected="Basic" onChange={onChange} />,
    );

    for (const section of ITEM_SECTIONS) {
      expect(screen.getByRole("button", { name: section })).toBeVisible();
    }
    expect(container.firstElementChild).toHaveClass("flex-wrap");
    expect(container.firstElementChild).not.toHaveClass("overflow-x-auto");

    fireEvent.click(screen.getByRole("button", { name: "Tracking" }));
    expect(onChange).toHaveBeenCalledWith("Tracking");
  });
});

describe("item packaging breakup", () => {
  it("shows every container level and the final item quantity", () => {
    expect(packagingBreakupText({
      level: 3,
      package_id: 3,
      package_name: "Tanker",
      quantity: 10,
      package_breakup: [
        { package_id: 3, package_name: "Tanker", quantity: 1 },
        { package_id: 2, package_name: "Box", quantity: 10 },
        { package_id: 1, package_name: "Packet", quantity: 100 },
      ],
      base_quantity: 100,
      base_uom_code: "L",
    }, "L", "Milk")).toBe(
      "1 Tanker = 10 Box = 100 Packet = 100 L of Milk",
    );
  });

  it("supports a level-one tanker directly in the item's UOM", () => {
    expect(packagingBreakupText({
      level: 1,
      package_id: 3,
      package_name: "Tanker",
      quantity: 100,
      package_breakup: [
        { package_id: 3, package_name: "Tanker", quantity: 1 },
      ],
      base_quantity: 100,
      base_uom_code: "L",
    }, "L", "Milk")).toBe("1 Tanker = 100 L of Milk");
  });
});
