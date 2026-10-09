"""join outward QC and custody-person heads

FIXED 2026-08-20 — the tree had two heads and `alembic upgrade head` refuses to run at
all with more than one: `a3f7c21d9e04` (outward QC approval, ours) and `e7f8a9b0c1d3`
(custody person identity, from the indent/approvals/logistics branch) were cut in
parallel. WITHOUT this mergepoint no database can be brought forward by either side.

No schema of its own — it only joins the two lines, exactly as `a9b8c7d6e5f4` did for
the previous logistics merge.


Revision ID: 01b3a709076e
Revises: a3f7c21d9e04, e7f8a9b0c1d3
Create Date: 2026-08-20 20:31:35.864736
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '01b3a709076e'
down_revision: Union[str, None] = ('a3f7c21d9e04', 'e7f8a9b0c1d3')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
