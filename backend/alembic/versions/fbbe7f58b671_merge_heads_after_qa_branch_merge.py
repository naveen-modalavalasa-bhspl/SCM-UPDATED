"""merge heads after qa branch merge

Revision ID: fbbe7f58b671
Revises: d8a4f2c6e1b9, e9f0a1b2c3d5
Create Date: 2026-09-21 17:00:02.889876
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'fbbe7f58b671'
down_revision: Union[str, None] = ('d8a4f2c6e1b9', 'e9f0a1b2c3d5')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
