"""Merge the logistics trip-planner line with the monthly-indent head (2026-09-29).

The trip-planner migrations (``97ab42cd81ef`` .. ``f4c6e8a0b2d4``) were ported from
``saiteja-indent,approvals,logistics`` with their revision ids unchanged, so a
database already upgraded on that branch stays on the same lineage. They end in a head
of their own beside ``b6e9c2a4d1f0``; a merge revision rather than a re-pointed
``down_revision``, so neither side skips the other's revisions. No schema.

Revision ID: a3d5f7b9c1e2
Revises: b6e9c2a4d1f0, f4c6e8a0b2d4
Create Date: 2026-09-29
"""
from typing import Sequence, Union

revision: str = "a3d5f7b9c1e2"
down_revision: Union[str, Sequence[str], None] = ("b6e9c2a4d1f0", "f4c6e8a0b2d4")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
