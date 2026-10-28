"""Item combinations: item + brand + variant + model (2026-10-23).

One item is bought, stocked and issued as several distinct things — Gloves by Brand A
in the Nitrile variant, model M-100 is not Gloves by Brand B. Each is a COMBINATION,
and every transaction line names one; a different combination is a different row.

The combinations are PICKED, never expanded (2026-10-26): mapping a brand gives the
item that brand alone; a variant, and then a model, are added only when somebody picks
them (`add_combination`) — a brand with three variants does not give the item three
combinations nobody chose. A brand mapped with nothing picked under it is its brand
row. A level not picked is 0. `mst_item_combinations` records each combination and
whether it is ON for the item; switching one OFF, or removing it, is refused while
stock of it is held.

Stock is read off `stk_balance` by raw SQL: shared may not import a module (rule 5).
"""
from __future__ import annotations

from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationError
from app.shared.enums import AuditAction
from app.shared.models.master import (
    Brand, BrandItemMapping, BrandModel, BrandVariant, Item, ItemCombination,
)

Key = tuple[int, int, int]


async def _brand_ids(db: AsyncSession, item: Item) -> list[int]:
    """The item's brands: mapped, its own older `brand_id`, and — while rows created
    before 2026-10-23 still share its code — theirs too, so the Brands tab lists
    every brand of the code before `scripts.consolidate_item_brands` merges them."""
    same_code = select(Item.id).where(Item.code == item.code, Item.is_active.is_(True))
    mapped = {b for (b,) in (await db.execute(
        select(BrandItemMapping.brand_id).where(
            BrandItemMapping.item_id.in_(same_code),
            BrandItemMapping.is_active.is_(True)))).all()}
    for (brand_id,) in (await db.execute(
            select(Item.brand_id).where(Item.code == item.code, Item.is_active.is_(True),
                                        Item.brand_id.isnot(None)))).all():
        mapped.add(int(brand_id))
    if item.brand_id:
        mapped.add(int(item.brand_id))
    return sorted(mapped)


async def _derive(db: AsyncSession, brand_ids: list[int]) -> list[dict]:
    """Every combination the brands make, named, in brand / variant / model order."""
    if not brand_ids:
        return []
    brands = {b.id: b for b in (await db.execute(select(Brand).where(
        Brand.id.in_(brand_ids), Brand.is_active.is_(True)))).scalars().all()}
    variants = (await db.execute(select(BrandVariant).where(
        BrandVariant.brand_id.in_(list(brands) or [0]),
        BrandVariant.is_active.is_(True)).order_by(BrandVariant.name))).scalars().all()
    models = (await db.execute(select(BrandModel).where(
        BrandModel.variant_id.in_([v.id for v in variants] or [0]),
        BrandModel.is_active.is_(True)).order_by(BrandModel.name))).scalars().all()
    by_brand: dict[int, list] = {}
    for v in variants:
        by_brand.setdefault(v.brand_id, []).append(v)
    by_variant: dict[int, list] = {}
    for mo in models:
        by_variant.setdefault(mo.variant_id, []).append(mo)

    out: list[dict] = []
    for brand in sorted(brands.values(), key=lambda b: b.name or ""):
        brand_variants = by_brand.get(brand.id, [])
        if not brand_variants:
            out.append({"brand_id": brand.id, "brand_name": brand.name,
                        "variant_id": 0, "variant_name": None,
                        "model_id": 0, "model_name": None})
            continue
        for v in brand_variants:
            variant_models = by_variant.get(v.id, [])
            if not variant_models:
                out.append({"brand_id": brand.id, "brand_name": brand.name,
                            "variant_id": v.id, "variant_name": v.name,
                            "model_id": 0, "model_name": None})
            for mo in variant_models:
                out.append({"brand_id": brand.id, "brand_name": brand.name,
                            "variant_id": v.id, "variant_name": v.name,
                            "model_id": mo.id, "model_name": mo.name})
    return out


