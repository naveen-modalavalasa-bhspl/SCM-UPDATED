"""Merge saiteja-indent,approvals,logistics with qa (2026-09-26).

Revision ID: b7e2d9f4a6c1
Revises: 97ab42cd81ef, d4e6f8a2c0b1
Create Date: 2026-09-26

Schema-free. The branch ends at `97ab42cd81ef` (dispatch sources for multi-MR
consignments, after the monthly-indent revisions) and qa at `d4e6f8a2c0b1` (demand
pool, stock audit, item owner department). With two heads `alembic upgrade head`
refuses to move, so this joins them. A merge revision rather than a re-pointed
`down_revision`: a database already stamped at either side would otherwise treat the
other side's revisions as ancestors it had passed and skip them in silence.
"""
from typing import Sequence, Union

revision: str = "b7e2d9f4a6c1"
down_revision: Union[str, Sequence[str], None] = ("97ab42cd81ef", "d4e6f8a2c0b1")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
