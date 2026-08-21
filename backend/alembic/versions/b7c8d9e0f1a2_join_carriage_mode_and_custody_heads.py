"""join transport carriage mode and the custody-person line

FIXED 2026-08-21 — the tree had two heads again and `alembic upgrade head` refuses to
run at all with more than one: `a1b2c3d4e5f8` (transport carriage mode, cut on qa) and
`01b3a709076e` (the outward-QC/custody mergepoint, cut on the logistics integration
branch) both descend from `a3f7c21d9e04` and neither reaches the other.

How they came apart: the custody line — `d6e7f8a9b0c2`, `e7f8a9b0c1d3` and the
`01b3a709076e` mergepoint that joins it to outward QC — was written on
`saiteja-logistics-integration` and never merged into qa, while the live database HAD
run it and was stamped at `01b3a709076e`. So qa carried a stamp pointing at a revision
whose file was not in `alembic/versions` at all: `alembic current` answered "Can't
locate revision identified by '01b3a709076e'" and no database could be brought forward
by either side. The three files are restored; this joins the two lines.

No schema of its own — it only joins them, exactly as `a9b8c7d6e5f4` and
`01b3a709076e` did for the merges before it.


Revision ID: b7c8d9e0f1a2
Revises: a1b2c3d4e5f8, 01b3a709076e
Create Date: 2026-08-21 13:05:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, None] = ("a1b2c3d4e5f8", "01b3a709076e")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
