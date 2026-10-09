"""Write one import-ready .xlsx per master from the CHS-104 data.

Columns come from each master's own Pydantic schema (the same one `/template` and
`/import` use), so a column this script gets wrong fails here rather than on upload.

Foreign keys in these files are numeric ids. They are the ids the rows WILL get when
the files are imported in the numbered order into a database whose master tables are
empty — every table starts at 1 and the importer creates rows in sheet order.
"""
import os
import sys

from openpyxl import Workbook
from openpyxl.styles import Font

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app.main  # noqa: F401  — registers every model
from app.shared.masters.bulk import columns_for
from app.shared.masters.defs import MASTERS

from masters_data import (ATTRIBUTES, BRANDS, CATEGORIES, CATEGORY_TAGS,
                          DOSAGE_FORMS, FEATURES, HSN, ITEM_CLASSES,
                          ITEM_SUB_CLASSES, MANUFACTURERS, PACKAGING, SPECS, UOM,
                          UOM_CONVERSIONS)
from masters_items import (BOM_GROUPS, BOM_ITEMS, BOMS, GENERAL_NAMES,
                           ITEM_PACKAGING, ITEMS, VENDOR_ITEMS, VENDORS)

OUT = sys.argv[1] if len(sys.argv) > 1 else "masters_out"
DEFS = {d.path: d for d in MASTERS}

# --------------------------------------------------------------------------- #
#  What each master's schema actually accepts as a code. Kept here rather than in
#  the data file so the readable key stays readable and the constraint is stated
#  once: HSN is eight digits, most code columns stop at ten characters, and an
#  attribute or spec code may not contain a hyphen.
# --------------------------------------------------------------------------- #
HSN8 = {
    "3822": "38220090", "9027": "90278090", "9018": "90189099",
    "9011": "90118000", "8421": "84211990", "3005": "30051090",
    "4015": "40151900", "7017": "70179000", "3926": "39269099",
    "3923": "39231090", "4818": "48182000", "4802": "48025690",
    "4821": "48211020", "3808": "38089400", "3402": "34029099",
    "6307": "63079090", "9603": "96039000", "8471": "84714190",
    "8443": "84433250", "8517": "85176290", "8523": "85235290",
    "8507": "85072000", "8504": "85044090", "8418": "84185000",
    "9025": "90251990", "9017": "90178090", "9605": "96050000",
    "8479": "84798999", "9106": "91069000", "2828": "28289011",
    "9608": "96082000",
}

SUBCLASS_CODE = {"HOUSEKEEPING": "HOUSEKEEP", "COAGULATION": "COAG"}

BRAND_CODE = {"SCOTCHBRITE": "SCOTCHBRT"}

GENERAL_CODE = {
    "SURG-SPIRIT": "SPIRIT", "ADH-BANDAGE": "BANDAGE",
    "VACUTAINER-CLOT": "VAC-CLOT", "VACUTAINER-EDTA": "VAC-EDTA",
    "VACUTAINER-CIT": "VAC-CIT", "GLASS-SLIDE": "SLIDE",
    "PIPETTE-TIP": "TIP", "URINE-STRIP": "URISTRIP", "TISSUE-ROLL": "TISSUE",
    "COPIER-PAPER": "PAPER", "ESR-PIPETTE": "ESR-PIP", "SOD-CITRATE": "CITRATE",
    "URINE-CONTAINER": "URINE-CON", "BARCODE-LABEL": "LABEL",
    "DROPPER-BOTTLE": "DROPPER", "MICROPIPETTE": "MICROPIP",
    "CLEAN-CLOTH": "CLOTH", "HAND-SANITIZER": "SANITIZER",
    "WASTE-LINER": "LINER", "CHOLESTEROL": "CHOL", "TRIGLYCERIDE": "TRIG",
    "BILI-DIRECT": "BILI-D", "BILI-TOTAL": "BILI-T", "TOT-PROTEIN": "PROTEIN",
    "PROBE-CLEANER": "PROBECLN", "PT-REAGENT": "PT-RGT",
    "APTT-REAGENT": "APTT-RGT", "BIOCHEM-ANALYSER": "BIO-ANLZR",
    "HEMA-ANALYSER": "HEM-ANLZR", "WIFI-ROUTER": "ROUTER",
    "REFRIGERATOR": "FRIDGE", "PULSE-OXIMETER": "OXIMETER",
    "TEMP-MONITOR": "TEMP-MON", "DATA-LOGGER": "LOGGER",
    "BLOOD-MIXER": "MIXER", "BARCODE-SCANNER": "SCANNER",
}


