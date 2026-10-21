"""Complete master seeding for 20 demo items.

Creates EVERY mandatory master the item form requires before an item can be saved:
  • 3-level category hierarchy  (Level 1 → Level 2 → Level 3)
  • Manufacturers
  • Brands   (with Brand→Manufacturer mappings via mst_brand_manufacturers)
  • Generic Names  (with Generic Name→Brand mappings via mst_brand_general_names)
  • Item Classes
  • Item Sub-classes  (one per class)
  • HSN codes
  • UOMs (primary unit per item)
  • HCM ownership department linkage (uses the existing DEPT_STORES from seed.py)

Then creates / updates the 20 items with all those FK columns filled.

Idempotent – safe to re-run.

Usage (from backend/):
    .venv/Scripts/python -m scripts.seed_demo_items
    .venv/Scripts/python -m scripts.seed_demo_items --allow-remote
"""
import asyncio
import sys

from sqlalchemy import select
from sqlalchemy.engine import make_url

from app.core.database import SessionLocal, settings
from app.shared.models.master import (
    Brand, BrandGeneralName, BrandManufacturer,
    GeneralName, HsnCode, Item, ItemCategory,
    ItemClass, ItemSubClass, Manufacturer, Uom,
)

# ─────────────────────────────────────────────────────────────────────────────
# Safety guard
# ─────────────────────────────────────────────────────────────────────────────
LOOPBACK_HOSTS = {"", "localhost", "127.0.0.1", "::1"}


