"""QA-5 BUG_0015: the Procurement Ledger's "With" column read only the current
approver, so every document outside approval — drafts, approved requisitions, orders
out with the vendor, every quotation — said "with nobody".

Pure: compiles the register's SELECT for MySQL and reads the CASE it carries, so it
runs without a database.
"""
from sqlalchemy.dialects import mysql

from app.modules.procurement import ledger
from app.shared.enums import POStatus, QuotationStatus, RFQStatus, RequisitionStatus


def _sql() -> str:
    return str(ledger.source().compile(
        dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))


def test_every_rung_derives_with_from_its_status():
    sql = _sql()
    # One CASE per rung of the chain: requisition, RFQ, quotation, purchase order.
    assert sql.count("CASE WHEN") == 4


def test_a_quotation_is_no_longer_hard_coded_to_nobody():
    sql = _sql()
    assert f"pro_quotations.status = '{QuotationStatus.SUBMITTED.value}'" in sql
    assert ledger.COMPARING in sql


def test_live_statuses_name_somebody():
    sql = _sql()
    for table, status in [
        ("pro_requisitions", RequisitionStatus.DRAFT),
        ("pro_requisitions", RequisitionStatus.APPROVED),
        ("pro_rfqs", RFQStatus.PUBLISHED),
        ("pro_rfqs", RFQStatus.CLOSED),
        ("pro_purchase_orders", POStatus.SENT_TO_VENDOR),
        ("pro_purchase_orders", POStatus.PARTIALLY_RECEIVED),
    ]:
        assert f"{table}.status = '{status.value}'" in sql, (table, status)


def test_in_approval_never_goes_blank():
    # No resolved approver still reads "Approver", not "—".
    assert "'Approver'" in _sql()


def test_terminal_statuses_fall_through_to_nobody():
    sql = _sql()
    for status in (POStatus.CLOSED, POStatus.CANCELLED, POStatus.REJECTED):
        assert f"pro_purchase_orders.status = '{status.value}'" not in sql
