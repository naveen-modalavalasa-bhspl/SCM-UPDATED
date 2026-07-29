"""Pure-logic tests for the warehouse module.

These need no database, so they still run on a machine with no MySQL and still catch
the regressions that matter most: a derived quantity that stops being derived, a
status guard that stops guarding, and an enum value that drifts from the column it
mirrors.
"""
from decimal import Decimal

import pytest

from app.core.exceptions import ValidationError
from app.modules.warehouse import service
from app.modules.warehouse.enums import (
    InspectionResult, IssueStatus, PutawayStatus, PutawayType, ReceiptStatus, SerialStatus,
)
from app.modules.warehouse.models import (
    Dispatch,
    DispatchPackage,
    MaterialIssue,
    MaterialIssueLine,
    Receipt,
    ReceiptItem,
)


def test_decimal_coercion_survives_the_junk_mysql_sends():
    # DECIMAL columns arrive as strings over the wire; a bad one must not 500.
    assert service._d("12.500") == Decimal("12.500")
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
