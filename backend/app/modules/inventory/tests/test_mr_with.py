"""SCM_0155: the Material Requests register says WHERE every request is.

"With" read the approver snapshot, which is cleared the moment a request is approved —
so everything procurement was actually working on read "—". `mr_with` answers for every
status. Pure: no database.
"""
from app.modules.inventory.service import mr_with
from app.shared.enums import MRStatus


def test_in_approval_it_is_with_the_live_approvers():
    assert mr_with(MRStatus.PENDING_APPROVAL.value, pending=["Anita Rao", "Ravi K"],
                   approver="Old snapshot") == ("Anita Rao, Ravi K", "Waiting for approval")


def test_the_snapshot_stands_in_when_the_queue_has_nobody():
    assert mr_with(MRStatus.PENDING_APPROVAL.value, approver="Anita Rao")[0] == "Anita Rao"


def test_approved_it_is_with_procurement_and_names_the_requisition():
    assert mr_with(MRStatus.APPROVED.value, requisitions=["REQ0012"]) == (
        "Procurement", "On REQ0012")
    assert mr_with(MRStatus.APPROVED.value) == ("Procurement", "Waiting for a requisition")


def test_ordered_and_received_say_so():
    assert mr_with(MRStatus.ORDERED.value, requisitions=["REQ0012"]) == (
        "Procurement", "Ordered · REQ0012")
    assert mr_with(MRStatus.RECEIVED.value) == ("Completed", "Goods received")


def test_sent_back_is_with_whoever_it_went_back_to():
    assert mr_with(MRStatus.RETURNED_FOR_CORRECTION.value, approver="Ravi K",
                   raiser="Sunil") == ("Ravi K", "Sent back for a fix")


def test_a_closed_request_is_with_nobody():
    assert mr_with(MRStatus.REJECTED.value) == ("—", "Rejected")
    assert mr_with(MRStatus.CANCELLED.value) == ("—", "Cancelled")
    assert mr_with(MRStatus.DRAFT.value, raiser="Sunil") == ("Sunil", "Draft — not sent yet")
