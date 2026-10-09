"""Which identifier a storekeeper is asked to read off the goods.

No database: `_tracking_type` reads item flags and one per-line fact, and the
catalogue is a constant. Both are on the issue screen's critical path — the badge
that tells a serial from an IMEI from an asset tag, and the wording of every "N more
to assign" message — so they are worth pinning without a MySQL.

The rule these guard: **`_tracking_type` is wider than `_unit_mode` on purpose.**
`_unit_mode` answers "which column does the matcher validate against" and folds an
asset tag and a consumable lot code into one CODE, because to a matcher they are the
same column. On the shelf they are two different labels in two different places. If
somebody ever collapses the two functions, `test_an_asset_tag_and_a_lot_code_are_not
_the_same_label` fails, which is the point of it.
"""
from types import SimpleNamespace

from app.modules.warehouse import service
from app.modules.warehouse.enums import TRACKING_META, TrackingType


def item(*, serial=False, imei=False, asset=False):
    return SimpleNamespace(is_serial_tracked=serial, is_imei_tracked=imei,
                           is_asset=asset)


def test_a_serial_wins_over_every_other_identifier():
    # The fallback ladder the business asked for: serial, then IMEI, then the code.
    # A handset that also carries a serial is named by the serial.
    assert service._tracking_type(item(serial=True, imei=True, asset=True)) \
        == TrackingType.SERIAL.value


def test_a_handset_with_no_serial_is_named_by_its_imei():
    assert service._tracking_type(item(imei=True)) == TrackingType.IMEI.value


def test_an_asset_tag_and_a_lot_code_are_not_the_same_label():
    # Both are UNIT_MODE_CODE to the matcher. They are not the same thing to read.
    assert service._tracking_type(item(asset=True)) == TrackingType.ASSET.value
    assert service._tracking_type(item()) == TrackingType.CONSUMABLE.value
    assert service._unit_mode(item(asset=True)) == service._unit_mode(item())


def test_an_item_with_nothing_coded_here_promises_nothing():
    # Per LINE, not per item. An item asset-coded in the master with no coded units at
    # THIS point must not draw a badge promising an asset tag over an empty picker.
    assert service._tracking_type(item(asset=True), has_units=False) \
        == TrackingType.NONE.value
    # A serialized item is still serialized: `has_units` is about the code stamped at
    # putaway, and a serial comes off the unit itself.
    assert service._tracking_type(item(serial=True), has_units=False) \
        == TrackingType.SERIAL.value


def test_the_catalogue_names_every_type_it_can_be_asked_about():
    served = {row["code"]: row for row in service.tracking_types()}
    assert set(served) == {member.value for member in TrackingType}
    for row in served.values():
        # The screen renders all three: the badge, "3 of 5 <unit>s", and the tooltip
        # telling the storekeeper what to look for. A blank one draws a blank badge.
        assert row["label"] and row["unit"] and row["hint"]


def test_the_catalogue_is_the_only_place_the_wording_lives():
    # Serving it is what keeps the screen from writing "asset tag" itself. If a code
    # is ever added to the enum without wording, the badge falls back to the raw code
    # and the message to "unit" — so the two must not drift apart.
    assert set(TRACKING_META) == {member.value for member in TrackingType}
