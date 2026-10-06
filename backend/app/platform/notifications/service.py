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
    "STOCK_TRANSFER": "/inventory/transfers?tab=orders&review={id}",
}


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
