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
    "ALLOCATION": "/inventory/allocation-approvals?review={id}",
    "GRN": "/warehouse/grn/{id}",
    "RECEIPT": "/warehouse/grn/{id}",
    "WH_ISSUE": "/warehouse/material-issues/{id}",
    "ISSUE": "/warehouse/material-issues/{id}",
    "DISPATCH": "/warehouse/dispatch/{id}",
    "PURCHASE_RETURN": "/warehouse/purchase-returns/{id}",
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
