"""Recode every legacy master code to 3 letters (2026-10-15).

The three-letter rule (`shared/masters/short_codes.py`) grandfathers rows saved
before it, so this database still carries hundreds of CAT-*, V-*, full-word and
digit codes. The rule is now strict (no grandfathering), which would freeze all
of those rows on their next edit — so they are recoded first, in one pass.

Scope: the 15 SHORT_CODE_PATHS masters. NOT items (101010-001 keeps its own
scheme), NOT vendors / HSN / warehouses / bins (each has its own fixed shape).

Only LIVE master snapshots are rewritten, matched by integer FK (never by the old
code string): items, brand/manufacturer/general-name links, brand-item mappings,
sub-class class codes, tag codes, attribute mappings, spec JSON keys
(`TYPE:CODE`), packaging/spec/attribute/component/bom/price-list UOM codes,
`uom.uom_class` and bom-group codes. Historical documents keep the code the
paperwork was raised with (frozen at creation, rule 9) — UOM is the only master
with document snapshots and those are deliberately left alone.

    .venv/Scripts/python -m scripts.recode_master_codes          # say what changes
    .venv/Scripts/python -m scripts.recode_master_codes --apply  # and write it

Idempotent: a second run finds no violating code and changes nothing.
"""
import asyncio
import json
import re
import sys

from sqlalchemy import text

from app.core.database import SessionLocal
from app.shared.masters import short_codes

RULE = re.compile(r"[A-Z]{3}")

# master table -> id column (all are `id`)
MASTERS = [
    "mst_item_categories",
    "mst_general_names",
    "mst_brands",
    "mst_manufacturers",
    "mst_item_classes",
    "mst_item_sub_classes",
    "mst_dosage_forms",
    "mst_attributes",
    "mst_specs",
    "mst_features",
    "mst_packaging",
    "mst_uom",
    "mst_uom_classes",
    "mst_boms",
    "mst_vendor_categories",
]

# (consumer table, consumer code column, master table, consumer fk column)
# Every pair joined by integer id — the old code string is never matched on.
CONSUMERS = [
    ("mst_items", "general_name_code", "mst_general_names", "general_name_id"),
    ("mst_brand_general_names", "general_name_code", "mst_general_names", "general_name_id"),
    ("mst_items", "brand_code", "mst_brands", "brand_id"),
    ("mst_brand_manufacturers", "brand_code", "mst_brands", "brand_id"),
    ("mst_brand_general_names", "brand_code", "mst_brands", "brand_id"),
    ("mst_brand_item_mappings", "brand_code", "mst_brands", "brand_id"),
    ("mst_items", "manufacturer_code", "mst_manufacturers", "manufacturer_id"),
    ("mst_brand_manufacturers", "manufacturer_code", "mst_manufacturers", "manufacturer_id"),
    ("mst_items", "item_class_code", "mst_item_classes", "item_class_id"),
    ("mst_item_sub_classes", "item_class_code", "mst_item_classes", "item_class_id"),
    ("mst_items", "item_sub_class_code", "mst_item_sub_classes", "item_sub_class_id"),
    ("mst_items", "dosage_form_code", "mst_dosage_forms", "dosage_form_id"),
    ("mst_items", "uom_code", "mst_uom", "uom_id"),
    ("mst_packaging", "uom_code", "mst_uom", "uom_id"),
    ("mst_item_packaging", "uom_code", "mst_uom", "uom_id"),
    ("mst_item_components", "uom_code", "mst_uom", "uom_id"),
    ("mst_specs", "uom_code", "mst_uom", "uom_id"),
    ("mst_attributes", "uom_code", "mst_uom", "uom_id"),
    ("mst_price_list_items", "uom_code", "mst_uom", "uom_id"),
    ("mst_bom_items", "uom_code", "mst_uom", "uom_id"),
    ("mst_attribute_mappings", "attribute_code", "mst_attributes", "attribute_id"),
    ("mst_bom_groups", "bom_code", "mst_boms", "bom_id"),
]


async def table_columns(db, table: str) -> set[str]:
    rows = await db.execute(
        text("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
             "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t"),
        {"t": table})
    return {r[0] for r in rows.all()}


