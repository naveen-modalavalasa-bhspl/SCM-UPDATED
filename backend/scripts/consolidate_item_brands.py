"""Consolidate items that share one code into ONE item, and give every item's old
stock its brand (2026-10-23).

Until 2026-10-23 another brand of an item was saved as a second `mst_items` row with
the SAME code (`brand_id` on the row). Every master then listed the code once per
brand, and each row held its own stock, ledger and documents. Since then an item is
ONE row, its brands are mappings, and stock and document lines carry the brand /
variant / model they are (`mst_item_combinations`).

For every code held by more than one item row, this script:

  1. keeps the OLDEST active row (the survivor); its name, category and HSN win;
  2. combines the tracking flags — tracked if any row was tracked;
  3. maps every row's brand onto the survivor;
  4. moves every document line, ledger row, reservation, batch, unit and pack to the
     survivor, tagging each row with the brand of the item row it came from (a row
     with no brand stays untagged);
  5. merges stock rows that land on the same lot (item, point, location, batch,
     project, brand) — quantities added, reservations and holds moved onto the kept
     row;
  6. gives a unit whose serial already exists on the survivor a suffix
     ("SN123-BETA", or "SN123-2" with no brand) so a scan is never ambiguous;
  7. moves the item masters: packing ladders (a clashing name gets the brand),
     vendor mappings (one per vendor), specs, groups, eligibility, price lists;
  8. retires the other rows (inactive, never deleted).

For EVERY item, merged or not: the old `brand_id` becomes a mapping, and when the
item has exactly one brand its untagged stock and lines are tagged with it.

Accuracy: before a code is touched, the script counts its stock (total, available,
reserved per point), ledger (in and out per point), units (per point, location,
batch and status), reservations (per document line), holds, and the row count of
every document table. It merges, counts again, and keeps the code ONLY if every
figure is identical. Otherwise that code is rolled back and reported with the
figure that differed. Each code runs in its own savepoint.

Run (from backend/, after `alembic upgrade head` and bootstrap, with a backup taken):

    .venv/Scripts/python -m scripts.consolidate_item_brands              # preview
    .venv/Scripts/python -m scripts.consolidate_item_brands --apply      # save
    .venv/Scripts/python -m scripts.consolidate_item_brands --code X     # one code
    ... --report consolidation.json                                      # full report

Re-runnable: a code already merged is one row and is skipped; stock already tagged
is left alone.
"""
from __future__ import annotations

import argparse
import asyncio
import json
from collections import defaultdict
from decimal import Decimal

from sqlalchemy import bindparam, text

from app.core.database import SessionLocal
from app.shared.masters import combinations

ZERO = Decimal("0")

#: Handled by hand, never by the generic "move item_id" pass.
SPECIAL = {
    "stk_balance", "mst_brand_item_mappings", "mst_item_combinations", "mst_item_specs",
    "mst_pack_hierarchies", "mst_vendor_items", "whs_serial_numbers",
    "mst_item_groups", "mst_item_eligibility", "mst_price_list_items",
}
#: Master tables keyed (item, …) — a sibling row whose key the survivor already has
#: is a duplicate and is dropped; the rest move.
DEDUP_KEYS = {
    "mst_item_groups": ("group_id",),
    "mst_item_eligibility": ("scope_type", "scope_id"),
    "mst_price_list_items": ("price_list_id", "min_qty"),
}
#: Item references not named `item_id`.
EXTRA_REFS = (("mst_boms", "parent_item_id"), ("mst_item_components", "component_item_id"))
#: Master tables whose row count legitimately changes (duplicates dropped).
MASTER_TABLES = {"mst_brand_item_mappings", "mst_item_combinations", "mst_item_specs",
                 "mst_vendor_items", *DEDUP_KEYS}
FLAGS = ("is_serial_tracked", "is_imei_tracked", "is_batch_tracked", "has_expiry",
         "requires_qi")
QTY = ("total_qty", "available_qty", "reserved_qty", "transit_qty", "stock_value")


#: Set from the live schema in `run`.
HAS_HOLDS = False