async def sync_item(db: AsyncSession, item_id: int) -> list[ItemCombination]:
    """The item's combinations as rows, creating any the masters now imply (ON).
    A combination no longer implied (its brand unmapped) is not returned, and its row
    is kept so documents naming it still read."""
    item = await db.get(Item, item_id)
    if item is None:
        raise NotFoundError("Item not found")
    brand_ids = await _brand_ids(db, item)
    brands = {b.id: b for b in (await db.execute(select(Brand).where(
        Brand.id.in_(brand_ids or [0]), Brand.is_active.is_(True)))).scalars().all()}
    existing = (await db.execute(select(ItemCombination).where(
        ItemCombination.item_id == item_id).order_by(ItemCombination.id))).scalars().all()
    # Only what was picked (2026-10-26): a mapped brand with nothing picked under it
    # is its brand row; nothing is ever expanded into a brand's variants or models.
    for brand_id, brand in brands.items():
        if not any(r.brand_id == brand_id for r in existing):
            row = ItemCombination(item_id=item_id, is_active=True, brand_id=brand_id,
                                  brand_name=brand.name, variant_id=0, variant_name=None,
                                  model_id=0, model_name=None)
            db.add(row)
            existing.append(row)
    rows = [r for r in existing if r.brand_id in brands]
    await _refresh_names(db, rows, brands)
    await db.flush()
    rows.sort(key=lambda r: (r.brand_name or "", r.variant_name or "", r.model_name or ""))
    return rows


async def _refresh_names(db: AsyncSession, rows, brands: dict) -> None:
    variant_ids = {r.variant_id for r in rows if r.variant_id}
    model_ids = {r.model_id for r in rows if r.model_id}
    variants = dict((await db.execute(select(BrandVariant.id, BrandVariant.name).where(
        BrandVariant.id.in_(variant_ids or {0})))).all())
    models = dict((await db.execute(select(BrandModel.id, BrandModel.name).where(
        BrandModel.id.in_(model_ids or {0})))).all())
    for row in rows:
        row.brand_name = getattr(brands.get(row.brand_id), "name", row.brand_name)
        if row.variant_id:
            row.variant_name = variants.get(row.variant_id, row.variant_name)
        if row.model_id:
            row.model_name = models.get(row.model_id, row.model_name)


async def add_combination(db: AsyncSession, item_id: int, brand_id: int,
                          variant_id: int | None, model_id: int | None, user) -> list[dict]:
    """Map EXACTLY what was picked (2026-10-26): a brand; a brand and a variant; or a
    brand, a variant and a model — never further. The variant must be the brand's and
    the model the variant's. Picking deeper replaces the brand's bare row when nothing
    of it is in stock, so the item reads as what was chosen."""
    brand = await db.get(Brand, brand_id)
    if brand is None or not brand.is_active:
        raise ValidationError("Pick an active brand.")
    variant = await db.get(BrandVariant, variant_id) if variant_id else None
    if variant_id and (variant is None or variant.brand_id != brand_id):
        raise ValidationError(f"That variant is not one of {brand.name}'s.")
    model = await db.get(BrandModel, model_id) if model_id else None
    if model_id and (model is None or not variant or model.variant_id != variant.id):
        raise ValidationError("Pick the variant first — that model is not under it.")
    from app.shared.masters.defs import BrandItemMappingIn, save_brand_item_mapping
    await save_brand_item_mapping(
        db, BrandItemMappingIn(brand_ids=[brand_id], item_ids=[item_id]), user)
    await ensure_combination(db, item_id, brand, variant, model)
    from app.platform.settings.service import write_audit
    label = " · ".join(p for p in (brand.name, getattr(variant, "name", None),
                                   getattr(model, "name", None)) if p)
    await write_audit(db, entity="mst_item_combinations", entity_id=item_id,
                      entity_no=label, action=AuditAction.CREATE, actor=user,
                      summary=f"Combination {label} mapped to the item")
    await db.commit()
    return await item_combinations(db, item_id)


