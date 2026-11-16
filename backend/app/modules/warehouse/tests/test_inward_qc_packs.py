"""Inward QC decided by the PACK (2026-10-27) — `packing.inspection_line_packs`.

Pure: the ladder lookup is stubbed, so no database is needed. The GRN counted the
supplier's 120 NOS as 2 full cartons of 50 and one part carton holding 20.
"""
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import packing as wh_packing
from app.shared import packing

LADDER = packing.Ladder(
    hierarchy_id=1, hierarchy_name="Cartoon of 50", base_uom="NOS",
    levels=(packing.Level(0, "Loose", Decimal(1), Decimal(1)),
            packing.Level(1, "cartoon", Decimal(50), Decimal(50), item_packaging_id=7)))
ITEM = SimpleNamespace(id=1, code="ELEC-1003", uom_code="NOS")
COUNTED = [{"item_packaging_id": 7, "level": 1, "name": "cartoon", "size": "50", "qty": "2"},
           {"item_packaging_id": 7, "level": 1, "name": "cartoon", "size": "50", "qty": "1",
            "fill": "20"}]
LINE = SimpleNamespace(pack_breakdown=COUNTED, pack_hierarchy_id=1)


@pytest.fixture(autouse=True)
def _ladder(monkeypatch):
    async def ladder(_db, _item_id, _hid):
        return LADDER
    monkeypatch.setattr(wh_packing.packs, "ladder", ladder)


def _carton(qty, fill=None):
    out = {"item_packaging_id": 7, "level": 1, "qty": qty}
    if fill is not None:
        out["fill"] = fill
    return out


async def test_a_carton_rejected_whole_and_units_out_of_another():
    accepted, rejected = await wh_packing.inspection_line_packs(
        None, item=ITEM, receipt_line=LINE, inspected=Decimal(120),
        accepted_in=[_carton(1, 45), _carton(1, 20)],
        rejected_in=[_carton(1), {"item_packaging_id": None, "level": 0, "qty": 5}])
    assert packing.base_of(accepted) == Decimal(65)
    assert packing.base_of(rejected) == Decimal(55)
    assert all(e["hierarchy"] == "Cartoon of 50" for e in accepted + rejected)


async def test_qc_cannot_decide_a_carton_the_grn_never_counted():
    with pytest.raises(ValidationError, match="the GRN counted 3"):
        await wh_packing.inspection_line_packs(
            None, item=ITEM, receipt_line=LINE, inspected=Decimal(120),
            accepted_in=[_carton(3)], rejected_in=[_carton(1, 20)])


async def test_the_packs_must_add_up_to_what_was_inspected():
    with pytest.raises(ValidationError, match="but 120 was inspected"):
        await wh_packing.inspection_line_packs(
            None, item=ITEM, receipt_line=LINE, inspected=Decimal(120),
            accepted_in=[_carton(2)], rejected_in=None)


async def test_a_line_decided_by_quantity_carries_no_packs():
    assert await wh_packing.inspection_line_packs(
        None, item=ITEM, receipt_line=LINE, inspected=Decimal(120),
        accepted_in=None, rejected_in=None) == (None, None)


async def test_packs_on_a_line_the_grn_did_not_count_in_packs_are_refused():
    with pytest.raises(ValidationError, match="did not count this line in packs"):
        await wh_packing.inspection_line_packs(
            None, item=ITEM, receipt_line=SimpleNamespace(pack_breakdown=None,
                                                          pack_hierarchy_id=None),
            inspected=Decimal(10), accepted_in=[_carton(1)], rejected_in=None)
