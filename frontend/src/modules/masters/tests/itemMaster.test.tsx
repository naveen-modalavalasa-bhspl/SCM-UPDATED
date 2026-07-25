import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ITEM_SECTIONS, ItemSectionTabs, itemCodePreview, manufacturersForBrand,
} from "../components/ItemMasterTab";

const manufacturers = [
  { id: 10, code: "ACME", name: "Acme", is_active: true },
  { id: 20, code: "OTHER", name: "Other", is_active: true },
];

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

  it("previews the generated L1/L2/L3-general-brand-manufacturer code", () => {
    expect(itemCodePreview("101010", "slide", "lab", "acme"))
      .toBe("101010-SLIDE-LAB-ACME");
    expect(itemCodePreview("101010", "slide", "lab", null)).toBe("");
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
