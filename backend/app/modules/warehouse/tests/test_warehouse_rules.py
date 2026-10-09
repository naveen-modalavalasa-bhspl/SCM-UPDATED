"""Pure-logic tests for the warehouse module.

These need no database, so they still run on a machine with no MySQL and still catch
the regressions that matter most: a derived quantity that stops being derived, a
status guard that stops guarding, and an enum value that drifts from the column it
mirrors.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import mysql

from app.core.exceptions import ValidationError
from app.shared.enums import POStatus
from app.modules.warehouse import service
from app.modules.warehouse.enums import (
    InspectionResult, IssueStatus, PutawayStatus, PutawayType, ReceiptStatus, SerialStatus,
)
from app.modules.warehouse.models import (
    Batch, Dispatch,
    DispatchItem,
    DispatchPackage,
    MaterialIssue,
    MaterialIssueLine,
    Receipt,
    ReceiptItem,
)


def test_decimal_coercion_survives_the_junk_mysql_sends():
    # DECIMAL columns arrive as strings over the wire; a bad one must not 500.
    assert service._d("12.500") == Decimal("12.500")


def test_public_label_tokens_are_stable_scoped_and_tamper_evident():
    dispatch_token = service.public_label_token("d", 42)
    package_token = service.public_label_token("p", 42)

    assert dispatch_token == service.public_label_token("d", 42)
    assert service.parse_public_label_token(dispatch_token) == ("d", 42)
    assert service.parse_public_label_token(package_token) == ("p", 42)
    assert dispatch_token != package_token
    assert service.parse_public_label_token(dispatch_token.replace("d42.", "d43.")) is None
    assert service.parse_public_label_token(f"{dispatch_token[:-1]}x") is None
    assert service.parse_public_label_token("not-a-label") is None

    with pytest.raises(ValueError):
        service.public_label_token("d", 0)
    assert service._d(None) == Decimal("0")
    assert service._d("not a number") == Decimal("0")


def test_guard_names_the_status_and_the_way_out():
    # An error that says only "invalid status" leaves the user guessing.
    with pytest.raises(ValidationError) as exc:
        service._guard("COMPLETED", {"DRAFT"}, "edit", "receipt")
    message = str(exc.value.message)
    assert "COMPLETED" in message
    assert "DRAFT" in message
    assert "edit" in message


def test_guard_allows_a_status_in_the_set():
    service._guard("DRAFT", {"DRAFT", "GATE_ENTRY"}, "edit", "receipt")


def test_receipt_rollups_add_the_lines_up():
    receipt = Receipt()
    receipt.items = [
        ReceiptItem(received_qty=Decimal("10"), accepted_qty=Decimal("8"),
                    rejected_qty=Decimal("2"), amount=Decimal("80")),
        ReceiptItem(received_qty=Decimal("5"), accepted_qty=Decimal("5"),
                    rejected_qty=Decimal("0"), amount=Decimal("50")),
    ]
    service._receipt_totals(receipt)

    assert receipt.total_items == 2
    assert receipt.total_received_qty == Decimal("15")
    assert receipt.total_accepted_qty == Decimal("13")
    assert receipt.total_rejected_qty == Decimal("2")
    assert receipt.total_value == Decimal("130")


def test_receipt_rollups_go_to_zero_when_every_line_is_removed():
    receipt = Receipt()
    receipt.items = []
    service._receipt_totals(receipt)
    assert receipt.total_items == 0
    assert receipt.total_received_qty == Decimal("0")


def test_issue_rollup_counts_issued_not_requested():
    # A short issue must roll up as short; totalling the request would hide it.
    issue = MaterialIssue()
    issue.items = [
        MaterialIssueLine(
            requested_qty=Decimal("10"),
            issued_qty=Decimal("7"),
            amount=Decimal("70"),
        ),
        MaterialIssueLine(
            requested_qty=Decimal("4"),
            issued_qty=Decimal("4"),
            amount=Decimal("40"),
        ),
    ]
    service._issue_totals(issue)

    assert issue.total_items == 2
    assert issue.total_qty == Decimal("11")
    assert issue.total_value == Decimal("110")


def test_dispatch_rollup_counts_packages_and_weight():
    dispatch = Dispatch()
    dispatch.items = []
    dispatch.packages = [
        DispatchPackage(weight_kg=Decimal("12.5")),
        DispatchPackage(weight_kg=Decimal("7.5")),
    ]
    service._dispatch_totals(dispatch)

    assert dispatch.total_packages == 2
    assert dispatch.total_weight_kg == Decimal("20.0")


@pytest.mark.parametrize(
    ("inspected", "accepted", "expected"),
    [
        ("0", "0", InspectionResult.PENDING.value),
        ("10", "10", InspectionResult.PASSED.value),
        ("10", "0", InspectionResult.FAILED.value),
        ("10", "6", InspectionResult.PARTIAL.value),
    ],
)
def test_inspection_result_follows_the_split(inspected, accepted, expected):
    assert service._derive_result(Decimal(inspected), Decimal(accepted)) == expected


def test_approver_label_reads_as_who_is_holding_it():
    assert service._approver_label([]) is None
    assert service._approver_label([{"name": "Asha"}]) == "Asha"
    assert service._approver_label(
        [{"name": "Asha"}, {"name": "Ravi"}, {"name": "Sam"}]) == "Asha +2"


def test_approver_label_ignores_rows_with_no_name():
    assert service._approver_label([{"id": 4}]) is None


def test_lower_case_enums_match_the_mysql_enum_members():
    # `whs_warehouse_items` and `whs_serial_numbers` are MySQL ENUMs whose members the
    # DB team defined in lower case. Upper-casing them raises a truncation error on
    # insert, so this is the test that stops a well-meaning tidy-up.
    assert PutawayStatus.COMPLETED.value == "completed"
    assert PutawayStatus.IN_PROGRESS.value == "in_progress"
    assert PutawayType.SYSTEM_DIRECTED.value == "system_directed"
    assert SerialStatus.AVAILABLE.value == "available"

    # Everything else is UPPER_SNAKE, as the varchar columns store it.
    assert ReceiptStatus.COMPLETED.value == "COMPLETED"
    assert IssueStatus.PENDING_APPROVAL.value == "PENDING_APPROVAL"


def test_report_column_helper_marks_numeric_columns():
    assert service._col("qty", "Quantity", True) == {
        "key": "qty", "header": "Quantity", "numeric": True}
    assert service._col("code", "Code")["numeric"] is False


def test_batch_expiry_order_is_valid_mysql():
    stmt = select(Batch).order_by(Batch.expiry_date.is_(None), Batch.expiry_date.asc())
    sql = str(stmt.compile(dialect=mysql.dialect()))
    assert "NULLS LAST" not in sql
    assert "stk_batches.expiry_date IS NULL" in sql


# --------------------------------------------------------------------------- #
#  The consignment -> GRN line grouping (the 10-rows-of-1 bug)
# --------------------------------------------------------------------------- #

def _dispatch_line(**overrides):
    """A dispatch line with every field the grouper reads, defaulted to "nothing"."""
    line = DispatchItem(
        item_id=overrides.pop("item_id", 1),
        quantity=Decimal(str(overrides.pop("quantity", 1))),
    )
    defaults = {
        "item_code": "ITM-1", "item_name": "8 GB Memory Card", "uom_code": "NOS",
        "indent_id": None, "indent_no": None, "rate": None, "batch_id": None,
        "batch_no": None, "mfg_date": None, "expiry_date": None,
        "serial_no": None, "imei_no": None,
    }
    for field, value in {**defaults, **overrides}.items():
        setattr(line, field, value)
    return line


def test_serialised_units_collapse_into_one_line():
    # The bug: ten handsets dispatched as ten rows of qty 1 arrived at the LIP as ten
    # GRN lines, and were inwarded as ten separate stock lines.
    lines = [_dispatch_line(serial_no=f"SN{n}") for n in range(10)]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert len(rows) == 1
    assert rows[0]["ordered_qty"] == Decimal("10")
    assert rows[0]["received_qty"] == Decimal("10")
    assert rows[0]["accepted_qty"] == Decimal("10")
    # Collapsing the rows must not lose the units — every serial is still named.
    assert rows[0]["serial_numbers"] == [f"SN{n}" for n in range(10)]


def test_imeis_are_collected_onto_the_line_too():
    lines = [_dispatch_line(serial_no=f"SN{n}", imei_no=f"IMEI{n}") for n in range(3)]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert rows[0]["imei_numbers"] == ["IMEI0", "IMEI1", "IMEI2"]


def test_two_batches_of_one_item_stay_two_lines():
    # Each batch has its own expiry, so adding them together would receive stock the
    # receiver cannot tell apart afterwards.
    lines = [
        _dispatch_line(quantity=4, batch_no="B1"),
        _dispatch_line(quantity=6, batch_no="B2"),
    ]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert [r["ordered_qty"] for r in rows] == [Decimal("4"), Decimal("6")]
    assert [r["batch_no"] for r in rows] == ["B1", "B2"]


def test_one_item_serving_two_indents_stays_two_lines():
    # A consolidated consignment owes each request separately.
    lines = [
        _dispatch_line(quantity=2, indent_id=11, indent_no="IND/1"),
        _dispatch_line(quantity=3, indent_id=22, indent_no="IND/2"),
    ]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert [r["indent_no"] for r in rows] == ["IND/1", "IND/2"]
    assert [r["ordered_qty"] for r in rows] == [Decimal("2"), Decimal("3")]


def test_different_items_are_never_merged():
    lines = [_dispatch_line(item_id=1, quantity=5), _dispatch_line(item_id=2, quantity=7)]

    rows = service._group_dispatch_lines(lines, {}, {}, {})

    assert [r["item_id"] for r in rows] == [1, 2]


def test_an_unserialised_line_is_left_exactly_as_it_was():
    # The common case must be untouched by the grouping: one line in, one line out,
    # with no serial list invented for it.
    rows = service._group_dispatch_lines([_dispatch_line(quantity=25)], {}, {}, {})

    assert len(rows) == 1
    assert rows[0]["ordered_qty"] == Decimal("25")
    assert rows[0]["serial_numbers"] is None
    assert rows[0]["imei_numbers"] is None

# ---------------------------------------------------------------------------
# FEFO, on a pick the storekeeper moves off the batch that was allocated
# ---------------------------------------------------------------------------
#
# The rule is one line and the consequence of getting it wrong is invisible: stock
# quietly issued out of order leaves an earlier batch on the shelf to expire, and
# nothing downstream ever says so. See `service._fefo_swap_allowed`.

def _batch(expiry: str | None) -> Batch:
    return Batch(batch_no="B", expiry_date=date.fromisoformat(expiry) if expiry else None)


def test_a_batch_may_be_swapped_for_one_expiring_the_same_day():
    # The one swap FEFO cannot tell apart — two batches, one date, either will do.
    assert service._fefo_swap_allowed(_batch("2026-08-31"), [_batch("2026-08-31")])


def test_a_later_batch_may_not_jump_the_queue():
    # Taking SEP first leaves AUG behind to expire. This is the whole rule.
    assert not service._fefo_swap_allowed(_batch("2026-09-30"), [_batch("2026-08-31")])


def test_an_earlier_batch_is_refused_too_and_that_is_deliberate():
    # It is not "no later than". The allocation is what was approved, and an issue
    # silently taking a different batch — in either direction — is a document that no
    # longer says what was signed. Inventory reallocates; the shelf does not.
    assert not service._fefo_swap_allowed(_batch("2026-07-31"), [_batch("2026-08-31")])


def test_an_undated_batch_matches_only_another_undated_one():
    # "No expiry recorded" is nobody having written one down, not "never expires".
    # Read as a distant date it would be swappable for anything on the shelf.
    assert service._fefo_swap_allowed(_batch(None), [_batch(None)])
    assert not service._fefo_swap_allowed(_batch(None), [_batch("2026-08-31")])
    assert not service._fefo_swap_allowed(_batch("2026-08-31"), [_batch(None)])


def test_one_of_several_allocated_batches_is_enough():
    # An ask served out of two batches allocates both; matching either is FEFO-safe.
    allocated = [_batch("2026-08-31"), _batch("2026-09-30")]
    assert service._fefo_swap_allowed(_batch("2026-09-30"), allocated)


def test_nothing_allocated_constrains_nothing():
    # A manual issue has nothing signed behind it to depart from. Refusing every batch
    # here would make an indent-less issue impossible to raise at all.
    assert service._fefo_swap_allowed(_batch("2027-01-01"), [])


def test_an_omitted_issued_quantity_means_the_whole_line():
    # `_apply_issue_lines` reads a missing `issued_qty` as "all of it". A guard reading
    # the same field as zero would wave through exactly the lines that take the most.
    class Line:
        requested_qty = Decimal("10")
        issued_qty = None

    assert service._line_issued(Line()) == Decimal("10")
    Line.issued_qty = Decimal("4")
    assert service._line_issued(Line()) == Decimal("4")


def test_a_line_naming_no_location_says_so_in_zeroes():
    # NO_BIN / NO_BATCH are 0 everywhere in this module, never NULL and never a real
    # id — `_claim_units`, `move_stock_out` and the availability probe all read them
    # that way, and a guard using a different currency would narrow on bin 0.
    class Line:
        bin_id = None
        batch_id = 0

    assert service._line_slot(Line()) == (0, 0)

# ---------------------------------------------------------------------------
# Receiving an order twice
# ---------------------------------------------------------------------------
#
# BHS/104/2026-27/PO0013 was received in full by REC0031 and then, the next day, in
# full again by REC0033 — nineteen lines, every one at the whole ordered quantity, for
# goods that were ordered once. Two independent causes, one per door:
#
#   * `po_lines` was defined TWICE in service.py, and the second definition — the one
#     Python keeps — read `pro_po_items.received_quantity`, a column nothing in this
#     module writes. So the prefill offered the whole order again;
#   * nothing at the save asked the order whether it still owed any of it.


def test_only_one_po_lines_survives_the_module():
    """The bug was a shadowed definition, so this is the test for the bug.

    Two `async def po_lines` in one module is not an error anywhere — the second
    silently wins, the first becomes unreachable, and the only symptom is a screen
    quietly answering from the wrong code. Cheap to check for the whole module, so it
    is checked for the whole module.
    """
    import ast
    import collections
    from pathlib import Path

    source = Path(service.__file__).read_text(encoding="utf-8")
    names = [node.name for node in ast.parse(source).body
             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    repeated = [name for name, count in collections.Counter(names).items() if count > 1]
    assert repeated == [], f"shadowed definitions in warehouse/service.py: {repeated}"


def test_the_surviving_po_lines_asks_the_receipts_not_the_column():
    # `pro_po_items.received_quantity` is written by exactly one path — logistics'
    # original GRN table — and by nothing here, so it reads 0.000 on every order
    # received through Material Inward. A prefill trusting it offers the whole order
    # again on the second delivery.
    import inspect

    source = inspect.getsource(service.po_lines)
    assert "po_received_by_line" in source
    assert "received_quantity" not in source


def _note_line(po_item_id, despatched):
    return SimpleNamespace(po_item_id=po_item_id, item_id=7, item_code="ITEM",
                           item_name="Item", uom_code="NOS",
                           despatched_qty=Decimal(despatched), batch_no=None,
                           mfg_date=None, expiry_date=None)


def test_a_despatch_note_line_is_capped_at_what_the_order_still_owes():
    # The note says the vendor sent 15. The order has 15 on that line and 10 of them
    # are already on a receipt, so what can still be received here is 5 — whatever the
    # paperwork says was loaded.
    line = service._despatch_prefill_line(
        _note_line(62, "15"),
        ordered={62: Decimal("15")}, rates={62: None},
        already={62: Decimal("10")},
    )
    assert line is not None
    assert line.despatched_qty == Decimal("5")


def test_a_fully_received_note_line_is_not_offered_at_all():
    # A despatch note REPLACES the lines on the form. Re-opening the same note against
    # an order already received filled a whole second receipt with it.
    assert service._despatch_prefill_line(
        _note_line(62, "15"),
        ordered={62: Decimal("15")}, rates={62: None},
        already={62: Decimal("15")},
    ) is None


def test_a_note_line_with_no_order_line_behind_it_is_not_capped():
    # There is no order to measure it against, and refusing it would stop real goods
    # at the gate over a paperwork mismatch.
    line = service._despatch_prefill_line(
        _note_line(None, "12"), ordered={}, rates={}, already={},
    )
    assert line is not None
    assert line.despatched_qty == Decimal("12")


def test_the_note_is_not_inflated_to_the_outstanding_quantity():
    # The cap is a ceiling, never a floor. A vendor who sent 4 of the 15 still owed has
    # sent 4, and prefilling 15 would have the gate confirm goods that are not there.
    line = service._despatch_prefill_line(
        _note_line(62, "4"),
        ordered={62: Decimal("15")}, rates={62: None}, already={},
    )
    assert line.despatched_qty == Decimal("4")

# ---------------------------------------------------------------------------
# Where a purchase order stands once the warehouse has received what it has
# ---------------------------------------------------------------------------


def test_a_fully_received_order_is_received():
    assert service._po_status_after(
        POStatus.ACCEPTED_BY_SUPPLIER.value,
        complete=True, received=Decimal("19"),
    ) == POStatus.RECEIVED.value


def test_a_part_delivery_is_partially_received():
    assert service._po_status_after(
        POStatus.SENT_TO_VENDOR.value,
        complete=False, received=Decimal("4"),
    ) == POStatus.PARTIALLY_RECEIVED.value


def test_an_order_nothing_has_arrived_against_is_left_alone():
    # The old code set PARTIALLY_RECEIVED on a zero total, which tells a buyer a
    # delivery has started when none has.
    assert service._po_status_after(
        POStatus.SENT_TO_VENDOR.value, complete=False, received=Decimal("0"),
    ) is None


def test_cancelling_the_only_receipt_reopens_the_order():
    # The way back matters as much as the way forward: an order stuck at RECEIVED has
    # left the Material Inward dropdown, and the delivery that actually turns up has
    # nowhere to be booked in.
    assert service._po_status_after(
        POStatus.RECEIVED.value, complete=False, received=Decimal("0"),
    ) == POStatus.ACCEPTED_BY_SUPPLIER.value
    assert service._po_status_after(
        POStatus.PARTIALLY_RECEIVED.value, complete=False, received=Decimal("0"),
    ) == POStatus.ACCEPTED_BY_SUPPLIER.value


def test_a_receipt_never_reopens_an_order_a_person_closed():
    # Cancelled, closed, still in approval — those are somebody's decision, and a
    # delivery landing against one is not the system's cue to overrule it.
    for status in (POStatus.CANCELLED.value, POStatus.CLOSED.value,
                   POStatus.DRAFT.value, POStatus.PENDING_APPROVAL.value,
                   POStatus.APPROVED.value):
        assert service._po_status_after(
            status, complete=True, received=Decimal("19"),
        ) is None, status


def test_a_draft_receipt_is_a_claim_and_not_a_delivery():
    """Which receipts have DECLARED goods received.

    A draft is somebody typing: it holds a claim on the order — that is what stops two
    storekeepers each booking in the same delivery — but it has not received anything,
    and an order must not read RECEIVED because of one. Cancelled is out for the
    obvious reason. Everything from SUBMITTED onward has arrived; QC and put-away are
    what happens to goods that are already in the building.
    """
    assert ReceiptStatus.DRAFT.value not in service.RECEIVED_RECEIPT_STATUSES
    assert ReceiptStatus.GATE_ENTRY.value not in service.RECEIVED_RECEIPT_STATUSES
    assert ReceiptStatus.CANCELLED.value not in service.RECEIVED_RECEIPT_STATUSES
    for status in (ReceiptStatus.SUBMITTED, ReceiptStatus.PENDING_QC,
                   ReceiptStatus.QC_PASSED, ReceiptStatus.COMPLETED):
        assert status.value in service.RECEIVED_RECEIPT_STATUSES