def tag_code(code: str) -> str:
    """Attribute and spec codes are `[A-Za-z0-9_]+` — no hyphens."""
    return code.replace("-", "_")


def ids(rows):
    """{code: id} for a list of (code, ...) rows imported into an empty table."""
    return {row[0]: i for i, row in enumerate(rows, start=1)}


def write(order, path, rows):
    """One workbook, headers straight from the master's schema."""
    defn = DEFS[path]
    columns = columns_for(defn.schema)
    unknown = {k for row in rows for k in row} - set(columns)
    if unknown:
        raise SystemExit(f"{path}: not a column on this master: {sorted(unknown)}")

    book = Workbook()
    sheet = book.active
    sheet.title = "Data"
    sheet.append(columns)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for row in rows:
        sheet.append([row.get(c) for c in columns])
    sheet.freeze_panes = "A2"
    for column in sheet.columns:
        width = max((len(str(c.value)) for c in column if c.value is not None),
                    default=0)
        sheet.column_dimensions[column[0].column_letter].width = min(
            max(width + 2, 12), 50)

    name = f"{order:02d}_{path.replace('-', '_')}.xlsx"
    book.save(os.path.join(OUT, name))
    print(f"{name:32} {len(rows):4} rows")
    return len(rows)


os.makedirs(OUT, exist_ok=True)

# --------------------------------------------------------------------------- #
uom_id = ids(UOM)
hsn_id = {code: i for i, (code, *_) in enumerate(HSN, start=1)}
class_id = ids(ITEM_CLASSES)
subclass_id = {row[1]: i for i, row in enumerate(ITEM_SUB_CLASSES, start=1)}
cat_id = ids(CATEGORIES)
mfr_id = ids(MANUFACTURERS)
brand_id = ids(BRANDS)
general_id = ids(GENERAL_NAMES)
pack_id = ids(PACKAGING)
dosage_id = ids(DOSAGE_FORMS)
attr_id = ids(ATTRIBUTES)
spec_id = ids(SPECS)
feature_id = ids(FEATURES)
item_id = {row[0]: i for i, row in enumerate(ITEMS, start=1)}
vendor_id = ids(VENDORS)
bom_id = ids(BOMS)

tag_id = {"ATTRIBUTE": attr_id, "SPEC": spec_id, "FEATURE": feature_id}

total = 0
total += write(1, "uom", [
    {"code": c, "name": n, "uom_class": k, "is_active": True} for c, n, k in UOM])

total += write(2, "uom-conversions", [
    {"from_uom_id": uom_id[f], "to_uom_id": uom_id[t], "factor": x}
    for f, t, x in UOM_CONVERSIONS])

total += write(3, "hsn-codes", [
    {"code": HSN8[c], "description": d, "cgst_rate": cg, "sgst_rate": sg,
     "igst_rate": ig, "cess_rate": 0, "is_active": True}
    for c, d, cg, sg, ig in HSN])

total += write(4, "item-classes", [
    {"code": c, "name": n, "description": d, "is_active": True}
    for c, n, d in ITEM_CLASSES])

total += write(5, "item-sub-classes", [
    {"item_class_id": class_id[cls], "code": SUBCLASS_CODE.get(c, c), "name": n,
     "description": d, "is_active": True}
    for cls, c, n, d in ITEM_SUB_CLASSES])

total += write(6, "item-categories", [
    {"code": c, "name": n, "parent_id": cat_id[p] if p else None,
     "segment_code": s, "is_active": True}
    for c, n, p, s in CATEGORIES])

total += write(7, "manufacturers", [
    {"code": c, "name": n, "description": d, "is_active": True}
    for c, n, d in MANUFACTURERS])

total += write(8, "brands", [
    {"code": BRAND_CODE.get(c, c), "name": n, "description": d, "is_active": True,
     "manufacturer_ids": ",".join(str(mfr_id[m]) for m in mfrs)}
    for c, n, d, mfrs in BRANDS])

