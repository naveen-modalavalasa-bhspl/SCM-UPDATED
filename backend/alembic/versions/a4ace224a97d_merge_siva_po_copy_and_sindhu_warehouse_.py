"""merge siva PO-copy and Sindhu warehouse-address branches

Revision ID: a4ace224a97d
Revises: 8e2f3a4b5c6d, b4c6d8e0f2a4
Create Date: 2026-10-21 10:29:11.030652
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a4ace224a97d'
down_revision: Union[str, None] = ('8e2f3a4b5c6d', 'b4c6d8e0f2a4')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
