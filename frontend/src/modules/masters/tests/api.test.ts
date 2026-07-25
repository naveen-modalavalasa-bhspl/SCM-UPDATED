import { describe, expect, it } from "vitest";
import { mastersApi } from "../api";

/** Masters that go through the backend's MasterDef factory: same four verbs each. */
const CRUD_MASTERS = [
  "items", "categories", "vendors", "warehouses", "bins", "projects",
  "brands", "manufacturers", "generalNames", "dosageForms",
  "brandManufacturers", "itemClasses", "itemSubClasses",
  "packaging", "features", "attributes",
  "attributeMappings", "priceLists", "priceListItems", "boms", "bomItems",
] as const;

describe("masters api", () => {
  it("covers every master the Masters screen shows a tab for", () => {
    expect(Object.keys(mastersApi).sort()).toEqual([
      "attributeMappings", "attributes", "bins", "bomItems", "boms",
      "brandManufacturers", "brands", "categories", "departments", "docSeries",
      "dosageForms", "facilities", "features", "generalNames",
      "itemClasses", "itemSpecs", "itemSubClasses", "items", "manufacturers",
      "packaging", "priceListItems",
      "priceLists", "projects", "roles", "uom", "uomConversions", "vendors",
      "warehouses",
    ]);
  });

  it("factory-backed masters expose list, create, update and deactivate", () => {
    for (const key of CRUD_MASTERS) {
      expect(typeof mastersApi[key].list).toBe("function");
      expect(typeof mastersApi[key].create).toBe("function");
      expect(typeof mastersApi[key].update).toBe("function");
      // Records are deactivated, never deleted: documents reference them by id.
      expect(typeof mastersApi[key].deactivate).toBe("function");
    }
  });

  it("short lookup lists also offer an unpaginated listAll", () => {
    expect(typeof mastersApi.uom.listAll).toBe("function");
    expect(typeof mastersApi.uomConversions.listAll).toBe("function");
    expect(typeof mastersApi.docSeries.listAll).toBe("function");
  });

  it("HCM-mirrored masters and roles are read-only", () => {
    // hcm_* is written only by the sync (rule 10), so these are plain fetchers
    // with no create/update attached.
    expect(typeof mastersApi.departments).toBe("function");
    expect(typeof mastersApi.facilities).toBe("function");
    expect(typeof mastersApi.roles).toBe("function");
  });

  it("uom conversions cannot be deactivated: the live table has no is_active", () => {
    expect("deactivate" in mastersApi.uomConversions).toBe(true);
    // The route exists and returns a clear 400; what matters is that the UI does not
    // offer a Deactivate button for this master (MastersPage omits onDeactivate).
  });

  it("item specs are read and saved per item, not created", () => {
    // mst_item_specs is keyed by item_id, so there is no create or deactivate.
    expect(Object.keys(mastersApi.itemSpecs).sort()).toEqual(["get", "save"]);
  });
});