total += write(9, "general-names", [
    {"code": GENERAL_CODE.get(c, c), "name": n, "description": d, "is_active": True}
    for c, n, d in GENERAL_NAMES])

total += write(10, "dosage-forms", [
    {"code": c, "name": n, "description": d, "is_active": True}
    for c, n, d in DOSAGE_FORMS])

total += write(11, "packaging", [
    {"code": c, "name": n, "is_active": True} for c, n in PACKAGING])

total += write(12, "attributes", [
    {"code": tag_code(c), "name": n, "data_type": t,
     "uom_id": uom_id[u] if u else None, "allowed_values": v, "description": d,
     "is_active": True}
    for c, n, t, u, v, d in ATTRIBUTES])

total += write(13, "specs", [
    {"code": tag_code(c), "name": n, "uom_id": uom_id[u] if u else None,
     "description": d, "is_active": True}
    for c, n, u, d in SPECS])

total += write(14, "features", [
    {"code": c, "name": n, "description": d, "affects_handling": h,
     "is_active": True}
    for c, n, d, h in FEATURES])

total += write(15, "category-tags", [
    {"category_id": cat_id[cat], "tag_type": kind, "tag_id": tag_id[kind][code],
     "is_required": req, "is_active": True}
    for cat, kind, code, req in CATEGORY_TAGS])

item_rows = []
for (name, short, cat, gen, brand, mfr, cls, sub, uom, hsn, is_asset,
     extra) in ITEMS:
    item_rows.append({
        "name": name,
        "short_name": short,
        "category_id": cat_id[cat],
        "general_name_id": general_id[gen],
        "brand_id": brand_id[brand],
        "manufacturer_id": mfr_id[mfr],
        "item_class_id": class_id[cls],
        "item_sub_class_id": subclass_id[sub],
        "uom_id": uom_id[uom],
        "hsn_id": hsn_id[hsn],
        "is_asset": is_asset,
        "description": extra.get("desc"),
        "is_batch_tracked": extra.get("batch", False),
        "is_serial_tracked": extra.get("serial", False),
        "is_imei_tracked": False,
        "generate_unit_code": bool(is_asset or extra.get("serial")),
        "has_expiry": extra.get("expiry", False),
        "requires_qi": extra.get("qi", False),
        "dosage_form_id": dosage_id[extra["dosage"]] if extra.get("dosage") else None,
        "valuation_method": "FIFO",
        "requires_special_storage": bool(extra.get("cold") or extra.get("storage")),
        "storage_conditions": extra.get("storage"),
        "requires_special_transport": bool(extra.get("cold")),
        "transport_conditions": ("Cold chain 2-8 degrees Celsius with gel packs."
                                 if extra.get("cold") else None),
        "has_components": False,
        "is_active": True,
    })
total += write(16, "items", item_rows)

total += write(17, "item-packaging", [
    {"item_id": item_id[item], "level": level, "package_id": pack_id[pack],
     "quantity": qty, "is_active": True}
    for item, level, pack, qty in ITEM_PACKAGING])

total += write(18, "vendors", [
    {"code": c, "name": n, "vendor_type": t, "city": city, "state": state,
     "payment_terms_days": days, "is_approved": True, "is_blacklisted": False,
     "is_active": True}
    for c, n, t, city, state, days in VENDORS])

total += write(19, "vendor-items", [
    {"vendor_id": vendor_id[v], "item_id": item_id[i], "lead_time_days": lead,
     "min_order_qty": moq, "is_preferred": pref}
    for v, i, lead, moq, pref in VENDOR_ITEMS])

total += write(20, "boms", [
    {"code": c, "name": n, "description": d, "is_active": True}
    for c, n, d in BOMS])

lines = {}
bom_item_rows = []
for bom, item, qty in BOM_ITEMS:
    lines[bom] = lines.get(bom, 0) + 10
    bom_item_rows.append({"bom_id": bom_id[bom], "item_id": item_id[item],
                          "line_no": lines[bom], "quantity": qty})
total += write(21, "bom-items", bom_item_rows)

total += write(22, "bom-groups", [
    {"bom_id": bom_id[b], "profile_key": key, "remarks": note, "is_active": True}
    for b, key, note in BOM_GROUPS])

print(f"\n{total} rows across 22 workbooks in {OUT}")
