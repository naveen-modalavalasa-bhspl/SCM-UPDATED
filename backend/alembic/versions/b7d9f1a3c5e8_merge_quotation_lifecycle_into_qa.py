"""Merge the quotation-lifecycle line with qa's trip-planner mergepoint (2026-09-30).

``e8b1d4f7a2c3`` (single GST rate) and ``a2c4e6f8b1d3`` (quotation lifecycle) were
brought over from ``naveen-whs&proc&masters`` with their revision ids unchanged, so a
database already upgraded on that branch stays on the same lineage. They end in a head
of their own beside ``a3d5f7b9c1e2``; a merge revision rather than a re-pointed
``down_revision``, so neither side skips the other's revisions. No schema.

Revision ID: b7d9f1a3c5e8
Revises: a3d5f7b9c1e2, a2c4e6f8b1d3
Create Date: 2026-09-30
"""
from typing import Sequence, Union

revision: str = "b7d9f1a3c5e8"
down_revision: Union[str, Sequence[str], None] = ("a3d5f7b9c1e2", "a2c4e6f8b1d3")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
