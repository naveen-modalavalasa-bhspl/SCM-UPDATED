"""merge heads after PO chat addition

The PO chat migration branched off fa0 while the DB was still on 6 separate
heads (a1b2, b8e4, b3d5, d5e6, e7f8, e9f0). This mergepoint joins them so
`alembic upgrade head` has a single target again.

Revision ID: ff00a1b2c3d4
Revises: a1b2c3d4e5f8, b8e4f1c7a2d9, e9f0a1b2c3d4, b3d5f7a9c1e2, d5e6f7a8b9c0, e7f8a9b0c1d3
Create Date: 2026-09-02
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'ff00a1b2c3d4'
down_revision: Union[str, Sequence[str], None] = ('a1b2c3d4e5f8', 'b8e4f1c7a2d9', 'e9f0a1b2c3d4', 'b3d5f7a9c1e2', 'd5e6f7a8b9c0', 'e7f8a9b0c1d3')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    pass

def downgrade() -> None:
    pass
