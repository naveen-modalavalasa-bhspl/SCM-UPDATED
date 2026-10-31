"""Writing `sys_notifications` rows — the other half of the bell.

`platform/admin/notifications.py` decides WHO to tell for a configured event rule.
This decides that someone gets told at all, and is what the workflow engine calls when
a document lands on a desk. The two are separate on purpose: an approval notifies the
person the engine actually routed it to, with no configuration needed, whereas an
event rule is an administrator saying "also copy in the plant head".

Never raises. A notification is a courtesy on top of a business transaction; failing to
send one must not roll back the approval that triggered it.
"""
import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.platform.settings.models import Notification

logger = logging.getLogger(__name__)

# Where a document lives in the UI. Approvers are pointed at the document itself
# rather than their inbox: the inbox is one more click and they came here to decide.
# Types with no detail screen yet fall back to the approvals inbox, which lists them.
DOC_LINKS: dict[str, str] = {
    "INDENT": "/indents/{id}",
    "MR": "/inventory/material-requests/{id}",
    # Straight at the review screen. This used to be `?review={id}` on the Allocation
    # Approvals list, which forwarded from there; that list is now the Fulfilment
    # Desk's Approvals tab (2026-08-21) and the detail route is the one that never
    # moved. Links already sent under the old shape still arrive —
    # `LegacyAllocationApprovalsRedirect` reads the review id back out of the query.
    "ALLOCATION": "/inventory/allocation-approvals/{id}",
    # Raised under the point-owner's own ladder, same document, same screen.
    "OWN_STOCK_ALLOCATION": "/inventory/allocation-approvals/{id}",
    "GRN": "/warehouse/grn/{id}",
    "RECEIPT": "/warehouse/grn/{id}",
    "WH_ISSUE": "/warehouse/material-issues/{id}",
    "ISSUE": "/warehouse/material-issues/{id}",
    "DISPATCH": "/warehouse/dispatch/{id}",
    "PURCHASE_RETURN": "/warehouse/purchase-returns/{id}",
    "STOCK_ADJUSTMENT": "/inventory/adjustments?review={id}",
    "STOCK_EDIT": "/inventory/stock-edits?review={id}",
    "VENDOR_PAYMENT": "/accounts/payments?review={id}",
    "STOCK_TRANSFER": "/inventory/transfers?tab=orders&review={id}",
    # SCM_0074 / SCM_0075 (2026-10-31): every document type the engine notifies about
    # opens ITS OWN screen. These five used to fall back to the approvals inbox, so
    # "PO0001 approved" opened an inbox the PO had already left and the click looked
    # like it did nothing.
    "PO": "/pos/{id}",
    "RFQ": "/procurement/rfqs/{id}",
    "QUOTATION": "/procurement/quotations/{id}",
    "REQUISITION": "/procurement/requisitions/{id}",
    "CONSOLIDATION": "/procurement/consolidations/{id}",
    "OWN_STOCK_ISSUE": "/warehouse/material-issues/{id}",
    "FORWARD_ISSUE": "/warehouse/material-issues/{id}",
    "STOCK_TRANSFER_REQUEST": "/inventory/transfers/requests/{id}",
    "STOCK_MOVEMENT_ORDER": "/inventory/transfers?tab=orders&review={id}",
    "TRANSPORT_REQUEST": "/logistics/shipments/{id}",
    "INDENT_ACK": "/indents/acknowledgements/{id}",
}

#: The fallback `link_for` hands out for a type it cannot place.
INBOX = "/approvals"

#: Links already written under a path the app no longer serves, mapped onto the one
#: it does. `/procurement/pos/{id}` was never a route — PO detail is `/pos/{id}` — so
#: every PO notification opened the Not Found page.
_STALE_PREFIXES = (("/procurement/pos/", "/pos/"),)


def resolve_link(deep_link: str | None, entity_type: str | None,
                 entity_id: int | None) -> str | None:
    """Where clicking a notification goes — computed on READ, so a row written with a
    stale or generic link is corrected without touching the table.

    A specific link the row carries wins (repaired if it names a retired path). A row
    that only carries the generic inbox, or nothing, is sent to its own document when
    its entity type and id name one. Anything else keeps what it had; None means
    there is no document behind it, and the screens open the notification itself.
    """
    link = (deep_link or "").strip() or None
    if link:
        for old, new in _STALE_PREFIXES:
            if link.startswith(old):
                link = new + link[len(old):]
    if link and link.split("?", 1)[0] != INBOX:
        return link
    kind = (entity_type or "").upper()
    # An indent's status notifications are typed "INDENT_STATUS:<status>".
    if kind.startswith("INDENT_STATUS"):
        kind = "INDENT"
    template = DOC_LINKS.get(kind)
    if template and entity_id:
        return template.format(id=entity_id)
    return link


def link_for(doc_type: str, doc_id: int) -> str:
    template = DOC_LINKS.get(doc_type)
    return template.format(id=doc_id) if template else "/approvals"


async def notify(
    db: AsyncSession,
    employee_ids,
    *,
    title: str,
    body: str | None = None,
    deep_link: str | None = None,
    entity_type: str | None = None,
    entity_id: int | None = None,
) -> int:
    """Raise one notification per employee. Returns how many were written.

    Duplicates are not filtered: two stages of the same document reaching the same
    person are two separate things to act on.
    """
    targets = {int(i) for i in employee_ids if i}
    if not targets:
        return 0
    try:
        for employee_id in targets:
            db.add(Notification(
                employee_id=employee_id,
                title=title[:200],
                body=body[:1000] if body else None,
                deep_link=deep_link,
                entity_type=entity_type,
                entity_id=entity_id,
                is_read=False,
            ))
        await db.flush()
        return len(targets)
    except Exception:  # noqa: BLE001 — see module docstring
        logger.exception("Could not raise notification %r for %s", title, targets)
        return 0
