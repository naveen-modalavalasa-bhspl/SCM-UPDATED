# Masters Overhaul — Design

Date: 2026-07-28
Status: approved, in implementation

Rewrites the masters module so item identity, classification, packaging and tagging
are modelled once and enforced in the backend. Replaces free-text duplicates with
real rows, collapses three near-identical screens into one, and moves quantities that
belong to an item off the shared lookup they were sitting on.

---

## Decisions taken

| Question | Decision |
|---|---|
| Specs vs Attributes | Two masters. Attributes are selectable traits (colour, size, grade) with a value list. Specs are technical measurements carrying a UOM (voltage 240 V). Both tag to categories, both carry required yes/no. |
| Packaging model | A package master (Tray, Box, Container) plus a per-item chain. The same Tray can be reused by items that fill it differently. |
| Item code serial | Four digits, restarting per full `L1L2L3-GEN-BRAND-MFR` prefix. |
| BOM | Master only this round: name, project, lines. The raise-an-indent-from-a-BOM action is a later task in the indents module. |
| Brand / Manufacturer | Two screens. The Brand form carries a multi-select of manufacturers; the `brand-manufacturers` tab disappears. |
| User groups | A group is defined by position or role. Items tagged to it are the only items its members may pick when raising an indent. |
| Category uniqueness | Name unique within its parent. Code stays globally unique. |
| Asset flag | A manual Asset / Consumable switch on the item. The asset or consumable code is generated during putaway in the warehouse module, never here. |
| Kit components | Real item picker, so kit contents can be issued and stock-checked. |
| Pricing / tax | Off the item form. Tax comes from a new HSN master at PO/GRN time. |
| UOM classes | Ten: Count, Length, Area, Volume, Weight, Temperature, Time, Pressure, Energy, Packaging. |

---

## Data model

### New tables

**`mst_hsn_codes`** — code, description, `cgst_rate`, `sgst_rate`, `igst_rate`,
`cess_rate`, `effective_from`, `is_active`. Tax is read from here at PO/GRN time and
never copied onto the item, so a rate change does not require touching every item.

**`mst_item_packaging`** — the per-item chain. `item_id`, `level` (1, 2, 3 …),
`package_id` + name snapshot, `quantity`, `uom_id` + code snapshot, `is_active`.
Unique on (`item_id`, `level`). Level 1 quantity is expressed in the item's own UOM
(a tray holds 10 L); every level above it counts the level below (a box holds 10
trays). The breakdown shown on screen is computed by multiplying up the chain, so a
stored total can never disagree with its own parts.

**`mst_specs`** — code, name, `uom_id` + code snapshot, description, `is_active`.

**`mst_item_components`** — kit lines. `item_id`, `line_no`, `component_item_id` +
code/name snapshots, `quantity`, `uom_id` + code snapshot, `remarks`.

**`mst_category_tags`** — one table for all three tagging relationships.
`category_id` + name snapshot, `tag_type` (ATTRIBUTE | SPEC | FEATURE), `tag_id` +
code/name snapshots, `is_required`, `is_active`. Unique on (`category_id`,
`tag_type`, `tag_id`). Replaces `mst_attribute_mappings` as the tagging surface and
absorbs what would otherwise have been two more mapping tables.

**`mst_item_groups`** — `item_id`, `group_id` (soft FK to `rbac_user_groups`, no
constraint — `shared` must not depend on `platform`), name snapshots, `is_active`.
Unique on (`item_id`, `group_id`).

### Changed tables

- **`mst_packaging`** becomes the package master. `qty_per_pack` and `uom_id` leave
  the API: quantity is a property of an item's chain, not of the package type.
- **`mst_items`** gains `hsn_id` (FK, mandatory), `is_asset`, `is_imei_tracked`,
  `serial_no`.
- **`mst_uom.uom_class`** becomes required, drawn from a new `UomClass` enum.
- **`mst_attributes.unit`** (free text) is replaced by `uom_id` + `uom_code`.
- **`mst_boms`** loses `parent_item_id`, `output_qty`, `bom_type`, `effective_from`,
  `effective_to`, `is_default` from the API. `mst_bom_items` loses `scrap_percent`,
  `child_bom_id`, `is_optional`.
- **`mst_item_classes.is_capitalised`** and **`mst_brands.manufacturer`** stay as DB
  columns but leave the schema, the serializer and the UI.

### Removed from the API

