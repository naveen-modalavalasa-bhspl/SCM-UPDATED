"""Warranty per received unit on a GRN (MoM 2026-11-18, point 25).

Pure: units pair serial and IMEI by position, and the status reads the end date.
DB: "same warranty for all" is one upload and one row per unit, a second save
replaces a unit's warranty rather than adding one, a unit not on the line is refused,
an end before the start is refused, and a scan finds the warranty by item + code.
"""
import io
from datetime import date, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from starlette.datastructures import UploadFile

from app.core.exceptions import ValidationError
from app.modules.warehouse import warranty
from app.modules.warehouse.enums import ReceiptStatus
from app.modules.warehouse.models import Receipt, ReceiptItem, ReceiptUnitWarranty
from app.platform.settings import attachments
from app.platform.settings.models import Attachment

PDF = b"%PDF-1.4\n%warranty card\n"


def test_units_pair_serial_and_imei_by_position():
    line = SimpleNamespace(serial_numbers=["SN1", "SN2"], imei_numbers=["IM1", "IM2", "IM3"])
    units = warranty.line_units(line)
    assert [u["code"] for u in units] == ["SN1", "SN2", "IM3"]
    assert units[0] == {"code": "SN1", "serial_number": "SN1", "imei": "IM1"}
    assert units[2]["serial_number"] is None


def test_status_reads_the_end_date():
    today = date(2026, 11, 20)
    assert warranty.status_of(date(2027, 11, 20), today)[0] == "ACTIVE"
    assert warranty.status_of(date(2026, 12, 10), today) == ("EXPIRING", 20)
    assert warranty.status_of(date(2026, 11, 19), today) == ("EXPIRED", -1)
    assert warranty.status_sentence(date(2026, 11, 20), today) == "Ends today"
    assert warranty.status_sentence(date(2026, 11, 10), today) == "Expired 10 days ago"


def _pdf():
    return UploadFile(file=io.BytesIO(PDF), filename="card.pdf")


async def _grn(db):
    receipt = Receipt(grn_no="GRN-W1", receipt_type="PURCHASE", grn_date=date(2026, 11, 20),
                      warehouse_id=1, warehouse_name="Main", status=ReceiptStatus.SUBMITTED.value)
    db.add(receipt)
    await db.flush()
    line = ReceiptItem(receipt_id=receipt.id, line_no=1, item_id=501, item_code="TAB-1",
                       item_name="Tablet", received_qty=3, accepted_qty=3,
                       serial_numbers=["SN1", "SN2", "SN3"], imei_numbers=["IM1", "IM2", "IM3"])
    db.add(line)
    await db.commit()
    return receipt.id, line.id


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(attachments, "UPLOAD_ROOT", tmp_path)


@pytest.mark.asyncio
async def test_same_warranty_for_all_is_one_document_and_a_row_per_unit(db, store):
    receipt_id, line_id = await _grn(db)
    start, end = date.today(), date.today() + timedelta(days=365)
    out = await warranty.save_warranty(db, receipt_id, receipt_item_id=line_id,
                                       codes='["SN1","SN2","SN3"]', start_date=start.isoformat(),
                                       end_date=end.isoformat(), card_no=None, upload=_pdf())
    assert (out["covered"], out["total"]) == (3, 3)
    assert (await db.scalar(select(func.count()).select_from(Attachment))) == 1
    docs = {u["warranty"]["attachment_id"] for u in out["lines"][0]["units"]}
    assert len(docs) == 1

    # A second save on one unit replaces its warranty — never a second row.
    doc_id = docs.pop()
    out = await warranty.save_warranty(db, receipt_id, receipt_item_id=line_id, codes=["SN2"],
                                       start_date=start, end_date=start + timedelta(days=10),
                                       card_no="W-22", attachment_id=doc_id)
    assert (await db.scalar(select(func.count()).select_from(ReceiptUnitWarranty))) == 3
    sn2 = next(u for u in out["lines"][0]["units"] if u["code"] == "SN2")["warranty"]
    assert (sn2["card_no"], sn2["status"]) == ("W-22", "EXPIRING")

    found = await warranty.for_units(db, 501, [None, "SN2"])
    assert found.card_no == "W-22"
    assert await warranty.for_units(db, 999, ["SN2"]) is None


@pytest.mark.asyncio
async def test_refusals_name_the_problem(db, store):
    receipt_id, line_id = await _grn(db)
    today = date.today().isoformat()
    with pytest.raises(ValidationError, match="not on this line"):
        await warranty.save_warranty(db, receipt_id, receipt_item_id=line_id, codes=["SN9"],
                                     start_date=today, end_date=today, card_no=None, upload=_pdf())
    with pytest.raises(ValidationError, match="cannot end before it starts"):
        await warranty.save_warranty(db, receipt_id, receipt_item_id=line_id, codes=["SN1"],
                                     start_date=today, end_date="2020-01-01", card_no=None,
                                     upload=_pdf())
    with pytest.raises(ValidationError, match="Attach the warranty card"):
        await warranty.save_warranty(db, receipt_id, receipt_item_id=line_id, codes=["SN1"],
                                     start_date=today, end_date=today, card_no=None)
