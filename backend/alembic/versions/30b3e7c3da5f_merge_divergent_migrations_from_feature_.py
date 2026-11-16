"""Merge divergent migrations from feature branches

Revision ID: 30b3e7c3da5f
Revises: d2f8a4c6e1b3, d4e6f8a0c2b5
Create Date: 2026-10-10 16:41:17.604124
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '30b3e7c3da5f'
down_revision: Union[str, None] = ('d2f8a4c6e1b3', 'd4e6f8a0c2b5')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
