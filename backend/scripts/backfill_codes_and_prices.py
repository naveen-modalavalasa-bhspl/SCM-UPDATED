"""Fill in what the stock screens are showing as blank.

Three gaps, all of them history rather than bugs in today's code:

  * `whs_serial_numbers` carries codes in the OLD hardcoded shape (`item-000123`),
    because the formula only became configurable now. `--recode` restamps every
    serial with whatever Settings > Code Formats currently says.
  * `stk_ledger.rate` / `.value` are NULL on every row written before those columns
    were mapped, so the ledger shows no prices for older movements.
  * `stk_balance.valuation_rate` / `.stock_value` are 0 on rows that were never
    costed, which reads as "worthless" rather than "not priced".

Nothing here invents a number. A price comes from the balance row's own costed rate,
falling back to the item's last purchase price; a row with neither is left alone and
counted in the report, because a made-up rupee figure is worse than a blank.

    .venv/Scripts/python -m scripts.backfill_codes_and_prices --dry-run
    .venv/Scripts/python -m scripts.backfill_codes_and_prices           # prices + codes
    .venv/Scripts/python -m scripts.backfill_codes_and_prices --recode  # also restamp
                                                                        # existing codes

Re-runnable: it only writes what is missing. `--recode` is the exception — it
overwrites codes that already exist, which is the point of it, so it is opt-in.
"""
import asyncio
import sys
from decimal import Decimal

from sqlalchemy import select

from app.core.database import SessionLocal
from app.modules.inventory.models import Stock, StockMovement
from app.modules.warehouse.models import SerialNumber
from app.platform.settings import codeformat
from app.shared.models.master import Item
from app.shared.models.warehouse import Warehouse


def _d(value) -> Decimal:
    return Decimal(str(value or 0))


async def recode_serials(db, config, *, dry_run: bool, overwrite: bool) -> dict:
    """Stamp every serial with the code the configured formula produces for it."""
    items = {i.id: i for i in (await db.execute(select(Item))).scalars().all()}
    warehouses = {w.id: w for w in (await db.execute(select(Warehouse))).scalars().all()}
    serials = (await db.execute(
        select(SerialNumber).where(SerialNumber.is_active.is_(True))
    )).scalars().all()

    stamped, skipped = 0, 0
    for serial in serials:
        item = items.get(serial.item_id)
        if item is None:
            skipped += 1
            continue
        is_asset = bool(getattr(item, "is_asset", False))
        existing = serial.asset_code if is_asset else serial.consumable_code
        if existing and not overwrite:
            continue
        template = config["asset_format"] if is_asset else config["consumable_format"]
        values = codeformat.build_values(
            item=item,
            # The IMEI is the identity when there is one — it is what is scanned.
            serial=serial.imei or serial.serial_number,
            seq=serial.id,
            warehouse_code=getattr(warehouses.get(serial.warehouse_id), "code", None),
            is_new=codeformat.is_new_item(item, config["legacy_before"]),
            new_flag=config["new_flag"], legacy_flag=config["legacy_flag"],
        )
        code = codeformat.render(template, values)
        if not code:
            skipped += 1
            continue
        if not dry_run:
            # An item flips between asset and consumable over its life; clear the other
            # column so a unit never carries two codes claiming two different things.
            if is_asset:
                serial.asset_code, serial.consumable_code = code, None
            else:
                serial.consumable_code, serial.asset_code = code, None
        stamped += 1
    return {"serials": len(serials), "stamped": stamped, "skipped": skipped}


async def fill_balance_prices(db, *, dry_run: bool) -> dict:
    """Cost the balance rows that were never costed, and restate every stock value."""
    prices = dict((await db.execute(
        select(Item.id, Item.purchase_price)
    )).all())
    rows = (await db.execute(select(Stock))).scalars().all()

    rated, revalued, uncosted = 0, 0, 0
    for row in rows:
        rate = _d(row.valuation_rate)
        if rate <= 0:
            rate = _d(prices.get(row.item_id))
            if rate <= 0:
                uncosted += 1
                continue
            if not dry_run:
                row.valuation_rate = rate
            rated += 1
        value = (_d(row.total_qty) * rate).quantize(Decimal("0.01"))
        if _d(row.stock_value) != value:
            if not dry_run:
                row.stock_value = value
            revalued += 1
    return {"balance_rows": len(rows), "rated": rated,
            "revalued": revalued, "still_uncosted": uncosted}