`mst_price_lists` and `mst_price_list_items`: both `MasterDef`s, both frontend tabs,
their `api.ts` entries and their types. The tables and models are left in place — no
migration drops them, because nothing is gained by it and the DB team owns the live
schema.

---

## Rules

All of these live in `apply_*` hooks in `shared/masters/defs.py`, which is where the
generic CRUD in `crud.py` delegates per-master behaviour.

**Category name unique within parent.** Checked in Python, not by a unique index: an
L1 category has `parent_id` NULL, and MySQL treats NULLs in a unique index as
distinct, so two L1 rows named "Furniture" would both pass. Furniture may still
appear as an L2 under a different parent.

**Name unique, case-insensitive** for item class, brand, manufacturer, general name,
feature and spec. Same app-level check.

**Item code** is `{6-digit category path}-{GEN}-{BRAND}-{MFR}-{0001}`. The serial is
a locked `MAX + 1` over the rows already sharing that prefix. It is assigned once, at
create, and an edit never regenerates it: a rebrand must not silently renumber an
item that already has stock and documents pointing at it.

**HSN is mandatory** on every item.

**`item.purchase_price` stays** as the stock-valuation cost fallback
(`inventory/service.py`, `_valuation_cost`). It is fed by GRN and hidden from the
item form. Removing it would break valuation, so the form loses the field and the
column keeps its job.

**Item group filter.** When a user's groups have items tagged to them, the indent
item picker returns only those items. A user in no group, or in groups with no tagged
items, sees everything — configuration must never strand a requester.

---

## Frontend

**`shared/components/Select` becomes a typeahead** (HeroUI `Autocomplete`) with the
same props, so every existing call site keeps working without edits. This is the only
file outside `src/modules/masters/` that changes.

**`MasterCrud` gains validation.** `FormField` grows `pattern`, `maxLength` and
`validate`; a failed field blocks Save and shows an inline message rather than
round-tripping to a 422.

**Item form sections** after the rewrite:

Basic · Kit Components · Attributes · Specs · Units · Identification · Tracking ·
Packaging · Additional

- **Basic** — L1 / L2 / L3 cascading and all mandatory, general name, brand,
  manufacturer (filtered to the brand's), item class, subclass, Asset / Consumable
  switch, Has Components, generated code preview, name, short name, description.
- **Kit Components** — shown only when Has Components is on. Item picker, quantity,
  UOM, remarks.
- **Attributes / Specs** — auto-populated from the chosen L3 category's tags, with
  required ones marked.
- **Units** — UOM class first, then only the UOMs of that class.
- **Identification** — HSN (mandatory, typeahead), barcode type and value.
- **Tracking** — batch, serial, IMEI, expiry, requires QI. No shelf life.
- **Packaging** — the level chain with its computed breakdown.
- **Additional** — unchanged.

Gone: Stock Limits (moves to the warehouse module), Pricing, Tax Rates.

**Projects becomes read-only.** HCM already syncs `mst_projects`
(`platform/hcm/sync.py`, `_sync_projects`), so the tab loses its create and edit.

**Tabs removed**: Brand Manufacturers, Price Lists, Attribute Mapping (absorbed into
Category Tagging). **Tabs added**: HSN, Specs, Category Tagging, Packages, Item
Groups.

---

## Phases

Each phase ends with `pytest` green and `npm run build` clean before the next starts.

**Phase 1 — foundations.** Typeahead Select and form validation; category uniqueness;
item class cleanup; brand / manufacturer merge; HSN master; UOM classes with
one-click suggested units; price list removal; projects read-only.

**Phase 2 — tagging.** Specs master; attributes reworked onto a UOM; unified
`mst_category_tags` screen replacing the three mapping surfaces; user groups plus item
tagging and the indent picker filter.

**Phase 3 — heavy.** Package master and per-item packaging chain with breakdown; BOM
rewrite; item form rewrite with serial codes, kit components and the asset flag.

---

## Testing

Backend tests go in `backend/app/shared/masters/tests/test_masters.py` alongside the
existing suite. Each rule above gets a test that asserts the rejection, not just the
happy path: a duplicate L1 name, a duplicate L1 name that is legal as an L2, a second
item on the same prefix getting `0002`, an edit that does not renumber, an item saved
without an HSN, a UOM saved without a class.

Frontend tests go in `frontend/src/modules/masters/tests/`. The typeahead Select gets
its own test in `frontend/src/shared/` — it is shared code and a regression there
breaks every module.