class CheckFailed(Exception):
    pass


def _d(value) -> Decimal:
    return Decimal(str(value)) if value is not None else ZERO


# ------------------------------------------------------------------ the schema --

class Schema:
    """Which tables point at an item, read off the live database — so a deployment
    whose schema differs from this checkout is handled as it actually is."""

    def __init__(self, columns: dict[str, set[str]]):
        self.columns = columns
        self.item_tables = sorted(t for t, cols in columns.items()
                                  if "item_id" in cols and t != "mst_items")
        self.branded = [t for t in self.item_tables
                        if "brand_id" in columns[t] and t not in SPECIAL]
        self.plain = [t for t in self.item_tables
                      if "brand_id" not in columns[t] and t not in SPECIAL]
        self.extra = [(t, c) for t, c in EXTRA_REFS if c in columns.get(t, set())]

    def has(self, table: str, column: str) -> bool:
        return column in self.columns.get(table, set())


async def load_schema(db) -> Schema:
    rows = (await db.execute(text(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_schema = DATABASE()"))).all()
    columns: dict[str, set[str]] = defaultdict(set)
    for table, column in rows:
        columns[table].add(column)
    return Schema(columns)


def _in(ids) -> tuple[str, dict]:
    return "IN :ids", {"ids": list(ids)}


async def _rows(db, sql: str, params: dict | None = None, expand: tuple = ()):
    stmt = text(sql)
    if expand:
        stmt = stmt.bindparams(*[bindparam(name, expanding=True) for name in expand])
    return (await db.execute(stmt, params or {})).all()


async def _exec(db, sql: str, params: dict | None = None, expand: tuple = ()):
    stmt = text(sql)
    if expand:
        stmt = stmt.bindparams(*[bindparam(name, expanding=True) for name in expand])
    return await db.execute(stmt, params or {})


# ------------------------------------------------------------------ the counts --

async def snapshot(db, schema: Schema, ids: list[int]) -> dict:
    """Every figure that must be identical before and after. Keyed so the before
    (over every row of the code) and the after (over the survivor) compare as-is."""
    out: dict[str, dict] = {}
    p = {"ids": ids}
    ex = ("ids",)

    out["stock"] = {f"{w}": tuple(_d(v) for v in rest) for w, *rest in await _rows(
        db, "SELECT warehouse_id, SUM(total_qty), SUM(available_qty), SUM(reserved_qty), "
            "SUM(COALESCE(transit_qty,0)) FROM stk_balance WHERE item_id IN :ids "
            "GROUP BY warehouse_id", p, ex)}
    out["ledger"] = {f"{w}|{d}": (_d(q), int(n)) for w, d, q, n in await _rows(
        db, "SELECT warehouse_id, direction, SUM(quantity), COUNT(*) FROM stk_ledger "
            "WHERE item_id IN :ids GROUP BY warehouse_id, direction", p, ex)}
    if "whs_serial_numbers" in schema.columns:
        out["units"] = {f"{w}|{b}|{bt}|{s}|{a}": int(n) for w, b, bt, s, a, n in await _rows(
            db, "SELECT warehouse_id, COALESCE(bin_id,0), COALESCE(batch_id,0), status, "
                "is_active, COUNT(*) FROM whs_serial_numbers WHERE item_id IN :ids "
                "GROUP BY warehouse_id, COALESCE(bin_id,0), COALESCE(batch_id,0), status, "
                "is_active", p, ex)}
    out["reservations"] = {f"{t}|{r}|{l}|{s}|{w}": _d(q) for t, r, l, s, w, q in await _rows(
        db, "SELECT ref_type, ref_id, COALESCE(ref_line_id,0), status, warehouse_id, "
            "SUM(quantity) FROM inv_reservations WHERE item_id IN :ids "
            "GROUP BY ref_type, ref_id, COALESCE(ref_line_id,0), status, warehouse_id",
        p, ex)}
    # Every live hold must still stand on a stock row that exists.
    out["orphan_holds"] = int((await _rows(
        db, "SELECT COUNT(*) FROM inv_reservations r LEFT JOIN stk_balance b "
            "ON b.id = r.stock_id WHERE r.item_id IN :ids AND r.status = 'ACTIVE' "
            "AND b.id IS NULL", p, ex))[0][0])
    if schema.has("stk_project_holds", "stock_id"):
        out["project_holds"] = {f"{s}": _d(q) for s, q in await _rows(
            db, "SELECT status, SUM(quantity) FROM stk_project_holds WHERE item_id IN :ids "
                "GROUP BY status", p, ex)}
    counts = {}
    for table in schema.branded + schema.plain:
        if table in MASTER_TABLES or table in ("stk_balance",):
            continue
        counts[table] = int((await _rows(
            db, f"SELECT COUNT(*) FROM `{table}` WHERE item_id IN :ids", p, ex))[0][0])
    out["rows"] = counts
    return out


def compare(before: dict, after: dict) -> list[str]:
    """Every figure that differs, in words. Empty = identical."""
    problems = []
    for section, figures in before.items():
        later = after.get(section)
        if figures != later:
            if isinstance(figures, dict):
                keys = set(figures) | set(later or {})
                for key in sorted(keys, key=str):
                    if figures.get(key) != (later or {}).get(key):
                        problems.append(f"{section}[{key}]: before {figures.get(key)} "
                                        f"after {(later or {}).get(key)}")
            else:
                problems.append(f"{section}: before {figures} after {later}")
    return problems


# ------------------------------------------------------------------ the moves --

async def brand_names(db, brand_ids) -> dict[int, tuple[str, str]]:
    ids = [b for b in brand_ids if b]
    if not ids:
        return {}
    return {i: (c, n) for i, c, n in await _rows(
        db, "SELECT id, code, name FROM mst_brands WHERE id IN :ids", {"ids": ids}, ("ids",))}


async def ensure_mapping(db, item, brand_id: int, brands: dict, log: list) -> None:
    if not brand_id or brand_id not in brands:
        return
    have = await _rows(db, "SELECT id, is_active FROM mst_brand_item_mappings "
                           "WHERE item_id = :i AND brand_id = :b",
                       {"i": item["id"], "b": brand_id})
    if have:
        if not have[0][1]:
            await _exec(db, "UPDATE mst_brand_item_mappings SET is_active = 1 WHERE id = :id",
                        {"id": have[0][0]})
        return
    code, name = brands[brand_id]
    await _exec(db, "INSERT INTO mst_brand_item_mappings (item_id, item_code, item_name, "
                    "brand_id, brand_code, brand_name, is_active, created_at) VALUES "
                    "(:i, :ic, :iname, :b, :bc, :bn, 1, NOW())",
                {"i": item["id"], "ic": item["code"], "iname": item["name"], "b": brand_id,
                 "bc": code, "bn": name})
    log.append(f"brand {name} mapped to {item['code']} (item {item['id']})")


async def place_stock(db, row: dict, survivor: dict, brand_id: int, log: list) -> None:
    """Put one balance row under the survivor and its brand, merging it into the row
    already holding that lot when there is one."""
    key = dict(i=survivor["id"], w=row["warehouse_id"], bn=row["bin_id"],
               bt=row["batch_id"], p=row["project_id"], b=brand_id,
               v=row["variant_id"] or 0, m=row["model_id"] or 0, me=row["id"])
    keeper = await _rows(
        db, "SELECT id FROM stk_balance WHERE item_id = :i AND warehouse_id = :w AND "
            "bin_id = :bn AND batch_id = :bt AND project_id = :p AND brand_id = :b AND "
            "variant_id = :v AND model_id = :m AND id <> :me FOR UPDATE", key)
    if not keeper:
        await _exec(db, "UPDATE stk_balance SET item_id = :i, item_name = :n, brand_id = :b "
                        "WHERE id = :me",
                    {"i": survivor["id"], "n": survivor["name"], "b": brand_id,
                     "me": row["id"]})
        log.append(f"stock row {row['id']} ({_d(row['total_qty'])}) "
                   + (f"tagged brand {brand_id}" if brand_id != (row["brand_id"] or 0)
                      else f"moved to item {survivor['id']}"))
        return
    keep_id = keeper[0][0]
    await _exec(db, "UPDATE stk_balance SET "
                    "total_qty = total_qty + :t, available_qty = available_qty + :a, "
                    "reserved_qty = reserved_qty + :r, "
                    "transit_qty = COALESCE(transit_qty,0) + :tr, "
                    "stock_value = COALESCE(stock_value,0) + :sv, "
                    "valuation_rate = CASE WHEN total_qty > 0 "
                    "  THEN COALESCE(stock_value,0) / total_qty ELSE valuation_rate END "
                    "WHERE id = :k",
                {"t": _d(row["total_qty"]), "a": _d(row["available_qty"]),
                 "r": _d(row["reserved_qty"]), "tr": _d(row["transit_qty"]),
                 "sv": _d(row["stock_value"]), "k": keep_id})
    await _exec(db, "UPDATE inv_reservations SET stock_id = :k WHERE stock_id = :me",
                {"k": keep_id, "me": row["id"]})
    if HAS_HOLDS:
        await _exec(db, "UPDATE stk_project_holds SET stock_id = :k WHERE stock_id = :me",
                    {"k": keep_id, "me": row["id"]})
    await _exec(db, "DELETE FROM stk_balance WHERE id = :me", {"me": row["id"]})
    log.append(f"stock row {row['id']} merged into lot {keep_id} "
               f"(+{_d(row['total_qty'])})")


async def move_stock_rows(db, members: list[dict], survivor: dict, log: list) -> None:
    for member in members:   # survivor first: its rows are the keepers
        for row in [dict(r._mapping) for r in await _rows(
                db, "SELECT * FROM stk_balance WHERE item_id = :i ORDER BY id FOR UPDATE",
                {"i": member["id"]})]:
            brand = row["brand_id"] or member["brand_id"] or 0
            if member["id"] == survivor["id"] and row["brand_id"] == brand:
                continue
            await place_stock(db, row, survivor, brand, log)


async def move_lines(db, schema: Schema, members: list[dict], survivor: dict,
                     brands: dict, log: list | None = None) -> None:
    """Every document / ledger / reservation row: to the survivor, tagged with the
    brand of the item row it came from."""
    for table in schema.branded:
        has_any = schema.has(table, "combination_any")
        has_name = schema.has(table, "brand_name")
        for member in members:
            if member["brand_id"] and member["brand_id"] in brands:
                sets = "item_id = :sv, brand_id = :b"
                params = {"sv": survivor["id"], "b": member["brand_id"], "m": member["id"]}
                if has_name:
                    sets += ", brand_name = :bn"
                    params["bn"] = brands[member["brand_id"]][1]
                done = await _exec(db, f"UPDATE `{table}` SET {sets} WHERE item_id = :m "
                                       f"AND COALESCE(brand_id,0) = 0"
                                       + (" AND COALESCE(combination_any,0) = 0"
                                          if has_any else ""),
                                   params)
                if done.rowcount and log is not None:
                    log.append(f"{table}: {done.rowcount} rows tagged "
                               f"{brands[member['brand_id']][1]}")
            if member["id"] != survivor["id"]:
                await _exec(db, f"UPDATE `{table}` SET item_id = :sv WHERE item_id = :m",
                            {"sv": survivor["id"], "m": member["id"]})
    siblings = [m["id"] for m in members if m["id"] != survivor["id"]]
    if not siblings:
        return
    for table in schema.plain:
        await _exec(db, f"UPDATE `{table}` SET item_id = :sv WHERE item_id IN :ids",
                    {"sv": survivor["id"], "ids": siblings}, ("ids",))
    for table, column in schema.extra:
        await _exec(db, f"UPDATE `{table}` SET `{column}` = :sv WHERE `{column}` IN :ids",
                    {"sv": survivor["id"], "ids": siblings}, ("ids",))


async def move_masters(db, schema: Schema, members: list[dict], survivor: dict,
                       brands: dict, log: list, conflicts: list) -> None:
    siblings = [m for m in members if m["id"] != survivor["id"]]
    sv = survivor["id"]
    for sib in siblings:
        sid = sib["id"]
        tag = (brands.get(sib["brand_id"], (None, None))[1]
               if sib["brand_id"] else f"item {sid}")
        # brand mappings
        for map_id, brand_id in await _rows(
                db, "SELECT id, brand_id FROM mst_brand_item_mappings WHERE item_id = :s",
                {"s": sid}):
            if await _rows(db, "SELECT 1 FROM mst_brand_item_mappings "
                               "WHERE item_id = :sv AND brand_id = :b", {"sv": sv, "b": brand_id}):
                await _exec(db, "DELETE FROM mst_brand_item_mappings WHERE id = :id",
                            {"id": map_id})
            else:
                await _exec(db, "UPDATE mst_brand_item_mappings SET item_id = :sv, "
                                "item_code = :c, item_name = :n WHERE id = :id",
                            {"sv": sv, "c": survivor["code"], "n": survivor["name"],
                             "id": map_id})
        await _exec(db, "DELETE FROM mst_item_combinations WHERE item_id = :s", {"s": sid})
        # keyed masters
        for table, keys in DEDUP_KEYS.items():
            if table not in schema.columns:
                continue
            id_col = "id" if schema.has(table, "id") else None
            if id_col is None:
                continue
            cols = ", ".join(keys)
            for row in await _rows(db, f"SELECT id, {cols} FROM `{table}` WHERE item_id = :s",
                                   {"s": sid}):
                cond = " AND ".join(f"{k} <=> :{k}" for k in keys)
                params = {"sv": sv, **{k: row[i + 1] for i, k in enumerate(keys)}}
                if await _rows(db, f"SELECT 1 FROM `{table}` WHERE item_id = :sv AND {cond}",
                               params):
                    await _exec(db, f"DELETE FROM `{table}` WHERE id = :id", {"id": row[0]})
                else:
                    await _exec(db, f"UPDATE `{table}` SET item_id = :sv WHERE id = :id",
                                {"sv": sv, "id": row[0]})
        # specs: one row per item
        if "mst_item_specs" in schema.columns:
            if await _rows(db, "SELECT 1 FROM mst_item_specs WHERE item_id = :sv", {"sv": sv}):
                if await _rows(db, "SELECT 1 FROM mst_item_specs WHERE item_id = :s",
                               {"s": sid}):
                    conflicts.append(f"{survivor['code']}: specs of item {sid} dropped "
                                     f"(the survivor has its own)")
                await _exec(db, "DELETE FROM mst_item_specs WHERE item_id = :s", {"s": sid})
            else:
                await _exec(db, "UPDATE mst_item_specs SET item_id = :sv WHERE item_id = :s",
                            {"sv": sv, "s": sid})
        # pack ladders: a clashing name is named for the brand it came with
        if "mst_pack_hierarchies" in schema.columns:
            names = {n for (n,) in await _rows(
                db, "SELECT name FROM mst_pack_hierarchies WHERE item_id = :sv", {"sv": sv})}
            has_default = bool(await _rows(
                db, "SELECT 1 FROM mst_pack_hierarchies WHERE item_id = :sv AND is_default = 1",
                {"sv": sv}))
            for hid, name, is_default in await _rows(
                    db, "SELECT id, name, is_default FROM mst_pack_hierarchies "
                        "WHERE item_id = :s", {"s": sid}):
                new_name = name
                if new_name in names:
                    new_name = f"{name} ({tag})"
                    n = 2
                    while new_name in names:
                        new_name, n = f"{name} ({tag} {n})", n + 1
                    log.append(f"pack ladder '{name}' of item {sid} kept as '{new_name}'")
                names.add(new_name)
                await _exec(db, "UPDATE mst_pack_hierarchies SET item_id = :sv, name = :n, "
                                "is_default = :d WHERE id = :id",
                            {"sv": sv, "n": new_name[:100],
                             "d": 0 if has_default else is_default, "id": hid})
                has_default = has_default or bool(is_default)
        # vendor mappings: one per vendor
        if "mst_vendor_items" in schema.columns:
            for vid, vendor_id, rate, preferred in await _rows(
                    db, "SELECT id, vendor_id, last_rate, is_preferred FROM mst_vendor_items "
                        "WHERE item_id = :s", {"s": sid}):
                mine = await _rows(db, "SELECT id, last_rate FROM mst_vendor_items "
                                       "WHERE item_id = :sv AND vendor_id = :v",
                                   {"sv": sv, "v": vendor_id})
                if mine:
                    keep_id, keep_rate = mine[0]
                    if keep_rate is None and rate is not None:
                        await _exec(db, "UPDATE mst_vendor_items SET last_rate = :r "
                                        "WHERE id = :id", {"r": rate, "id": keep_id})
                    elif rate is not None and _d(rate) != _d(keep_rate):
                        conflicts.append(f"{survivor['code']}: vendor {vendor_id} rate "
                                         f"{keep_rate} kept, {rate} (item {sid}) dropped")
                    await _exec(db, "DELETE FROM mst_vendor_items WHERE id = :id", {"id": vid})
                else:
                    await _exec(db, "UPDATE mst_vendor_items SET item_id = :sv, "
                                    "item_name = :n WHERE id = :id",
                                {"sv": sv, "n": survivor["name"], "id": vid})
    if "mst_vendor_items" in schema.columns:
        preferred = [r[0] for r in await _rows(
            db, "SELECT id FROM mst_vendor_items WHERE item_id = :sv AND is_preferred = 1 "
                "ORDER BY id", {"sv": sv})]
        if len(preferred) > 1:
            await _exec(db, "UPDATE mst_vendor_items SET is_preferred = 0 WHERE id IN :ids",
                        {"ids": preferred[1:]}, ("ids",))


async def move_units(db, members: list[dict], survivor: dict, brands: dict,
                     log: list) -> None:
    """Units to the survivor; a serial the survivor already carries gets a suffix."""
    sv = survivor["id"]
    taken = {s for (s,) in await _rows(
        db, "SELECT serial_number FROM whs_serial_numbers WHERE item_id = :sv", {"sv": sv})}
    for sib in members:
        if sib["id"] == sv:
            continue
        suffix = (brands[sib["brand_id"]][0] if sib["brand_id"] in brands else None)
        for unit_id, serial, remarks in await _rows(
                db, "SELECT id, serial_number, remarks FROM whs_serial_numbers "
                    "WHERE item_id = :s ORDER BY id", {"s": sib["id"]}):
            new = serial
            if serial in taken:
                n = 2
                new = f"{serial}-{suffix}" if suffix else f"{serial}-{n}"
                while new in taken:
                    n += 1
                    new = f"{serial}-{suffix}{n}" if suffix else f"{serial}-{n}"
                log.append(f"unit {unit_id}: serial {serial} renamed {new} "
                           f"(already on {survivor['code']})")
            taken.add(new)
            params = {"sv": sv, "n": new[:100], "id": unit_id}
            sets = "item_id = :sv, serial_number = :n"
            if new != serial and not remarks:
                # Only into an EMPTY remark: a filled one is a claim marker that is
                # matched exactly, and appending to it would release the claim.
                sets += ", remarks = :r"
                params["r"] = f"Was {serial} on item {sib['id']} before consolidation"[:500]
            await _exec(db, f"UPDATE whs_serial_numbers SET {sets} WHERE id = :id", params)


async def audit(db, entity_id: int, code: str, summary: str, after: dict) -> None:
    from app.platform.settings.service import write_audit
    from app.shared.enums import AuditAction
    await write_audit(db, entity="mst_items", entity_id=entity_id, entity_no=code,
                      action=AuditAction.UPDATE, actor=None, after=after, summary=summary)


async def _holds_anything(db, schema: Schema, item_id: int) -> bool:
    for table in schema.item_tables:
        if (await _rows(db, f"SELECT 1 FROM `{table}` WHERE item_id = :i LIMIT 1",
                        {"i": item_id})):
            return True
    return False


# ------------------------------------------------------------------ one code --

async def merge_code(db, schema: Schema, code: str, report: dict) -> None:
    members = [dict(r._mapping) for r in await _rows(
        db, "SELECT id, code, name, brand_id, is_active, category_id, hsn_code, "
            + ", ".join(FLAGS) + ", is_asset FROM mst_items WHERE code = :c "
            "ORDER BY is_active DESC, id", {"c": code})]
    if len(members) < 2:
        return
    survivor = members[0]
    # A row retired by an earlier run (or by hand) that holds nothing any more is
    # history, not a sibling. Merging it again would read the survivor's untagged lot
    # — stock that came from a sibling with NO brand — as the survivor's own, and tag
    # it with the survivor's brand. So only a row still active, or still holding
    # anything, takes part.
    live = [survivor]
    for other in members[1:]:
        if other["is_active"] or await _holds_anything(db, schema, other["id"]):
            live.append(other)
    members = live
    if len(members) < 2:
        return
    ids = [m["id"] for m in members]
    log: list[str] = []
    conflicts: list[str] = []
    for other in members[1:]:
        for field in ("name", "category_id", "hsn_code", "is_asset"):
            if other[field] != survivor[field]:
                conflicts.append(f"{code}: {field} '{other[field]}' on item {other['id']} "
                                 f"— '{survivor[field]}' kept")

    before = await snapshot(db, schema, ids)
    brands = await brand_names(db, {m["brand_id"] for m in members})
    async with db.begin_nested():
        try:
            flags = {f: int(any(m[f] for m in members)) for f in FLAGS}
            await _exec(db, "UPDATE mst_items SET " + ", ".join(f"{f} = :{f}" for f in FLAGS)
                        + " WHERE id = :id", {**flags, "id": survivor["id"]})
            for member in members:
                await ensure_mapping(db, survivor, member["brand_id"], brands, log)
            await move_stock_rows(db, members, survivor, log)
            await move_lines(db, schema, members, survivor, brands, log)
            await move_masters(db, schema, members, survivor, brands, log, conflicts)
            if "whs_serial_numbers" in schema.columns:
                await move_units(db, members, survivor, brands, log)
            siblings = ids[1:]
            await _exec(db, "UPDATE mst_items SET is_active = 0 WHERE id IN :ids",
                        {"ids": siblings}, ("ids",))
            await combinations.sync_item(db, survivor["id"])
            await db.flush()

            after = await snapshot(db, schema, [survivor["id"]])
            problems = compare(before, after)
            left = []
            for table in schema.item_tables:
                n = (await _rows(db, f"SELECT COUNT(*) FROM `{table}` WHERE item_id IN :ids",
                                 {"ids": siblings}, ("ids",)))[0][0]
                if n:
                    left.append(f"{table}: {n} rows still on a retired item")
            if problems or left:
                raise CheckFailed("; ".join((problems + left)[:20]))
            await audit(db, survivor["id"], code,
                        f"Consolidated items {siblings} into {survivor['id']}",
                        {"merged": siblings, "log": log[:200]})
        except CheckFailed as exc:
            report["rolled_back"].append({"code": code, "reason": str(exc)})
            raise _Rollback()
    report["merged"].append({"code": code, "survivor": survivor["id"],
                             "retired": ids[1:], "changes": log})
    report["conflicts"].extend(conflicts)


class _Rollback(Exception):
    """Raised inside the savepoint so `begin_nested` rolls the code back."""


# ------------------------------------------------------------------ every item --

async def tag_single_brand_items(db, schema: Schema, report: dict) -> None:
    """Map each item's old brand, and where the item has exactly ONE brand tag its
    untagged stock and lines with it — each item checked like a merge."""
    items = [dict(r._mapping) for r in await _rows(
        db, "SELECT id, code, name, brand_id FROM mst_items WHERE is_active = 1 "
            "AND brand_id IS NOT NULL ORDER BY id")]
    # An item with no old brand whose mapping names exactly ONE brand is just as
    # certain: that brand is the only thing its untagged stock can be.
    items += [{**dict(r._mapping), "brand_id": int(r._mapping["only_brand"])} for r in await _rows(
        db, "SELECT i.id, i.code, i.name, MIN(m.brand_id) AS only_brand FROM mst_items i "
            "JOIN mst_brand_item_mappings m ON m.item_id = i.id AND m.is_active = 1 "
            "WHERE i.is_active = 1 AND i.brand_id IS NULL "
            "GROUP BY i.id, i.code, i.name HAVING COUNT(DISTINCT m.brand_id) = 1 ORDER BY i.id")]
    brands = await brand_names(db, {i["brand_id"] for i in items})
    for item in items:
        log: list[str] = []
        mapped = {b for (b,) in await _rows(
            db, "SELECT brand_id FROM mst_brand_item_mappings WHERE item_id = :i "
                "AND is_active = 1", {"i": item["id"]})}
        before = await snapshot(db, schema, [item["id"]])
        try:
            async with db.begin_nested():
                await ensure_mapping(db, item, item["brand_id"], brands, log)
                if mapped - {item["brand_id"]}:
                    # Several brands: which one the old stock was cannot be known, so
                    # it stays an untagged row of its own.
                    report["left_untagged"].append(item["code"])
                else:
                    await move_stock_rows(db, [item], item, log)
                    await move_lines(db, schema, [item], item, brands, log)
                await combinations.sync_item(db, item["id"])
                await db.flush()
                problems = compare(before, await snapshot(db, schema, [item["id"]]))
                if problems:
                    report["rolled_back"].append({"code": item["code"],
                                                  "reason": "; ".join(problems[:20])})
                    raise _Rollback()
        except _Rollback:
            continue
        if log:
            report["tagged"].append({"code": item["code"], "changes": log})


async def run(apply: bool, only_code: str | None, report_path: str | None) -> int:
    report = {"mode": "APPLY" if apply else "PREVIEW", "merged": [], "rolled_back": [],
              "tagged": [], "left_untagged": [], "conflicts": []}
    async with SessionLocal() as db:
        schema = await load_schema(db)
        global HAS_HOLDS
        HAS_HOLDS = schema.has("stk_project_holds", "stock_id")
        codes = [c for (c,) in await _rows(
            db, "SELECT code FROM mst_items GROUP BY code HAVING COUNT(*) > 1 ORDER BY code")]
        if only_code:
            codes = [c for c in codes if c == only_code]
        for code in codes:
            try:
                await merge_code(db, schema, code, report)
            except _Rollback:
                pass
        if not only_code:
            await tag_single_brand_items(db, schema, report)
        # Every item's combinations, so the masters list them on the next read.
        for (item_id,) in await _rows(db, "SELECT id FROM mst_items WHERE is_active = 1"):
            await combinations.sync_item(db, item_id)
        if apply:
            await db.commit()
        else:
            await db.rollback()

    print(f"\n{report['mode']} - item codes merged: {len(report['merged'])}, "
          f"items tagged: {len(report['tagged'])}, rolled back: {len(report['rolled_back'])}")
    for row in report["merged"]:
        print(f"  MERGED {row['code']}: kept item {row['survivor']}, retired "
              f"{row['retired']} - {len(row['changes'])} changes")
    for row in report["tagged"]:
        print(f"  TAGGED {row['code']}: {len(row['changes'])} changes")
    for code in report["left_untagged"]:
        print(f"  UNTAGGED {code}: several brands - old stock stays a row of its own")
    for row in report["rolled_back"]:
        print(f"  ROLLED BACK {row['code']}: {row['reason']}")
    for line in report["conflicts"]:
        print(f"  NOTE {line}")
    if report_path:
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2, default=str)
        print(f"\nFull report: {report_path}")
    if not apply:
        print("\nNothing was saved. Run again with --apply to save.")
    return 1 if report["rolled_back"] else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="save the changes")
    parser.add_argument("--code", help="only this item code")
    parser.add_argument("--report", help="write the full report to this JSON file")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(run(args.apply, args.code, args.report)))


if __name__ == "__main__":
    main()
