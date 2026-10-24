"""Repair mandatory item masters for every existing item.

Covers the three tabs the item form validates:
  Basic          -> 3-level category (L3), generic name, brand, manufacturer,
                    item class + sub-class, owner department
  Units          -> primary UOM (already present, verified)
  Identification -> HSN code (8 digits)

Creates the missing master rows and points every mst_items row at them,
including the brand<->manufacturer and generic<->brand links the save
validates. Idempotent - safe to re-run.

Run from backend/:  .venv/Scripts/python -m scripts.repair_item_masters
"""
import asyncio

from sqlalchemy import select

from app.core.database import SessionLocal
from app.platform.hcm.models import HcmDepartment
from app.shared.models.master import (
    Brand,
    BrandGeneralName,
    BrandManufacturer,
    GeneralName,
    HsnCode,
    Item,
    ItemCategory,
    ItemClass,
    ItemSubClass,
    Manufacturer,
    Uom,
)

# Reuse the catalogue from the demo seed - same 20 items, same masters.
from scripts.seed_demo_items import (
    BRANDS,
    GENERIC_NAMES,
    HSN_CODES,
    ITEM_CLASSES,
    ITEM_SUB_CLASSES,
    MANUFACTURERS,
    UOMS,
    DEMO_ITEMS,
)

# L2/L3 built UNDER the 5 L1 rows already in this database
# (PHARMA, ELEC2, LAB, IT, SAFETY) instead of the seed's HC/TECH/IND tree.
# (l2_code, l2_name, parent_l1_code, [(l3_code, l3_name, [item_codes])])
CATEGORY_TREE = [
    ("PHARMA-MED", "Medicines", "PHARMA", [
        ("PHARMA-MED-TAB", "Tablets & Capsules", ["PHARM-0001", "PHARM-0002"]),
        ("PHARMA-MED-IV", "IV Fluids", ["PHARM-0003"]),
        ("PHARMA-MED-DISP", "Disposables", ["PHARM-0004"]),
    ]),
    ("ELEC2-ELEC", "Electronics & Components", "ELEC2", [
        ("ELEC2-ELEC-MCU", "Boards & Modules", ["ELEC-1001", "ELEC-1002"]),
        ("ELEC2-ELEC-PWR", "Power Supplies", ["ELEC-1003"]),
        ("ELEC2-ELEC-CAB", "Cables & Connectors", ["ELEC-1004"]),
    ]),
    ("LAB-LAB", "Laboratory", "LAB", [
        ("LAB-LAB-INST", "Lab Instruments", ["LAB-2001"]),
        ("LAB-LAB-GLS", "Glassware & Consumables", ["LAB-2002", "LAB-2003"]),
        ("LAB-LAB-REAG", "Reagents & Kits", ["LAB-2004"]),
    ]),
    ("IT-OFF", "IT & Office", "IT", [
        ("IT-OFF-CONS", "IT Consumables", ["IT-3001", "IT-3004"]),
        ("IT-OFF-EQP", "IT Equipment", ["IT-3002", "IT-3003"]),
    ]),
    ("SAFETY-PPE", "Safety & PPE", "SAFETY", [
        ("SAFETY-PPE-RH", "Respiratory & Hand", ["SAFE-4001", "SAFE-4002"]),
        ("SAFETY-PPE-HE", "Head & Eye Protection", ["SAFE-4003", "SAFE-4004"]),
    ]),
]


async def _upsert(db, model, filters: dict, defaults: dict = None):
    row = (await db.execute(select(model).filter_by(**filters))).scalar_one_or_none()
    if row is None:
        row = model(**filters, **(defaults or {}))
        db.add(row)
    elif defaults:
        for k, v in defaults.items():
            setattr(row, k, v)
    await db.flush()
    return row


