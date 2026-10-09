"""Where each document type keeps its "who is this waiting on" snapshot.

WHY THIS EXISTS
---------------
Every document that goes through approval carries a denormalised
`current_approver_name` on its OWN table, so a register can show who is holding a row
without asking the workflow engine per row. The engine writes that snapshot on every
ordinary transition because the MODULE calls the engine and then updates its own
document (rule 8: the engine owns the chain, the module owns the document).

`engine.move_to_workflow` is the one transition with no module on the other end. An
admin presses Move on Settings > Approval Flow, `platform.workflow.flow_config` calls
the engine directly, and there is nothing to update the document afterwards. The
result, confirmed on live data before this was written:

    wf_instances.workflow_id       106 -> 94          moved
    wf_instances.current_stage     "SCM HEAD" -> "OE" moved
    wf_pending.approver_id         16070 -> 7703      moved
    ind_indents.current_approver   "MAHENDRA (SCM HEAD)"   NOT MOVED

So the new approver had it in their inbox, the old one did not, and every screen still
named the old one. That is the "moving a document to V2 does not actually migrate it"
report: the approval moved, the document did not.

WHY A REGISTRY AND NOT A MAP IN THE ENGINE
------------------------------------------
`platform/` may not import `app.modules` (rule 5), so the engine cannot reach
`Indent`, `Requisition` or the rest. It could carry a hardcoded doc_type -> table_name
table instead, but that puts the modules' schema in the platform's hands: a module
renaming its own column would silently stop the snapshot updating, with nothing to
catch it.

So the direction stays modules -> platform. A module registers its own doc types
beside its own models, which is the only place that knows the answer. Registration is
plain data — a table name and two column names, no model objects — so the UPDATE runs
through SQLAlchemy Core and the platform never imports a module.

FAILURE MODE, ON PURPOSE
------------------------
A doc type nobody registered simply is not updated, exactly as today. That is a
no-op, never an error: a module not yet imported, or one whose document has no
snapshot column at all, must not be able to break an admin's Move.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import column, table, update
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DocSnapshot:
    """Where one document type stores its pending-approver snapshot."""
    table_name: str
    id_column: str = "id"
    approver_column: str = "current_approver_name"


_REGISTRY: dict[str, DocSnapshot] = {}


def register(doc_type: str, table_name: str, *, id_column: str = "id",
             approver_column: str = "current_approver_name") -> None:
    """Declare where `doc_type` keeps its approver snapshot.

    Called by a module at import time, beside its own models. Re-registering the same
    doc type overwrites, so a reload during development cannot double-register.
    """
    _REGISTRY[doc_type] = DocSnapshot(table_name, id_column, approver_column)


def lookup(doc_type: str) -> DocSnapshot | None:
    return _REGISTRY.get(doc_type)


def registered() -> dict[str, DocSnapshot]:
    """Everything registered so far. For diagnostics and the tests."""
    return dict(_REGISTRY)


async def sync_approver(db: AsyncSession, doc_type: str, doc_id: int,
                        label: str | None) -> bool:
    """Write `label` onto the document's own snapshot column. True if a row was hit.

    Core UPDATE against a named table rather than an ORM model, because the platform
    has no model to import (see the module docstring). No commit — this joins the
    caller's transaction, so a move that rolls back cannot leave the document naming
    an approver the workflow no longer has.
    """
    spec = lookup(doc_type)
    if spec is None:
        # Not an error. See "failure mode, on purpose" above.
        logger.debug("No approver snapshot registered for doc_type %s", doc_type)
        return False

    target = table(spec.table_name, column(spec.id_column),
                   column(spec.approver_column))
    result = await db.execute(
        update(target)
        .where(column(spec.id_column) == doc_id)
        .values({spec.approver_column: label})
    )
    return bool(result.rowcount)
