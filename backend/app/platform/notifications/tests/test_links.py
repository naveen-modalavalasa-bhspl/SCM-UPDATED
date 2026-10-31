"""Where a notification opens (SCM_0074 / SCM_0075, 2026-10-31).

Clicking a notification — in the bell or on Alerts & Notifications — must open its
own document. Two things made it go nowhere: document types the engine notifies about
had no screen mapped, so they fell back to the approvals inbox ("PO0001 approved"
opened an inbox the PO had left), and PO links were written under `/procurement/pos/`,
which was never a route. `resolve_link` corrects both on READ, so rows already in the
table open the right screen too.
"""
from app.platform.notifications.router import NotificationRow
from app.platform.notifications.service import DOC_LINKS, link_for, resolve_link


def test_a_specific_link_is_kept():
    assert resolve_link("/indents/7", "INDENT", 7) == "/indents/7"
    assert resolve_link("/inventory/adjustments?review=4", "STOCK_ADJUSTMENT", 4) \
        == "/inventory/adjustments?review=4"


def test_the_generic_inbox_link_is_replaced_by_the_document():
    assert resolve_link("/approvals", "PO", 12) == "/pos/12"
    assert resolve_link("/approvals", "RFQ", 3) == "/procurement/rfqs/3"
    assert resolve_link("/approvals", "OWN_STOCK_ISSUE", 6) == "/warehouse/material-issues/6"
    assert resolve_link("/approvals", "REQUISITION", 1) == "/procurement/requisitions/1"
    assert resolve_link("/approvals", "CONSOLIDATION", 2) == "/procurement/consolidations/2"


def test_a_retired_po_path_is_repaired():
    assert resolve_link("/procurement/pos/9", "PO", 9) == "/pos/9"
    assert resolve_link("/procurement/pos/9?tab=packing", "PO", 9) == "/pos/9?tab=packing"


def test_an_indent_status_notification_opens_the_indent():
    assert resolve_link(None, "INDENT_STATUS:ALLOCATED", 10) == "/indents/10"


def test_nothing_to_open_stays_nothing_and_the_inbox_stays_the_inbox():
    assert resolve_link(None, None, None) is None
    assert resolve_link(None, "UNKNOWN_KIND", 5) is None
    assert resolve_link("/approvals", "REMINDER", None) == "/approvals"


def test_new_notifications_for_these_types_are_written_with_their_own_screen():
    for kind in ("PO", "RFQ", "REQUISITION", "CONSOLIDATION", "OWN_STOCK_ISSUE"):
        assert kind in DOC_LINKS
        assert link_for(kind, 1) != "/approvals"


def test_the_list_serves_the_resolved_target():
    row = NotificationRow(id=1, title="PO0001 approved", entity_type="PO", entity_id=12,
                          deep_link="/approvals", is_read=False,
                          created_at="2026-10-31T10:00:00")
    assert row.model_dump()["target"] == "/pos/12"
