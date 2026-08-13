# CHS-104 master data

Twenty-two import-ready workbooks built from `CHS-104 (1) (1).xlsx` (38 consumables,
27 reagents, 21 instruments). Brands, manufacturers, HSN codes and GST rates are
real-world — the source workbook carries none of them.

**830 rows, all 22 files imported into `SCM_PROD` on 2026-08-13.** Every file was
generated from the master's own Pydantic schema, so the headers are exactly what
`/import` accepts.

## Import order matters

Foreign keys in these files are **numeric ids**, and they are the ids the rows get when
the files are imported **in the numbered order into a database whose master tables are
empty**. Import out of order, or into a database that already has masters, and the ids
point at the wrong parents.

| # | File | Rows | What it is |
|---|------|------|------------|
| 01 | uom | 20 | Units, one per measurement class |
| 02 | uom_conversions | 6 | ml↔litre, g↔kg, mm↔m |
| 03 | hsn_codes | 31 | 8-digit HSN with real CGST/SGST/IGST |
| 04 | item_classes | 4 | Consumable, Reagent, Asset, Spare |
| 05 | item_sub_classes | 16 | Disposable, Biochem, Analyser, … |
| 06 | item_categories | 81 | 3 levels — the Level 3 six-digit path feeds the item code |
| 07 | manufacturers | 51 | Transasia, BD, HMD, Tarsons, Borosil, … |
| 08 | brands | 50 | Erba, Vacutainer, Dispovan, … (carries the brand→manufacturer mapping) |
| 09 | general_names | 84 | The generic product behind each item |
| 10 | dosage_forms | 5 | Liquid, lyophilised, strip, … |
| 11 | packaging | 10 | Piece, vial, bottle, box, kit, … |
| 12 | attributes | 10 | Pick-lists: colour, tube additive, needle gauge, glove size |
| 13 | specs | 12 | Measurements: volume, tests per kit, storage temperature |
| 14 | features | 11 | Yes/no: cold chain, fragile, biohazard, flammable |
| 15 | category_tags | 129 | Which attribute/spec/feature hangs off which category |
| 16 | items | 87 | The catalogue |
| 17 | item_packaging | 75 | Pack breakdown — "10 x 44 ml" becomes bottle 44, kit 10 |
| 18 | vendors | 12 | Suppliers for this kit |
| 19 | vendor_items | 28 | Preferred vendor, lead time, MOQ |
| 20 | boms | 7 | The kits a centre draws |
| 21 | bom_items | 87 | Kit lines, at the source workbook's quantities |
| 22 | bom_groups | 14 | Which job profile draws which kit |

Re-uploading a file is only safe for the masters that carry a `code` — rows are matched
on `id` first, then `code`. The link tables (02, 15, 17, 19, 21, 22) have neither, so a
second upload of those files creates a second set of rows.

## Two importer bugs were fixed to get these in

Both were in the bulk path only; the single-row screens were never affected.

- `bulk.py` serialised a row it had only just flushed, so any serialiser that reads an
  eager relationship or a `column_property` raised `MissingGreenlet` — vendor items and
  BOMs were a 500 every time. It now reloads the row first, the same way the POST route
  already did.
- `vendor_item_out` returned raw `Decimal` values for the rate and the MOQ, and the
  audit row's JSON column cannot encode those. It uses the `_num` helper now, like every
  other serialiser.

## What was decided rather than copied

- **86 source lines became 87 items.** "CD Markers (Blue & Black 1 Each)" is two items,
  because they are two things a store issues separately.
- **Quantities are not in the item master.** 1100 syringes and "26 days × 40 patients"
  is a consumption plan, so it lives in the BOM lines (files 20–22), where a centre
  draws the whole kit in one go.
- **Micropipettes, the chiller box and the forceps moved** out of the CONSUMABLES sheet
  into Instruments / Labware categories: they are durable, and two of them are serial-
  tracked assets.
- **Reagents are cold-chain**: batch-tracked, expiry-tracked, QC on receipt, and
  "Store at 2-8 degrees Celsius" on the item.
- **No GSTIN, PAN, phone, email or price is filled in.** Those are legal and commercial
  identifiers; inventing plausible ones would put fiction into a tax field. Vendor rates
  are left blank for the same reason.
- **HSN codes are 8-digit** because the master requires 8 characters. The rates are the
  standard Indian GST slabs for those headings — confirm them with your CA before the
  first PO, since a wrong rate flows into every purchase.
- **BOM groups point at real job profiles** from the synced HCM tree — `22:DEO` and
  `22:STORE KEEPER` draw the six monthly kits, `22:OE` and `22:DISTRICT MANAGER` get the
  commissioning kit. That is a starting point, not a decision: change it on the BOM
  screen. There is no company-wide "everyone" profile to fall back on.
