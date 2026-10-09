"""What a stock movement line must name, read off the item master.

No database: every refusal pinned here is decided before `_movement_units` reads a
row, and the scope clause is checked by compiling it. The rules they guard:

- **The item master decides, not the screen.** A serial or IMEI item names one
  identifier per unit moved; an item with no identifier names none, and naming one
  anyway is refused rather than silently ignored.
- **Exactly the quantity.** Not "up to": a unit a movement does not name stays filed
  at the source location after its stock has left, and Stock Balance then shows the
  units in one bay and the quantity in another.
- **An unbatched line means the unbatched lot**, `IS NULL`, never "any batch".
"""
import asyncio
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import service


def item(*, serial=False, imei=False, asset=False, code="ITM-0001"):
    return SimpleNamespace(id=7, code=code, is_serial_tracked=serial,
                           is_imei_tracked=imei, is_asset=asset, uom_id=None)


#: The code toggle switched OFF for every item, so an untracked item reads untracked
#: without a settings row.
NOTHING_CODED = {"tracked_items": []}


def resolve(it, values, quantity, config=NOTHING_CODED):
    return asyncio.run(service._movement_units(
        None, item=it, warehouse_id=1, bin_id=2, batch_id=None,
        values=values, quantity=quantity, code_config=config))


def test_a_serial_item_must_name_one_serial_per_unit_moved():
    with pytest.raises(ValidationError, match="select exactly 3 serial numbers"):
        resolve(item(serial=True), ["A1", "A2"], 3)


def test_an_imei_item_is_asked_for_imeis_not_serials():
    with pytest.raises(ValidationError, match="IMEI numbers"):
        resolve(item(imei=True), [], 1)


def test_a_coded_item_is_held_to_the_same_count():
    # The toggle on for this item: putaway mints it a code per unit, so a movement
    # names them. Countable because it carries no measured unit of measure.
    with pytest.raises(ValidationError, match="select exactly 2 unit codes"):
        resolve(item(asset=True), ["X"], 2, config={"tracked_items": ["ITM-0001"]})


def test_the_same_value_twice_is_refused_by_name():
    with pytest.raises(ValidationError, match="A1 named more than once"):
        resolve(item(serial=True), ["A1", " A1 "], 2)


def test_a_named_quantity_must_be_whole():
    with pytest.raises(ValidationError, match="whole number"):
        resolve(item(serial=True), ["A1"], 1.5)


def test_an_untracked_item_names_nothing_and_is_asked_for_nothing():
    assert resolve(item(), [], 40) == ([], [])


def test_naming_units_of_an_untracked_item_is_refused():
    with pytest.raises(ValidationError, match="not tracked by serial, IMEI or unit code"):
        resolve(item(), ["STRAY"], 1)


def compiled(clause) -> str:
    return str(clause.compile(compile_kwargs={"literal_binds": True}))


def test_an_unbatched_line_is_the_unbatched_lot_not_any_batch():
    sql = compiled(service._unit_scope_clause(
        item_id=7, warehouse_id=1, bin_id=2, batch_id=None))
    assert "batch_id IS NULL" in sql


def test_a_batched_line_is_that_batch():
    sql = compiled(service._unit_scope_clause(
        item_id=7, warehouse_id=1, bin_id=2, batch_id=9))
    assert "batch_id = 9" in sql


def test_each_mode_is_matched_on_its_own_column():
    assert "imei IN" in compiled(service._unit_name_clause(service.UNIT_MODE_IMEI, ["1"]))
    code_sql = compiled(service._unit_name_clause(service.UNIT_MODE_CODE, ["1"]))
    assert "asset_code IN" in code_sql and "consumable_code IN" in code_sql


def test_a_movement_with_no_line_of_its_own_offers_only_unclaimed_units():
    sql = compiled(service._unit_claim_free_clause(None))
    assert "Reserved for issue" in sql and "remarks IS NULL" in sql
