"""Merge qa migrations with demand-pool branch.

Revision ID: d4e6f8a2c0b1
Revises: b5d7f9a1c3e6, c3d5e7f9a1b2
Create Date: 2026-09-25
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = 'd4e6f8a2c0b1'
down_revision: Union[str, Sequence[str], None] = ('b5d7f9a1c3e6', 'c3d5e7f9a1b2')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    pass

def downgrade() -> None:
    pass
