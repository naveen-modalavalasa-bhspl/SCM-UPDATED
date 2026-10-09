"""Retire AWAITING_PROCUREMENT as a held allocation status.

An allocation used to be parked on AWAITING_PROCUREMENT when the shelf could not cover
all of it, and woken again once the goods arrived. That design made every doorway stock
can reach a shelf through responsible for remembering to wake the document, and six
separate live defects came out of the ones that forgot. A signed allocation is terminal
now: what an indent is still owed is recomputed on read from the shelf and the open
material requests (`indents.list_indents(has_remainder=True)`), so the indent returns
to the fulfilment desk by itself.

The rows already carrying the status are signed allocations — the value differed from
APPROVED only in having unfinished business with procurement, never in what was given
or reserved — so this is a rename in place. Nothing else moves: no reservation is
touched, no indent status is recomputed, no material request is closed. The MRs those
allocations raised stay exactly as they are and keep counting as on-order until they
are received, which is what stops the freed indents offering quantity somebody is
already buying.

Down converts nothing back. The old status cannot be reconstructed from the row (an
allocation that gave everything and one that went short are both APPROVED afterwards),
and reviving a value no code writes any more would strand those rows outside every
status tuple that reads them.

Revision ID: a1c2e3f4b5d6
Revises: b7c8d9e0f1a2
Create Date: 2026-08-21
"""
from alembic import op
import sqlalchemy as sa

revision = "a1c2e3f4b5d6"
down_revision = "b7c8d9e0f1a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text(
        "UPDATE inv_allocations SET status = 'APPROVED' "
        "WHERE status = 'AWAITING_PROCUREMENT'"
    ))


def downgrade() -> None:
    # Deliberately empty — see the module docstring.
    pass