async def main(apply: bool) -> None:
    async with SessionLocal() as db:
        # Every referenced table/column must exist — a migration that renamed one
        # should stop this script, not silently skip a cascade.
        for table in MASTERS:
            cols = await table_columns(db, table)
            for need in ("id", "code", "name"):
                if need not in cols:
                    raise SystemExit(f"STOP: {table} has no {need} column.")
        for table, code_col, _master, fk_col in CONSUMERS:
            cols = await table_columns(db, table)
            for need in ("id", code_col, fk_col):
                if need not in cols:
                    raise SystemExit(f"STOP: {table} has no {need} column.")

        # --- pass 1: new codes, per table, skipping what already conforms ---
        plans: dict[str, dict[int, tuple[str, str]]] = {}
        for table in MASTERS:
            rows = (await db.execute(
                text(f"SELECT id, code, name FROM {table} ORDER BY id"))).all()
            taken = {(c or "").upper() for _, c, _ in rows}
            plan: dict[int, tuple[str, str]] = {}
            for row_id, code, name in rows:
                if RULE.fullmatch(str(code or "")):
                    continue
                for cand in short_codes.candidates(name or ""):
                    if cand not in taken:
                        plan[row_id] = (code, cand)
                        taken.add(cand)
                        break
                else:
                    raise SystemExit(
                        f"STOP: no free 3-letter code for {table} id={row_id}.")
            plans[table] = plan

        total = sum(len(p) for p in plans.values())
        if total == 0:
            print("Nothing to recode — every master code is 3 letters.")
            return

        for table in MASTERS:
            for row_id, (old, new) in sorted(plans[table].items()):
                print(f"  {table} id={row_id}: {old!r} -> {new}")

        # --- pass 2: write masters, then consumers by integer FK ---
        writes = 0
        for table in MASTERS:
            for row_id, (_old, new) in plans[table].items():
                await db.execute(
                    text(f"UPDATE {table} SET code = :c WHERE id = :i"),
                    {"c": new, "i": row_id})
                writes += 1
        # New-code lookup per master for the cascades below.
        new_code: dict[str, dict[int, str]] = {
            t: {i: n for i, (_o, n) in p.items()} for t, p in plans.items()
        }
        for table, code_col, master, fk_col in CONSUMERS:
            master_plan = new_code[master]
            if not master_plan:
                continue
            for master_id, code in master_plan.items():
                r = await db.execute(
                    text(f"UPDATE {table} SET {code_col} = :c "
                         f"WHERE {fk_col} = :i"),
                    {"c": code, "i": master_id})
                writes += r.rowcount or 0

        # Tag codes follow (tag_type, tag_id), never the code string.
        for tag_type, master in (("ATTRIBUTE", "mst_attributes"),
                                 ("SPEC", "mst_specs"),
                                 ("FEATURE", "mst_features")):
            master_plan = new_code[master]
            if not master_plan:
                continue
            for master_id, code in master_plan.items():
                r = await db.execute(text(
                    "UPDATE mst_category_tags SET tag_code = :c "
                    "WHERE tag_type = :t AND tag_id = :i"),
                    {"c": code, "t": tag_type, "i": master_id})
                writes += r.rowcount or 0
        # Tag UOM codes are re-derived from their target's (new) UOM code.
        for tag_type, target in (("ATTRIBUTE", "mst_attributes"),
                                 ("SPEC", "mst_specs")):
            r = await db.execute(text(
                "UPDATE mst_category_tags t "
                f"JOIN {target} m ON m.id = t.tag_id "
                "SET t.tag_uom_code = m.uom_code "
                "WHERE t.tag_type = :t"),
                {"t": tag_type})
            writes += r.rowcount or 0
        # UOM classes are stored as a code value on mst_uom itself.
        for master_id, code in new_code["mst_uom_classes"].items():
            old = next(o for i, (o, _n) in plans["mst_uom_classes"].items()
                       if i == master_id)
            r = await db.execute(
                text("UPDATE mst_uom SET uom_class = :c WHERE uom_class = :o"),
                {"c": code, "o": old})
            writes += r.rowcount or 0

        # Spec JSON keys are `TYPE:CODE` — remap the code half.
        # NOTE: item specs are keyed by item_id — there is no surrogate id.
        spec_rows = (await db.execute(text(
            "SELECT item_id, specifications FROM mst_item_specs "
            "WHERE specifications IS NOT NULL"))).all()
        for row_id, raw in spec_rows:
            try:
                data = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
            except (ValueError, TypeError):
                print(f"  WARN: mst_item_specs id={row_id}: unparseable, left alone")
                continue
            fixed = {}
            changed = False
            for key, value in data.items():
                new_key = key
                for tag_type, master in (("ATTRIBUTE", "mst_attributes"),
                                         ("SPEC", "mst_specs"),
                                         ("FEATURE", "mst_features")):
                    inv = {o: w for i, (o, w) in plans[master].items()}
                    for old, new in inv.items():
                        if key == f"{tag_type}:{old}":
                            new_key = f"{tag_type}:{new}"
                if new_key != key:
                    changed = True
                fixed[new_key] = value
            if changed:
                await db.execute(
                    text("UPDATE mst_item_specs SET specifications = :s "
                         "WHERE item_id = :i"),
                    {"s": json.dumps(fixed), "i": row_id})
                writes += 1

        if apply:
            await db.commit()
            print(f"\n{total} master code(s) recoded, {writes} row write(s).")
        else:
            await db.rollback()
            print(f"\n{total} master code(s) would change. Nothing written — pass --apply.")


if __name__ == "__main__":
    asyncio.run(main("--apply" in sys.argv))
