"""Merge the consignment-flow and vendor-despatch migration branches.

Both branches were created from ``d7e8f9a0b1c2``.  A database upgraded to the
consignment head could therefore miss the vendor despatch tables and the receipt
columns used by Warehouse while still appearing current on that branch.  Keep both
already-published histories intact and join them here so ``alembic upgrade head``
applies whichever side is missing.

Revision ID: b2d3e4f5a6c7
Revises: a1c2e3d4f5b6, f2a3b4c5d6e8
"""

revision = "b2d3e4f5a6c7"
down_revision = ("a1c2e3d4f5b6", "f2a3b4c5d6e8")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """The parent migrations contain all schema changes."""


def downgrade() -> None:
    """Splitting the graph does not require a schema change."""