def _refuse_remote(allow_remote: bool) -> None:
    url = make_url(settings.DATABASE_URL)
    host = (url.host or "").lower()
    if host in LOOPBACK_HOSTS or allow_remote:
        return
    raise SystemExit(
        f"\nRefusing to seed: {url.database!r} on {host} is not a local database.\n"
        "Pass --allow-remote if you genuinely mean to seed this database.\n"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Generic helpers
# ─────────────────────────────────────────────────────────────────────────────
async def _upsert(db, model, filters: dict, defaults: dict = None):
    """Fetch-or-create then update every default field on the row."""
    row = (await db.execute(select(model).filter_by(**filters))).scalar_one_or_none()
    if row is None:
        row = model(**filters, **(defaults or {}))
        db.add(row)
    elif defaults:
        for k, v in defaults.items():
            setattr(row, k, v)
    await db.flush()
    return row


# ─────────────────────────────────────────────────────────────────────────────
# Master catalogue definitions
# ─────────────────────────────────────────────────────────────────────────────

# ── UOMs ─────────────────────────────────────────────────────────────────────
# (code, name, uom_class)
UOMS = [
    ("NOS",  "Numbers",  "COUNT"),
    ("SET",  "Set",      "COUNT"),
    ("PKT",  "Packet",   "PACKAGING"),
    ("BOX",  "Box",      "PACKAGING"),
    ("KG",   "Kilogram", "WEIGHT"),
    ("MTR",  "Metre",    "LENGTH"),
    ("LTR",  "Litre",    "VOLUME"),
]

# ── HSN Codes ─────────────────────────────────────────────────────────────────
# (code, description, gst_rate)
HSN_CODES = [
    ("30049099", "Medicaments – other",                           12.0),
    ("30059010", "Absorbent cotton / medical dressings",           5.0),
    ("90183990", "Medical instruments – other",                   12.0),
    ("85176290", "Network & communication equipment",             18.0),
    ("85444299", "Insulated electric cables with connectors",     18.0),
    ("90278090", "Instruments for physical/chemical analysis",    18.0),
    ("84433210", "Printers",                                      18.0),
    ("85235200", "Smart cards and SIM cards",                     18.0),
    ("84185000", "Refrigerating or freezing equipment",           18.0),
    ("96082000", "Felt-tipped pens and markers",                  18.0),
    ("38089490", "Disinfectants",                                 18.0),
    ("00000000", "Pending HSN classification",                     0.0),
]

# ── 3-level category hierarchy ─────────────────────────────────────────────
# Level 1  (code, name)
CATS_L1 = [
    ("HC",   "Healthcare"),
    ("TECH", "Technology"),
    ("IND",  "Industrial"),
]

# Level 2  (code, name, parent_l1_code)
CATS_L2 = [
    ("HC-PHARM",  "Pharmaceuticals",              "HC"),
    ("HC-MEDS",   "Medical Devices & Supplies",   "HC"),
    ("TECH-ELEC", "Electronics & Components",     "TECH"),
    ("TECH-IT",   "IT & Office Equipment",        "TECH"),
    ("TECH-LAB",  "Laboratory Equipment",         "TECH"),
    ("IND-SAFE",  "Safety & PPE",                 "IND"),
]

# Level 3  (code, name, parent_l2_code)
CATS_L3 = [
    # Under HC-PHARM
    ("HC-PHARM-OTC",  "OTC Medicines",              "HC-PHARM"),
    ("HC-PHARM-RX",   "Prescription Medicines",     "HC-PHARM"),
    # Under HC-MEDS
    ("HC-MEDS-DISP",  "Disposables",                "HC-MEDS"),
    ("HC-MEDS-DIAG",  "Diagnostic Equipment",       "HC-MEDS"),
    # Under TECH-ELEC
    ("TECH-ELEC-MCU", "Microcontrollers & SBCs",    "TECH-ELEC"),
    ("TECH-ELEC-PWR", "Power Supplies",             "TECH-ELEC"),
    ("TECH-ELEC-CAB", "Cables & Connectors",        "TECH-ELEC"),
    # Under TECH-IT
    ("TECH-IT-PRPH",  "Peripherals & Accessories",  "TECH-IT"),
    ("TECH-IT-DISP",  "Displays & Monitors",        "TECH-IT"),
    ("TECH-IT-CONS",  "IT Consumables",             "TECH-IT"),
    # Under TECH-LAB
    ("TECH-LAB-INST", "Lab Instruments",            "TECH-LAB"),
    ("TECH-LAB-CONS", "Lab Consumables & Reagents", "TECH-LAB"),
    # Under IND-SAFE
    ("IND-SAFE-RESP", "Respiratory Protection",     "IND-SAFE"),
    ("IND-SAFE-HAND", "Hand Protection",            "IND-SAFE"),
    ("IND-SAFE-HEAD", "Head Protection",            "IND-SAFE"),
    ("IND-SAFE-EYE",  "Eye & Face Protection",      "IND-SAFE"),
]

# ── Manufacturers  (code, name) ───────────────────────────────────────────────
MANUFACTURERS = [
    ("MFR-GSK",  "GlaxoSmithKline Pharmaceuticals Ltd"),
    ("MFR-ABT",  "Abbott India Ltd"),
    ("MFR-BD",   "Becton Dickinson India Pvt Ltd"),
    ("MFR-ARDI", "Arduino LLC"),
    ("MFR-RPI",  "Raspberry Pi Foundation"),
    ("MFR-MNW",  "Mean Well Enterprises Co Ltd"),
    ("MFR-NXN",  "Nexans India Ltd"),
    ("MFR-HP",   "HP India Sales Pvt Ltd"),
    ("MFR-LOGI", "Logitech India Pvt Ltd"),
    ("MFR-LG",   "LG Electronics India Pvt Ltd"),
    ("MFR-JA",   "JK Paper Ltd"),
    ("MFR-3M",   "3M India Ltd"),
    ("MFR-HON",  "Honeywell Safety Products India"),
    ("MFR-KOR",  "Korelab Instruments Pvt Ltd"),
    ("MFR-BRS",  "Borosil Scientific Ltd"),
    ("MFR-QGN",  "Qiagen India Pvt Ltd"),
]

# ── Brands  (code, name, [manufacturer_codes]) ───────────────────────────────
BRANDS = [
    ("AUGMENTIN", "Augmentin",            ["MFR-GSK"]),
    ("CALPOL",    "Calpol",               ["MFR-GSK"]),
    ("ABBOTT",    "Abbott",               ["MFR-ABT"]),
    ("BD",        "BD (Becton Dickinson)", ["MFR-BD"]),
    ("ARDUINO",   "Arduino",              ["MFR-ARDI"]),
    ("RASPPI",    "Raspberry Pi",         ["MFR-RPI"]),
    ("MEANWELL",  "Mean Well",            ["MFR-MNW"]),
    ("NEXANS",    "Nexans",               ["MFR-NXN"]),
    ("HP",        "HP",                   ["MFR-HP"]),
    ("LOGITECH",  "Logitech",             ["MFR-LOGI"]),
    ("LG",        "LG",                   ["MFR-LG"]),
    ("JKPAPER",   "JK Paper",             ["MFR-JA"]),
    ("3M",        "3M",                   ["MFR-3M"]),
    ("HONEYWELL", "Honeywell Safety",     ["MFR-HON"]),
    ("KORELAB",   "Korelab",              ["MFR-KOR"]),
    ("BOROSIL",   "Borosil",              ["MFR-BRS"]),
    ("QIAGEN",    "Qiagen",               ["MFR-QGN"]),
]

# ── Generic Names  (code, name, [brand_codes]) ────────────────────────────────
GENERIC_NAMES = [
    ("GEN-PARA",   "Paracetamol 500mg Tablet",          ["CALPOL", "ABBOTT"]),
    ("GEN-AMOXI",  "Amoxicillin 250mg Capsule",         ["AUGMENTIN", "ABBOTT"]),
    ("GEN-SALINE", "Sterile Normal Saline 500ml",       ["BD", "ABBOTT"]),
    ("GEN-SYRNG",  "Surgical Disposable Syringe 5ml",  ["BD"]),
    ("GEN-ARDUNO", "Microcontroller Development Board", ["ARDUINO"]),
    ("GEN-SBC",    "Single Board Computer",             ["RASPPI"]),
    ("GEN-SMPS",   "SMPS Power Supply",                 ["MEANWELL"]),
    ("GEN-CAT6",   "CAT6 UTP Network Cable",            ["NEXANS"]),
    ("GEN-TONER",  "Laser Printer Toner Cartridge",     ["HP"]),
    ("GEN-KBD",    "Wireless Keyboard and Mouse Combo", ["LOGITECH"]),
    ("GEN-MON",    "Full HD LED Monitor",               ["LG"]),
    ("GEN-PAPER",  "Copier Paper A4 80gsm",             ["JKPAPER"]),
    ("GEN-N95",    "N95 Respirator Mask",               ["3M", "HONEYWELL"]),
    ("GEN-NITRL","Nitrile Examination Gloves",        ["3M", "HONEYWELL"]),
    ("GEN-HELMET", "Industrial Safety Helmet",          ["HONEYWELL"]),
    ("GEN-GOGGLE", "Safety Goggles Anti-fog",           ["3M", "HONEYWELL"]),
    ("GEN-THERMO", "Digital Laboratory Thermometer",    ["KORELAB"]),
    ("GEN-BEAKER", "Laboratory Beaker Borosilicate",    ["BOROSIL"]),
    ("GEN-SLIDE",  "Microscope Slide Cover Slips",      ["BOROSIL"]),
    ("GEN-PCR",    "PCR Reaction Buffer Kit",           ["QIAGEN"]),
]

# ── Item Classes  (code, name, is_capitalised) ────────────────────────────────
ITEM_CLASSES = [
    ("CONSUMABLE", "Consumable",    False),
    ("CAPITAL",    "Capital Asset", True),
    ("SPARE",      "Spare Part",    False),
    ("REAGENT",    "Reagent",       False),
    ("PPE",        "PPE / Safety",  False),
]

# ── Item Sub-classes  (code, name, item_class_code) ───────────────────────────
ITEM_SUB_CLASSES = [
    ("CONS-PHARMA", "Pharma Consumable",    "CONSUMABLE"),
    ("CONS-OFFICE", "Office Consumable",    "CONSUMABLE"),
    ("CONS-LAB",    "Lab Consumable",       "CONSUMABLE"),
    ("CONS-CABLE",  "Cable & Wiring",       "CONSUMABLE"),
    ("CAP-ELEC",    "Electronic Equipment", "CAPITAL"),
    ("CAP-IT",      "IT Equipment",         "CAPITAL"),
    ("CAP-INSTR",   "Lab Instrument",       "CAPITAL"),
    ("CAP-PPE",     "Reusable PPE",         "CAPITAL"),
    ("SPARE-PWR",   "Power Component",      "SPARE"),
    ("REAG-PCR",    "PCR / Molecular",      "REAGENT"),
    ("PPE-RESP",    "Respiratory PPE",      "PPE"),
    ("PPE-HAND",    "Hand Protection PPE",  "PPE"),
    ("PPE-EYE",     "Eye Protection PPE",   "PPE"),
]

# ── The 20 items ──────────────────────────────────────────────────────────────
# Tuple layout:
#   (item_code, name, cat_l3_code, uom_code,
#    generic_name_code, brand_code, manufacturer_code,
#    item_class_code, sub_class_code,
#    hsn_code, purchase_price,
#    has_expiry, is_batch_tracked, is_serial_tracked, requires_qi,
#    safety_stock, reorder_level, reorder_qty, lead_time_days)
DEMO_ITEMS = [
    # ── PHARMA ───────────────────────────────────────────────────────────────
    ("PHARM-0001", "Paracetamol 500mg Tablet (Strip of 10)",
     "HC-PHARM-OTC",  "PKT",
     "GEN-PARA",   "CALPOL",    "MFR-GSK",
     "CONSUMABLE", "CONS-PHARMA",
     "30049099", 18.50,  True,  True,  False, True,   50, 100, 200, 7),

    ("PHARM-0002", "Amoxicillin 250mg Capsule (Bottle 100)",
     "HC-PHARM-RX",   "NOS",
     "GEN-AMOXI",  "AUGMENTIN", "MFR-GSK",
     "CONSUMABLE", "CONS-PHARMA",
     "30049099", 120.00, True,  True,  False, True,   20,  50, 100, 10),

    ("PHARM-0003", "Sterile Normal Saline 500ml IV Bag",
     "HC-MEDS-DISP",  "NOS",
     "GEN-SALINE", "BD",        "MFR-BD",
     "CONSUMABLE", "CONS-PHARMA",
     "30049099", 45.00,  True,  True,  False, True,   30,  60, 120, 5),

    ("PHARM-0004", "Surgical Disposable Syringe 5ml (Box 100)",
     "HC-MEDS-DISP",  "BOX",
     "GEN-SYRNG",  "BD",        "MFR-BD",
     "CONSUMABLE", "CONS-PHARMA",
     "30059010", 350.00, True,  True,  False, True,   10,  25,  50, 7),

    # ── ELECTRONICS ──────────────────────────────────────────────────────────
    ("ELEC-1001", "Arduino Uno R3 Microcontroller Board",
     "TECH-ELEC-MCU", "NOS",
     "GEN-ARDUNO", "ARDUINO",   "MFR-ARDI",
     "CAPITAL",    "CAP-ELEC",
     "85176290", 850.00, False, False, True,  False,  5,  10,  20, 14),

    ("ELEC-1002", "Raspberry Pi 4 Model B 4GB",
     "TECH-ELEC-MCU", "NOS",
     "GEN-SBC",    "RASPPI",    "MFR-RPI",
     "CAPITAL",    "CAP-ELEC",
     "85176290", 4500.00, False, False, True,  False,  3,   5,  10, 21),

    ("ELEC-1003", "12V 10A SMPS Power Supply",
     "TECH-ELEC-PWR", "NOS",
     "GEN-SMPS",   "MEANWELL",  "MFR-MNW",
     "SPARE",      "SPARE-PWR",
     "85444299", 1200.00, False, False, True,  False,  5,  10,  15, 10),

    ("ELEC-1004", "CAT6 UTP Cable (Box 305m)",
     "TECH-ELEC-CAB", "BOX",
     "GEN-CAT6",   "NEXANS",    "MFR-NXN",
     "CONSUMABLE", "CONS-CABLE",
     "85444299", 2800.00, False, False, False, False,  2,   4,   5, 7),

    # ── LAB EQUIPMENT ────────────────────────────────────────────────────────
    ("LAB-2001", "Digital Laboratory Thermometer",
     "TECH-LAB-INST", "NOS",
     "GEN-THERMO", "KORELAB",   "MFR-KOR",
     "CAPITAL",    "CAP-INSTR",
     "90278090", 650.00, False, False, True,  False,  2,   4,   5, 14),

    ("LAB-2002", "Glass Beaker 500ml Borosilicate",
     "TECH-LAB-CONS", "NOS",
     "GEN-BEAKER", "BOROSIL",   "MFR-BRS",
     "CONSUMABLE", "CONS-LAB",
     "90278090", 85.00,  False, False, False, False, 10,  20,  50, 7),

    ("LAB-2003", "Microscope Slide Cover Slips (Box 100)",
     "TECH-LAB-CONS", "BOX",
     "GEN-SLIDE",  "BOROSIL",   "MFR-BRS",
     "CONSUMABLE", "CONS-LAB",
     "90278090", 120.00, False, True,  False, False,  5,  10,  30, 5),

    ("LAB-2004", "PCR Reaction Buffer Kit 10x 1ml",
     "TECH-LAB-CONS", "NOS",
     "GEN-PCR",    "QIAGEN",    "MFR-QGN",
     "REAGENT",    "REAG-PCR",
     "38089490", 2200.00, True, True,  False, True,   3,   6,  10, 14),

    # ── IT / OFFICE EQUIPMENT ─────────────────────────────────────────────────
    ("IT-3001", "HP LaserJet Toner Cartridge 85A",
     "TECH-IT-CONS",  "NOS",
     "GEN-TONER",  "HP",        "MFR-HP",
     "CONSUMABLE", "CONS-OFFICE",
     "84433210", 1800.00, False, False, False, False,  3,   5,  10, 7),

    ("IT-3002", "Logitech Wireless Keyboard and Mouse Combo",
     "TECH-IT-PRPH",  "SET",
     "GEN-KBD",    "LOGITECH",  "MFR-LOGI",
     "CAPITAL",    "CAP-IT",
     "85235200", 1200.00, False, False, True,  False,  2,   5,  10, 10),

    ("IT-3003", "27-inch Full HD LED Monitor",
     "TECH-IT-DISP",  "NOS",
     "GEN-MON",    "LG",        "MFR-LG",
     "CAPITAL",    "CAP-IT",
     "84185000", 15000.00, False, False, True,  False,  1,   2,   3, 21),

    ("IT-3004", "A4 80gsm Copier Paper (Ream 500 Sheets)",
     "TECH-IT-CONS",  "NOS",
     "GEN-PAPER",  "JKPAPER",   "MFR-JA",
     "CONSUMABLE", "CONS-OFFICE",
     "96082000", 350.00, False, False, False, False, 10,  20,  50, 3),

    # ── SAFETY / PPE ─────────────────────────────────────────────────────────
    ("SAFE-4001", "3M 8210 N95 Respirator Mask (Box 20)",
     "IND-SAFE-RESP", "BOX",
     "GEN-N95",    "3M",        "MFR-3M",
     "PPE",        "PPE-RESP",
     "30059010", 950.00, True,  True,  False, True,   5,  10,  20, 7),

    ("SAFE-4002", "Chemical Resistant Nitrile Gloves L (Box 100)",
     "IND-SAFE-HAND", "BOX",
     "GEN-NITRL","HONEYWELL", "MFR-HON",
     "PPE",        "PPE-HAND",
     "30059010", 480.00, True,  True,  False, False,  5,  10,  25, 5),

    ("SAFE-4003", "Industrial Safety Helmet (ISI Marked)",
     "IND-SAFE-HEAD", "NOS",
     "GEN-HELMET", "HONEYWELL", "MFR-HON",
     "CAPITAL",    "CAP-PPE",
     "00000000", 450.00, False, False, False, False,  5,  10,  20, 10),

    ("SAFE-4004", "Safety Goggles Anti-fog Wrap-around",
     "IND-SAFE-EYE",  "NOS",
     "GEN-GOGGLE", "3M",        "MFR-3M",
     "PPE",        "PPE-EYE",
     "38089490", 180.00, False, False, False, False, 10,  20,  40, 7),
]


# ─────────────────────────────────────────────────────────────────────────────
# Main seed
# ─────────────────────────────────────────────────────────────────────────────
async def seed(*, allow_remote: bool = False) -> None:  # noqa: C901
    _refuse_remote(allow_remote)

    async with SessionLocal() as db:

        # ── 1. UOMs ──────────────────────────────────────────────────────────
        uom_map: dict[str, Uom] = {}
        for code, name, cls in UOMS:
            uom_map[code] = await _upsert(
                db, Uom, {"code": code},
                {"name": name, "uom_class": cls, "is_active": True},
            )
        print(f"  UOMs:          {len(uom_map)} ready")

        # ── 2. HSN codes ──────────────────────────────────────────────────────
        hsn_map: dict[str, HsnCode] = {}
        for code, desc, rate in HSN_CODES:
            hsn_map[code] = await _upsert(
                db, HsnCode, {"code": code},
                {"description": desc, "gst_rate": rate, "is_active": True},
            )
        print(f"  HSN codes:     {len(hsn_map)} ready")

        # ── 3. 3-level category hierarchy ────────────────────────────────────
        cat_map: dict[str, ItemCategory] = {}

        for code, name in CATS_L1:
            cat_map[code] = await _upsert(
                db, ItemCategory, {"code": code},
                {"name": name, "level": 1, "path": code,
                 "parent_id": None, "is_active": True},
            )

        for code, name, parent_code in CATS_L2:
            parent = cat_map[parent_code]
            cat_map[code] = await _upsert(
                db, ItemCategory, {"code": code},
                {"name": name, "level": 2,
                 "path": f"{parent.path}/{code}",
                 "parent_id": parent.id, "is_active": True},
            )

        for code, name, parent_code in CATS_L3:
            parent = cat_map[parent_code]
            cat_map[code] = await _upsert(
                db, ItemCategory, {"code": code},
                {"name": name, "level": 3,
                 "path": f"{parent.path}/{code}",
                 "parent_id": parent.id, "is_active": True},
            )

        total_cats = len(CATS_L1) + len(CATS_L2) + len(CATS_L3)
        print(f"  Categories:    {total_cats} ready  "
              f"({len(CATS_L1)} L1 / {len(CATS_L2)} L2 / {len(CATS_L3)} L3)")

        # ── 4. Manufacturers ─────────────────────────────────────────────────
        mfr_map: dict[str, Manufacturer] = {}
        for code, name in MANUFACTURERS:
            mfr_map[code] = await _upsert(
                db, Manufacturer, {"code": code},
                {"name": name, "is_active": True},
            )
        print(f"  Manufacturers: {len(mfr_map)} ready")

        # ── 5. Brands + Brand→Manufacturer mappings ───────────────────────────
        brand_map: dict[str, Brand] = {}
        for code, name, mfr_codes in BRANDS:
            brand = await _upsert(
                db, Brand, {"code": code},
                {"name": name, "is_active": True},
            )
            brand_map[code] = brand
            for mfr_code in mfr_codes:
                mfr = mfr_map[mfr_code]
                await _upsert(
                    db, BrandManufacturer,
                    {"brand_id": brand.id, "manufacturer_id": mfr.id},
                    {"brand_code": brand.code, "brand_name": brand.name,
                     "manufacturer_code": mfr.code, "manufacturer_name": mfr.name,
                     "is_active": True},
                )
        print(f"  Brands:        {len(brand_map)} ready  (with manufacturer mappings)")

        # ── 6. Generic Names + Generic Name→Brand mappings ───────────────────
        gen_map: dict[str, GeneralName] = {}
        for code, name, brand_codes in GENERIC_NAMES:
            gen = await _upsert(
                db, GeneralName, {"code": code},
                {"name": name, "is_active": True},
            )
            gen_map[code] = gen
            for brand_code in brand_codes:
                brand = brand_map[brand_code]
                await _upsert(
                    db, BrandGeneralName,
                    {"general_name_id": gen.id, "brand_id": brand.id},
                    {"general_name_code": gen.code,
                     "general_name_name": gen.name,
                     "brand_code": brand.code,
                     "brand_name": brand.name,
                     "is_active": True},
                )
        print(f"  Generic Names: {len(gen_map)} ready  (with brand mappings)")

        # ── 7. Item Classes ───────────────────────────────────────────────────
        class_map: dict[str, ItemClass] = {}
        for code, name, capitalised in ITEM_CLASSES:
            class_map[code] = await _upsert(
                db, ItemClass, {"code": code},
                {"name": name, "is_capitalised": capitalised, "is_active": True},
            )
        print(f"  Item Classes:  {len(class_map)} ready")

        # ── 8. Item Sub-classes ───────────────────────────────────────────────
        sub_map: dict[str, ItemSubClass] = {}
        for code, name, class_code in ITEM_SUB_CLASSES:
            parent_class = class_map[class_code]
            sub_map[code] = await _upsert(
                db, ItemSubClass,
                {"item_class_id": parent_class.id, "code": code},
                {"name": name,
                 "item_class_code": parent_class.code,
                 "item_class_name": parent_class.name,
                 "is_active": True},
            )
        print(f"  Sub-classes:   {len(sub_map)} ready")

        # ── 9. Items — create / update with all FKs filled ───────────────────
        created_count = 0
        updated_count = 0

        for (
            item_code, item_name, cat_l3_code, uom_code,
            gen_code, brand_code, mfr_code,
            class_code, sub_code,
            hsn_code, purchase_price,
            has_expiry, is_batch_tracked, is_serial_tracked, requires_qi,
            safety_stock, reorder_level, reorder_qty, lead_time_days,
        ) in DEMO_ITEMS:
            cat   = cat_map[cat_l3_code]
            uom   = uom_map[uom_code]
            gen   = gen_map[gen_code]
            brand = brand_map[brand_code]
            mfr   = mfr_map[mfr_code]
            cls   = class_map[class_code]
            sub   = sub_map[sub_code]
            hsn   = hsn_map[hsn_code]

            existing = (await db.execute(
                select(Item).where(Item.code == item_code)
            )).scalar_one_or_none()

            attrs = dict(
                name=item_name,
                category_id=cat.id,
                category_name=cat.name,
                uom_id=uom.id,
                uom_code=uom_code,
                general_name_id=gen.id,
                general_name_code=gen.code,
                general_name=gen.name,
                brand_id=brand.id,
                brand_code=brand.code,
                brand_name=brand.name,
                manufacturer_id=mfr.id,
                manufacturer_code=mfr.code,
                manufacturer_name=mfr.name,
                item_class_id=cls.id,
                item_class_code=cls.code,
                item_class_name=cls.name,
                item_sub_class_id=sub.id,
                item_sub_class_code=sub.code,
                item_sub_class_name=sub.name,
                hsn_id=hsn.id,
                hsn_code=hsn_code,
                purchase_price=purchase_price,
                has_expiry=has_expiry,
                is_batch_tracked=is_batch_tracked,
                is_serial_tracked=is_serial_tracked,
                requires_qi=requires_qi,
                safety_stock=safety_stock,
                reorder_level=reorder_level,
                reorder_qty=reorder_qty,
                lead_time_days=lead_time_days,
                valuation_method="FIFO",
                is_active=True,
            )

            if existing is None:
                db.add(Item(code=item_code, **attrs))
                created_count += 1
            else:
                for k, v in attrs.items():
                    setattr(existing, k, v)
                updated_count += 1

            await db.flush()

        await db.commit()

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n  Items: created={created_count}  updated={updated_count}\n")
    print("  %-12s %-16s %-16s %-12s  %s"
          % ("CODE", "CATEGORY L3", "GENERIC NAME", "BRAND", "NAME"))
    print("  " + "-" * 90)
    for (code, name, cat, uom, gen, brand, *_) in DEMO_ITEMS:
        print("  %-12s %-16s %-16s %-12s  %s" % (code, cat, gen, brand, name))
    print()


if __name__ == "__main__":
    asyncio.run(seed(allow_remote="--allow-remote" in sys.argv))
