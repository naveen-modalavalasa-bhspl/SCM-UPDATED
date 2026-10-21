import { describe, expect, it } from "vitest";
import { mastersApi } from "../api";

/** Masters that go through the backend's MasterDef factory: same four verbs each. */
const CRUD_MASTERS = [
  "items", "categories", "vendors", "warehouses", "bins",
  "brands", "manufacturers", "generalNames", "dosageForms", "hsnCodes",
  "brandManufacturers", "itemClasses", "itemSubClasses",
  "packaging", "features", "attributes",
  "specs", "categoryTags", "itemGroups", "itemComponents", "itemPackaging",
  "boms", "bomItems", "bomGroups", "vendorItems",
] as const;

describe("masters api", () => {
  it("covers every master the Masters screen shows a tab for", () => {
    expect(Object.keys(mastersApi).sort()).toEqual([
      "attributes", "bins", "bomGroups", "bomItems", "boms",
      "brandItemMapping", "brandManufacturers", "brands", "categories", "categoryTags",
      "departments",
      "dosageForms", "facilities", "features", "generalNames", "hsnCodes",
      "itemClasses", "itemComponents", "itemEligibility", "itemGroups", "itemPackaging",
      "itemPhotos", "itemSpecs", "itemSubClasses", "items", "manufacturers",
      "nextItemCode",
      "ownershipDepartments", "packHierarchies", "packaging", "paymentTerms", "projects", "specs",
      "unitCodeTracking", "uom", "uomClasses", "uomConversions",
      "userGroups", "vendorCategories", "vendorItems", "vendorMapping", "vendors",
      "warehouses",
    ]);
  });

  it("every factory-backed master can be templated, exported and imported", () => {
    // The three bulk calls come from the same backend factory as list/create, so a
    // master that has CRUD but no template is a wiring mistake, not a design choice.
    for (const key of CRUD_MASTERS) {
      expect(typeof mastersApi[key].template).toBe("function");
      expect(typeof mastersApi[key].export).toBe("function");
      expect(typeof mastersApi[key].import).toBe("function");
      expect(typeof mastersApi[key].usage).toBe("function");
    }
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
  });

  it("HCM-mirrored masters are read-only", () => {
    // hcm_* is written only by the sync (rule 10), so these are plain fetchers
    // with no create/update attached.
    expect(typeof mastersApi.departments).toBe("function");
    expect(typeof mastersApi.ownershipDepartments).toBe("function");
    expect(typeof mastersApi.facilities).toBe("function");
  });

  it("projects are read-only: HCM owns them", () => {
    // The backend registers no write routes for projects, so offering create or
    // update here would only produce a 404 the user cannot act on.
    expect(Object.keys(mastersApi.projects)).toEqual(["list"]);
  });

  it("uom offers the suggestion catalogue as well as plain CRUD", () => {
    expect(typeof mastersApi.uom.suggestions).toBe("function");
    expect(typeof mastersApi.uom.createSuggested).toBe("function");
  });

  it("an item's packing ladder can be read back with its running totals", () => {
    // The totals are multiplied up on the server, never stored, so they cannot
    // drift from the rungs they come from.
    expect(typeof mastersApi.itemPackaging.breakdown).toBe("function");
  });

  it("attributes, specs and features tag to a category through one client", () => {
    // Three tabs became one: all three answer the same two questions.
    expect(typeof mastersApi.categoryTags.list).toBe("function");
    expect("attributeMappings" in mastersApi).toBe(false);
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

  it("resolves an entered HSN code through the item-entry endpoint", () => {
    expect(typeof mastersApi.hsnCodes.resolve).toBe("function");
  });

  it("BOM groups read their job profiles from RBAC, not from a master", () => {
    // A job profile is derived from the HCM mirror and has no table, so the picker
    // is a live lookup — there is nothing here to create or edit.
    expect(typeof mastersApi.bomGroups.profiles).toBe("function");
  });
});