async def ensure_combination(db: AsyncSession, item_id: int, brand, variant=None,
                             model=None) -> bool:
    """Put exactly this brand / variant / model on the item (2026-10-26) — ON if it
    was there. A variant (or model) picked replaces the brand's bare row while nothing
    of it is in stock. Returns whether a row was created. Commits nothing."""
    key = (brand.id, int(getattr(variant, "id", 0) or 0), int(getattr(model, "id", 0) or 0))
    rows = (await db.execute(select(ItemCombination).where(
        ItemCombination.item_id == item_id,
        ItemCombination.brand_id == brand.id))).scalars().all()
    found = next((r for r in rows if (r.brand_id, r.variant_id or 0, r.model_id or 0) == key), None)
    if found is None:
        db.add(ItemCombination(
            item_id=item_id, is_active=True, brand_id=brand.id, brand_name=brand.name,
            variant_id=key[1], variant_name=getattr(variant, "name", None),
            model_id=key[2], model_name=getattr(model, "name", None)))
    else:
        found.is_active = True
    if key[1]:
        stock = await stock_by_combination(db, [item_id])
        for bare in rows:
            if (not bare.variant_id and not bare.model_id
                    and not stock.get((item_id, brand.id, 0, 0))):
                await db.delete(bare)
    await db.flush()
    return found is None


async def remove_combination(db: AsyncSession, item_id: int, combination_id: int,
                             user) -> list[dict]:
    """Take one combination off the item — refused while any of it is in stock. The
    brand stays mapped; with nothing left under it, it reads as the bare brand."""
    row = await db.get(ItemCombination, combination_id)
    if row is None or row.item_id != item_id:
        raise NotFoundError("That combination is not on this item.")
    held = (await stock_by_combination(db, [item_id])).get(
        (item_id, row.brand_id, row.variant_id or 0, row.model_id or 0), 0.0)
    label = combination_out(row)["label"]
    if held > 0:
        raise ValidationError(f"{label} still has {held:g} in stock — it cannot be removed.")
    await db.delete(row)
    from app.platform.settings.service import write_audit
    await write_audit(db, entity="mst_item_combinations", entity_id=item_id,
                      entity_no=label, action=AuditAction.DELETE, actor=user,
                      summary=f"Combination {label} removed from the item")
    await db.commit()
    return await item_combinations(db, item_id)


_STOCK_HAS_COMBINATION: bool | None = None


async def _stock_has_combination(db: AsyncSession) -> bool:
    """Whether `stk_balance` carries the combination columns yet (step 2). Asked once
    per process — a failed query would roll the caller's transaction back."""
    global _STOCK_HAS_COMBINATION
    if _STOCK_HAS_COMBINATION is None:
        found = await db.scalar(text(
            "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = "
            "DATABASE() AND table_name = 'stk_balance' AND column_name = 'model_id'"))
        _STOCK_HAS_COMBINATION = bool(found)
    return _STOCK_HAS_COMBINATION


async def stock_by_combination(db: AsyncSession, item_ids: list[int]) -> dict[tuple, float]:
    """`{(item, brand, variant, model): on hand}` across every point. Empty until
    stock carries the combination columns, never an error."""
    if not item_ids or not await _stock_has_combination(db):
        return {}
    rows = (await db.execute(text(
        "SELECT item_id, brand_id, variant_id, model_id, SUM(total_qty) "
        "FROM stk_balance WHERE item_id IN :ids AND total_qty > 0 "
        "GROUP BY item_id, brand_id, variant_id, model_id"
    ).bindparams(bindparam("ids", expanding=True)), {"ids": list(item_ids)})).all()
    return {(int(r[0]), int(r[1] or 0), int(r[2] or 0), int(r[3] or 0)): float(r[4] or 0)
            for r in rows}


def combination_out(row: ItemCombination, stock: dict | None = None) -> dict:
    return {
        "id": row.id, "item_id": row.item_id,
        "brand_id": row.brand_id, "brand_name": row.brand_name,
        "variant_id": row.variant_id or None, "variant_name": row.variant_name,
        "model_id": row.model_id or None, "model_name": row.model_name,
        "label": " · ".join(p for p in (row.brand_name, row.variant_name, row.model_name) if p),
        "is_active": bool(row.is_active),
        "stock_qty": (stock or {}).get(
            (row.item_id, row.brand_id, row.variant_id or 0, row.model_id or 0), 0.0),
    }


async def item_combinations(db: AsyncSession, item_id: int) -> list[dict]:
    """The Brands tab: every combination of the item, ON or OFF, with its stock."""
    rows = await sync_item(db, item_id)
    await db.commit()
    stock = await stock_by_combination(db, [item_id])
    return [combination_out(r, stock) for r in rows]


