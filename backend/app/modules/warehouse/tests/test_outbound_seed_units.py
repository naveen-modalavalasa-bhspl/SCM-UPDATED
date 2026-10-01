"""Which identifiers an auto-raised outward inspection opens with.

No database: `_outbound_seed_units` reads item flags and unit rows only. It is
on the outward-QC critical path — the modal opens with whatever this seeds, and
a line seeded with nothing opens with every unit rejected.

The rule these guard: **every kind is seeded, in the issue picker's own
currency**. Seeding only serial-tracked lines left IMEI / asset / consumable
lines stored with no units while accepting the whole offered set, which the
picker reads as "every unit rejected" (QC0013's SIM line at 0/3, QC0056's
reagent pack at 0/2). If somebody ever re-gates this on `is_serial_tracked`,
`test_an_imei_line_is_seeded_with_its_imeis` and
`test_a_consumable_line_is_seeded_with_its_lot_codes` fail, which is the point
of them.
"""
from types import SimpleNamespace

from app.modules.warehouse import service


def item(*, serial=False, imei=False, asset=False):
    return SimpleNamespace(is_serial_tracked=serial, is_imei_tracked=imei,
                           is_asset=asset)


def row(id, *, item_id=7, batch_id=11, serial=None, imei=None, asset=None,
        consumable=None):
    return SimpleNamespace(id=id, item_id=item_id, batch_id=batch_id,
                           serial_number=serial, imei=imei, asset_code=asset,
                           consumable_code=consumable)


def test_a_serial_line_is_seeded_with_its_serials():
    rows = [row(1, serial="SN-1", asset="AST-1"),
            row(2, serial="SN-2", asset="AST-2")]
    assert service._outbound_seed_units(
        rows, item=item(serial=True), item_id=7, batch_id=11) == ["SN-1", "SN-2"]


def test_an_imei_line_is_seeded_with_its_imeis():
    rows = [row(1, serial="SN-1", imei="IMEI-1"),
            row(2, serial="SN-2", imei="IMEI-2")]
    assert service._outbound_seed_units(
        rows, item=item(imei=True), item_id=7, batch_id=11) == ["IMEI-1", "IMEI-2"]


def test_an_asset_line_is_seeded_with_its_asset_tags():
    rows = [row(1, serial="SN-1", asset="AST-1"),
            row(2, serial="SN-2", asset="AST-2")]
    assert service._outbound_seed_units(
        rows, item=item(asset=True), item_id=7, batch_id=11) == ["AST-1", "AST-2"]


def test_a_consumable_line_is_seeded_with_its_lot_codes():
    rows = [row(1, serial="LOT-1", consumable="LOT-1"),
            row(2, serial="LOT-2", consumable="LOT-2")]
    assert service._outbound_seed_units(
        rows, item=item(), item_id=7, batch_id=11) == ["LOT-1", "LOT-2"]


def test_a_row_with_none_of_its_modes_identifiers_still_contributes():
    # An IMEI-tracked row with no IMEI recorded still has its code in
    # `serial_number`. Seeding nothing for it reads as rejected by default.
    rows = [row(1, serial="303040-SIM-0001")]
    assert service._outbound_seed_units(
        rows, item=item(imei=True), item_id=7, batch_id=11) == ["303040-SIM-0001"]


def test_a_row_with_no_identifier_at_all_contributes_nothing():
    rows = [row(1)]
    assert service._outbound_seed_units(
        rows, item=item(imei=True), item_id=7, batch_id=11) == []


def test_a_unit_indexed_twice_is_seeded_once():
    # `_issued_serial_index` files one row under every identifier it carries,
    # so the same unit arrives twice. Seeding it twice doubled the accepted
    # count (196 units read as 392).
    unit = row(1, serial="SN-1", asset="AST-1")
    assert service._outbound_seed_units(
        [unit, unit], item=item(serial=True), item_id=7,
        batch_id=11) == ["SN-1"]


def test_only_this_lines_units_are_seeded():
    rows = [row(1, serial="MINE-1"),
            row(2, serial="OTHER-ITEM", item_id=9),
            row(3, serial="OTHER-BATCH", batch_id=12)]
    assert service._outbound_seed_units(
        rows, item=item(serial=True), item_id=7, batch_id=11) == ["MINE-1"]


def test_no_rows_seeds_nothing():
    assert service._outbound_seed_units(
        [], item=item(serial=True), item_id=7, batch_id=11) == []