async def main() -> None:
    async with SessionLocal() as db:
        # 1. UOMs (Units tab) - already 6 rows, top up any missing
        uom_map = {}
        for code, name, cls in UOMS:
            uom_map[code] = await _upsert(
                db, Uom, {"code": code},
                {"name": name, "uom_class": cls, "is_active": True},
            )
        print(f"UOMs: {len(uom_map)} ready")

        # 2. HSN codes (Identification tab)
        hsn_map = {}
        for code, desc, rate in HSN_CODES:
            hsn_map[code] = await _upsert(
                db, HsnCode, {"code": code},
                {"description": desc, "gst_rate": rate, "is_active": True},
            )
        print(f"HSN: {len(hsn_map)} ready")

        # 3. Backfill L1 numeric path/segment so children get 6-digit paths
        # (build_item_prefix requires L3 path = 6 digits).
        l1_rows = (await db.execute(
            select(ItemCategory).where(ItemCategory.level == 1).order_by(ItemCategory.id)
        )).scalars().all()
        for idx, cat in enumerate(l1_rows, start=1):
            seg = f"{idx:02d}"
            if cat.segment_code != seg or cat.path != seg:
                cat.segment_code = seg
                cat.path = seg
        await db.flush()
        l1_by_code = {c.code: c for c in l1_rows}
        print(f"L1 backfilled: {len(l1_rows)}")

        # 4. L2 + L3 under each L1
        l3_by_item_code: dict[str, ItemCategory] = {}
        l2_count = l3_count = 0
        for l2_code, l2_name, parent_code, l3_list in CATEGORY_TREE:
            parent = l1_by_code.get(parent_code)
            if parent is None:
                print(f"  SKIP {l2_code}: L1 {parent_code} not found")
                continue
            # next L2 segment under this parent
            sib2 = (await db.execute(select(ItemCategory).where(
                ItemCategory.parent_id == parent.id))).scalars().all()
            used2 = {c.segment_code for c in sib2 if c.segment_code}
            seg2 = f"{len(sib2):02d}" if f"{len(sib2):02d}" not in used2 else next(
                f"{i:02d}" for i in range(100) if f"{i:02d}" not in used2)
            l2 = await _upsert(
                db, ItemCategory, {"code": l2_code},
                {"name": l2_name, "level": 2, "parent_id": parent.id,
                 "segment_code": seg2, "path": f"{parent.path}{seg2}",
                 "is_active": True},
            )
            l2.segment_code, l2.path = seg2, f"{parent.path}{seg2}"
            l2.parent_id, l2.level = parent.id, 2
            await db.flush()
            l2_count += 1
            for l3_code, l3_name, item_codes in l3_list:
                sib3 = (await db.execute(select(ItemCategory).where(
                    ItemCategory.parent_id == l2.id))).scalars().all()
                used3 = {c.segment_code for c in sib3 if c.segment_code}
                seg3 = next((f"{i:02d}" for i in range(len(sib3), 100)
                             if f"{i:02d}" not in used3), f"{len(sib3):02d}")
                l3 = await _upsert(
                    db, ItemCategory, {"code": l3_code},
                    {"name": l3_name, "level": 3, "parent_id": l2.id,
                     "segment_code": seg3, "path": f"{l2.path}{seg3}",
                     "is_active": True},
                )
                l3.segment_code, l3.path = seg3, f"{l2.path}{seg3}"
                l3.parent_id, l3.level = l2.id, 3
                await db.flush()
                l3_count += 1
                for ic in item_codes:
                    l3_by_item_code[ic] = l3
        print(f"Categories: {l2_count} L2 / {l3_count} L3 ready")

        # 5. Manufacturers / Brands + links / Generic names + links
        mfr_map = {}
        for code, name in MANUFACTURERS:
            mfr_map[code] = await _upsert(
                db, Manufacturer, {"code": code},
                {"name": name, "is_active": True})
        brand_map = {}
        for code, name, mfr_codes in BRANDS:
            brand = await _upsert(
                db, Brand, {"code": code}, {"name": name, "is_active": True})
            brand_map[code] = brand
            for mc in mfr_codes:
                mfr = mfr_map[mc]
                await _upsert(
                    db, BrandManufacturer,
                    {"brand_id": brand.id, "manufacturer_id": mfr.id},
                    {"brand_code": brand.code, "brand_name": brand.name,
                     "manufacturer_code": mfr.code, "manufacturer_name": mfr.name,
                     "is_active": True})
        gen_map = {}
        for code, name, brand_codes in GENERIC_NAMES:
            gen = await _upsert(
                db, GeneralName, {"code": code}, {"name": name, "is_active": True})
            gen_map[code] = gen
            for bc in brand_codes:
                brand = brand_map[bc]
                await _upsert(
                    db, BrandGeneralName,
                    {"general_name_id": gen.id, "brand_id": brand.id},
                    {"general_name_code": gen.code, "general_name_name": gen.name,
                     "brand_code": brand.code, "brand_name": brand.name,
                     "is_active": True})
        print(f"Mfr/Brand/Generic: {len(mfr_map)}/{len(brand_map)}/{len(gen_map)} ready")

        # 6. Item classes / sub-classes
        class_map = {}
        for code, name, cap in ITEM_CLASSES:
            class_map[code] = await _upsert(
                db, ItemClass, {"code": code},
                {"name": name, "is_capitalised": cap, "is_active": True})
        sub_map = {}
        # Live mst_item_sub_classes.code is VARCHAR(10); two seed codes are
        # 11 chars, so they are shortened on write (mapping kept in-memory).
        SUB_FIX = {"CONS-PHARMA": "C-PHARMA", "CONS-OFFICE": "C-OFFICE"}
        for code, name, class_code in ITEM_SUB_CLASSES:
            db_code = SUB_FIX.get(code, code)
            pc = class_map[class_code]
            existing = (await db.execute(select(ItemSubClass).where(
                ItemSubClass.item_class_id == pc.id, ItemSubClass.code == db_code
            ))).scalar_one_or_none()
            if existing is None:
                existing = ItemSubClass(
                    item_class_id=pc.id, code=db_code, name=name,
                    item_class_code=pc.code, item_class_name=pc.name,
                    is_active=True)
                db.add(existing)
            else:
                existing.name = name
                existing.item_class_code, existing.item_class_name = pc.code, pc.name
                existing.is_active = True
            await db.flush()
            sub_map[code] = existing
        print(f"Classes: {len(class_map)} / sub-classes: {len(sub_map)} ready")

        # 7. Owner department (Basic tab, frontend mandatory)
        dept = await db.scalar(select(HcmDepartment).where(
            HcmDepartment.is_active.is_(True)).order_by(HcmDepartment.id))
        if dept is None:
            raise SystemExit("No active hcm_departments row - sync HCM first.")
        print(f"Owner dept: {dept.id} {dept.name!r}")

        # 8. Point every item at its masters
        demo_by_code = {d[0]: d for d in DEMO_ITEMS}
        items = (await db.execute(select(Item).order_by(Item.id))).scalars().all()
        fixed = 0
        for it in items:
            spec = demo_by_code.get(it.code)
            if spec is None:
                print(f"  SKIP {it.code}: not in demo catalogue, left as-is")
                continue
            (_, _, _, uom_code, gen_code, brand_code, mfr_code,
             class_code, sub_code, hsn_code, *_) = spec
            cat = l3_by_item_code.get(it.code)
            gen, brand, mfr = gen_map[gen_code], brand_map[brand_code], mfr_map[mfr_code]
            cls, sub = class_map[class_code], sub_map[sub_code]
            hsn, uom = hsn_map[hsn_code], uom_map[uom_code]
            # links the save validates
            await _upsert(db, BrandManufacturer,
                          {"brand_id": brand.id, "manufacturer_id": mfr.id},
                          {"brand_code": brand.code, "brand_name": brand.name,
                           "manufacturer_code": mfr.code, "manufacturer_name": mfr.name,
                           "is_active": True})
            await _upsert(db, BrandGeneralName,
                          {"general_name_id": gen.id, "brand_id": brand.id},
                          {"general_name_code": gen.code, "general_name_name": gen.name,
                           "brand_code": brand.code, "brand_name": brand.name,
                           "is_active": True})
            it.category_id, it.category_name = cat.id, cat.name
            it.general_name_id, it.general_name_code, it.general_name = gen.id, gen.code, gen.name
            it.brand_id, it.brand_code, it.brand_name = brand.id, brand.code, brand.name
            it.manufacturer_id = mfr.id
            it.manufacturer_code, it.manufacturer_name = mfr.code, mfr.name
            it.item_class_id = cls.id
            it.item_class_code, it.item_class_name = cls.code, cls.name
            it.item_sub_class_id = sub.id
            it.item_sub_class_code, it.item_sub_class_name = sub.code, sub.name
            it.item_type = cls.code
            it.is_asset = bool(getattr(cls, "is_capitalised", False))
            it.uom_id, it.uom_code = uom.id, uom.code
            it.hsn_id, it.hsn_code = hsn.id, hsn.code
            it.owner_department_id = dept.id
            it.owner_department_name = dept.name
            it.is_active = True
            fixed += 1
        await db.commit()
        print(f"Items repaired: {fixed}/{len(items)}")

        # 9. Verify - same checks the item form enforces
        problems = []
        items = (await db.execute(select(Item).order_by(Item.id))).scalars().all()
        for it in items:
            cat = await db.get(ItemCategory, it.category_id) if it.category_id else None
            if cat is None or cat.level != 3:
                problems.append((it.code, "category not L3"))
            for label, val in [("generic", it.general_name_id), ("brand", it.brand_id),
                              ("mfr", it.manufacturer_id), ("class", it.item_class_id),
                              ("subclass", it.item_sub_class_id), ("uom", it.uom_id),
                              ("hsn", it.hsn_id), ("owner dept", it.owner_department_id)]:
                if val is None:
                    problems.append((it.code, f"{label} missing"))
        if problems:
            print("STILL BROKEN:")
            for p in problems:
                print(" ", p)
            raise SystemExit(1)
        print("VERIFY: every item has Basic + Units + Identification masters.")


if __name__ == "__main__":
    asyncio.run(main())