async def combination_options(db: AsyncSession, item_ids: list[int]) -> dict[int, list[dict]]:
    """For documents: each item's combinations that are ON — the "full list"."""
    out: dict[int, list[dict]] = {}
    for item_id in dict.fromkeys(int(i) for i in item_ids):
        if await db.get(Item, item_id) is None:
            continue
        out[item_id] = [combination_out(r) for r in await sync_item(db, item_id)
                        if r.is_active]
    await db.commit()
    return out


async def set_combination_active(db: AsyncSession, item_id: int, combination_id: int,
                                 active: bool, user) -> dict:
    row = await db.get(ItemCombination, combination_id)
    if row is None or row.item_id != item_id:
        raise NotFoundError("That combination is not on this item.")
    if not active:
        held = (await stock_by_combination(db, [item_id])).get(
            (item_id, row.brand_id, row.variant_id or 0, row.model_id or 0), 0.0)
        if held > 0:
            raise ValidationError(
                f"{combination_out(row)['label']} still has {held:g} in stock. It can be "
                "switched off once none of it is held anywhere.")
    row.is_active = bool(active)
    from app.platform.settings.service import write_audit
    await write_audit(
        db, entity="mst_item_combinations", entity_id=row.id,
        entity_no=combination_out(row)["label"], action=AuditAction.UPDATE, actor=user,
        summary=f"Combination {combination_out(row)['label']} switched "
                f"{'on' if active else 'off'}")
    await db.commit()
    stock = await stock_by_combination(db, [item_id])
    return combination_out(row, stock)


async def map_item_brands(db: AsyncSession, item_id: int, brand_ids: list[int],
                          user) -> list[dict]:
    """Map brands onto ONE item (the item form's Brands tab, also before first save)."""
    from app.shared.masters.defs import BrandItemMappingIn, save_brand_item_mapping
    if brand_ids:
        await save_brand_item_mapping(
            db, BrandItemMappingIn(brand_ids=brand_ids, item_ids=[item_id]), user)
    return await item_combinations(db, item_id)


async def unmap_item_brand(db: AsyncSession, item_id: int, brand_id: int) -> list[dict]:
    """Take a brand off an item — refused while any of its combinations is in stock."""
    held = {k: v for k, v in (await stock_by_combination(db, [item_id])).items()
            if k[1] == brand_id and v > 0}
    if held:
        raise ValidationError(
            "That brand still has stock of this item. It can be removed once none of it "
            "is held anywhere.")
    rows = (await db.execute(select(BrandItemMapping).where(
        BrandItemMapping.item_id == item_id,
        BrandItemMapping.brand_id == brand_id))).scalars().all()
    for row in rows:
        row.is_active = False
    item = await db.get(Item, item_id)
    if item is not None and item.brand_id == brand_id:
        item.brand_id = None
    await db.commit()
    return await item_combinations(db, item_id)


async def backfill_item_brands(db: AsyncSession, *, apply: bool) -> int:
    """Every item's older single brand, as a mapping row. Idempotent."""
    items = (await db.execute(select(Item).where(Item.brand_id.isnot(None)))).scalars().all()
    have = {(b, i) for b, i in (await db.execute(select(
        BrandItemMapping.brand_id, BrandItemMapping.item_id))).all()}
    brands = {b.id: b for b in (await db.execute(select(Brand).where(
        Brand.id.in_({i.brand_id for i in items} or {0})))).scalars().all()}
    missing = [i for i in items if (i.brand_id, i.id) not in have and i.brand_id in brands]
    if apply:
        for item in missing:
            brand = brands[item.brand_id]
            db.add(BrandItemMapping(item_id=item.id, item_code=item.code,
                                    item_name=item.name, brand_id=brand.id,
                                    brand_code=brand.code, brand_name=brand.name,
                                    is_active=True))
        await db.commit()
    return len(missing)



# --------------------------------------------------------------------------- #
#  On a document line
# --------------------------------------------------------------------------- #
from pydantic import BaseModel  # noqa: E402


class CombinationIn(BaseModel):
    """What a line says about its combination. Unset = none named."""
    brand_id: int | None = None
    variant_id: int | None = None
    model_id: int | None = None
    #: Display only — echoed back by drafts so a form can label the value. The
    #: server never reads them: names are re-derived from the ids.
    brand_name: str | None = None
    variant_name: str | None = None
    model_name: str | None = None
    #: The indent's "any brand / variant / model" — the warehouse picks from stock.
    combination_any: bool = False


