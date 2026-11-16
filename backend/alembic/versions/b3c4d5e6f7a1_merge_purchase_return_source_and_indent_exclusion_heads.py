"""Merge the purchase-return-source head into the indent-line-exclusion head.

Two branches grew a migration apiece off the same history and neither knew about the
other: ``a7b8c9d0e1f2`` (``pro_purchase_returns.source_category``, from the Deepak
line) descends from ``a4c8e2b7d1f9``, and ``e4f5a6b7c8d9`` (indent line exclusion)
from ``c7d8e9f0a1b2``.

Left alone that is two heads, and ``alembic upgrade head`` then refuses to run at all
— "Multiple head revisions are present" — so a database holding one side's columns
could never receive the other's. Joining them here keeps both published histories
intact and lets one ``upgrade head`` apply whichever side a given database is missing.

No schema change of its own — every column belongs to a parent revision.

Revision ID: b3c4d5e6f7a1
Revises: a7b8c9d0e1f2, e4f5a6b7c8d9
"""

revision = "b3c4d5e6f7a1"
down_revision = ("a7b8c9d0e1f2", "e4f5a6b7c8d9")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """The parent migrations carry every schema change."""


def downgrade() -> None:
    """Splitting the graph back apart needs no schema change."""