async def fill_ledger_prices(db, *, dry_run: bool) -> dict:
    """Price the movements written before stk_ledger.rate/.value were mapped.

    The rate used is the one the balance row for that exact lot carries today. It is
    not the rate at the time — nothing recorded that — so this is the best available
    figure rather than a reconstruction, and it is only applied where the column is
    empty. A row that already has a rate is never touched.
    """
    balance_rates = {
        (item_id, warehouse_id, bin_id, batch_id, project_id): _d(rate)
        for item_id, warehouse_id, bin_id, batch_id, project_id, rate in (
            await db.execute(select(
                Stock.item_id, Stock.warehouse_id, Stock.bin_id, Stock.batch_id,
                Stock.project_id, Stock.valuation_rate))).all()
    }
    item_prices = {i: _d(p) for i, p in (await db.execute(
        select(Item.id, Item.purchase_price))).all()}

    rows = (await db.execute(
        select(StockMovement).where(StockMovement.rate.is_(None))
    )).scalars().all()

    priced, unpriced = 0, 0
    for row in rows:
        rate = balance_rates.get(
            (row.item_id, row.warehouse_id, row.bin_id, row.batch_id, row.project_id),
            Decimal("0"))
        if rate <= 0:
            rate = item_prices.get(row.item_id, Decimal("0"))
        if rate <= 0:
            unpriced += 1
            continue
        if not dry_run:
            row.rate = rate
            row.value = (_d(row.quantity) * rate).quantize(Decimal("0.01"))
        priced += 1
    return {"ledger_rows_missing_rate": len(rows),
            "priced": priced, "still_unpriced": unpriced}


async def link_single_serial_lots(db, *, dry_run: bool) -> dict:
    """Copy the serial and its code onto the balance row of every one-unit lot.

    Only where the lot resolves to exactly ONE serial: `stk_balance.serial_number`
    holds a single value, and a lot of 88 units has no single answer. Those are served
    to the screens by /api/warehouse/serials/summary instead.
    """
    per_lot: dict[tuple[int, int], list[SerialNumber]] = {}
    for serial in (await db.execute(
            select(SerialNumber).where(SerialNumber.is_active.is_(True)))).scalars():
        per_lot.setdefault((serial.item_id, serial.warehouse_id), []).append(serial)

    linked = 0
    for row in (await db.execute(select(Stock))).scalars().all():
        found = per_lot.get((row.item_id, row.warehouse_id)) or []
        if len(found) != 1:
            continue
        serial = found[0]
        if not dry_run:
            # A JSON list even at one element — the column holds every unit in the lot
            # and a bare string would be a second shape for readers to handle.
            row.serial_number = [serial.imei or serial.serial_number]
            row.asset_code = serial.asset_code
            row.consumable_code = serial.consumable_code
        linked += 1
    return {"single_serial_lots_linked": linked}


async def code_unserialised_lots(db, config, *, dry_run: bool, overwrite: bool) -> dict:
    """Give a code to stock that has no serials at all.

    Most stock here is not serialised — 978 infusion sets in a bin are one balance row
    and zero `whs_serial_numbers` rows — so nothing could ever fill the code column for
    them and the screen showed a dash on almost every line. The formula is rendered
    against the LOT instead of a unit: `{seq}` is the balance row id and `{serial}`
    falls back to it, which gives one stable code per item + point + bin + batch.

    Rows that do have serials are left alone: their units carry the real codes and
    /api/warehouse/serials/summary is what surfaces those.
    """
    serialised = {
        (item_id, warehouse_id)
        for item_id, warehouse_id in (await db.execute(
            select(SerialNumber.item_id, SerialNumber.warehouse_id).distinct()
        )).all()
    }
    items = {i.id: i for i in (await db.execute(select(Item))).scalars().all()}
    warehouses = {w.id: w for w in (await db.execute(select(Warehouse))).scalars().all()}

    coded, skipped = 0, 0
    for row in (await db.execute(select(Stock))).scalars().all():
        if (row.item_id, row.warehouse_id) in serialised:
            continue
        if (row.asset_code or row.consumable_code) and not overwrite:
            continue
        item = items.get(row.item_id)
        if item is None:
            skipped += 1
            continue
        is_asset = bool(getattr(item, "is_asset", False))
        template = config["asset_format"] if is_asset else config["consumable_format"]
        code = codeformat.render(template, codeformat.build_values(
            item=item, serial=None, seq=row.id,
            warehouse_code=getattr(warehouses.get(row.warehouse_id), "code", None),
            is_new=codeformat.is_new_item(item, config["legacy_before"]),
            new_flag=config["new_flag"], legacy_flag=config["legacy_flag"],
        ))
        if not code:
            skipped += 1
            continue
        if not dry_run:
            if is_asset:
                row.asset_code, row.consumable_code = code, None
            else:
                row.consumable_code, row.asset_code = code, None
        coded += 1
    return {"unserialised_lots_coded": coded, "lots_skipped": skipped}


async def main(dry_run: bool, recode: bool) -> None:
    async with SessionLocal() as db:
        config = await codeformat.code_settings(db)
        print(f"asset format:      {config['asset_format']}")
        print(f"consumable format: {config['consumable_format']}")
        print()

        report = {}
        report.update(await recode_serials(db, config, dry_run=dry_run, overwrite=recode))
        report.update(await fill_balance_prices(db, dry_run=dry_run))
        report.update(await fill_ledger_prices(db, dry_run=dry_run))
        # After recoding, so the codes copied onto the balance rows are the new ones.
        report.update(await link_single_serial_lots(db, dry_run=dry_run))
        report.update(await code_unserialised_lots(db, config, dry_run=dry_run,
                                                   overwrite=recode))

        if not dry_run:
            await db.commit()
        for key, value in report.items():
            print(f"{key:32} {value}")
        print("\nDRY RUN — nothing written." if dry_run else "\nWritten.")


if __name__ == "__main__":
    asyncio.run(main("--dry-run" in sys.argv, "--recode" in sys.argv))