class CombinationOut(BaseModel):
    brand_id: int = 0
    variant_id: int = 0
    model_id: int = 0
    brand_name: str | None = None
    variant_name: str | None = None
    model_name: str | None = None
    combination_any: bool = False


NONE = {"brand_id": 0, "variant_id": 0, "model_id": 0, "brand_name": None,
        "variant_name": None, "model_name": None, "combination_any": False}


async def resolve(db: AsyncSession, item_id: int, line, *, allow_any: bool = False,
                  required: bool = False, default_any: bool = False,
                  label: str = "") -> dict:
    """The columns a line stores for its combination, checked against the item.

    A named combination must be one of the item's that is ON. "Any" only where the
    document allows it (the indent). `required`: an item that HAS combinations must
    name one (or "Any") — an item with none needs nothing. Returns the seven columns.
    """
    get = (line.get if isinstance(line, dict) else (lambda k, d=None: getattr(line, k, d)))
    brand_id = int(get("brand_id") or 0)
    variant_id = int(get("variant_id") or 0)
    model_id = int(get("model_id") or 0)
    if get("combination_any") and allow_any and not brand_id:
        return {**NONE, "combination_any": True}
    rows = await sync_item(db, item_id)
    active = [r for r in rows if r.is_active]
    if not brand_id and default_any and allow_any and active:
        # Nothing named on a document that allows "Any" (an indent raised by code,
        # or by a client that predates combinations): it means any.
        return {**NONE, "combination_any": True}
    if not brand_id:
        if required and active:
            raise ValidationError(
                f"{label or 'A line'}: pick the brand"
                f"{' / variant / model' if any(r.variant_id for r in active) else ''}"
                f"{' — or Any' if allow_any else ''}.")
        return dict(NONE)
    match = next((r for r in active if (r.brand_id, r.variant_id or 0, r.model_id or 0)
                  == (brand_id, variant_id, model_id)), None)
    if match is None:
        raise ValidationError(
            f"{label or 'A line'}: that brand / variant / model is not an active "
            "combination of this item. Pick one from the list.")
    return {"brand_id": match.brand_id, "variant_id": match.variant_id or 0,
            "model_id": match.model_id or 0, "brand_name": match.brand_name,
            "variant_name": match.variant_name, "model_name": match.model_name,
            "combination_any": False}


async def fill_names(db: AsyncSession, rows) -> None:
    """Name each row's brand / variant / model — three small lookups for the whole
    list, never one per row. Rows may be objects or dicts; rows naming none are left
    without names."""
    get = (lambda row, k: row.get(k) if isinstance(row, dict) else getattr(row, k, None))
    put = (lambda row, k, v: row.__setitem__(k, v) if isinstance(row, dict)
           else setattr(row, k, v))
    parts = (("brand", Brand), ("variant", BrandVariant), ("model", BrandModel))
    want = {part: {int(get(row, f"{part}_id") or 0) for row in rows} - {0}
            for part, _ in parts}
    names: dict[str, dict[int, str]] = {}
    for part, model in parts:
        names[part] = (dict((await db.execute(
            select(model.id, model.name).where(model.id.in_(want[part])))).all())
            if want[part] else {})
    for row in rows:
        for part, _ in parts:
            value = int(get(row, f"{part}_id") or 0)
            put(row, f"{part}_name", names[part].get(value) if value else None)


def carry(source) -> dict:
    """A line's combination copied onto the next document's line, as it stands."""
    get = (source.get if isinstance(source, dict) else (lambda k, d=None: getattr(source, k, d)))
    return {"brand_id": int(get("brand_id") or 0), "variant_id": int(get("variant_id") or 0),
            "model_id": int(get("model_id") or 0), "brand_name": get("brand_name"),
            "variant_name": get("variant_name"), "model_name": get("model_name"),
            "combination_any": bool(get("combination_any") or False)}


def same(a, b) -> bool:
    """Do two lines name the same combination? Rows are split on this."""
    ca, cb = carry(a), carry(b)
    return (ca["brand_id"], ca["variant_id"], ca["model_id"], ca["combination_any"]) == \
        (cb["brand_id"], cb["variant_id"], cb["model_id"], cb["combination_any"])
