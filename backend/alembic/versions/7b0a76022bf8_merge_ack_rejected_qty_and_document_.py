"""merge ack_rejected_qty and document_number_year

Revision ID: 7b0a76022bf8
Revises: c7e9a1b3d5f0, d9e3b5c7a1f4
Create Date: 2026-11-09 11:36:25.435275
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '7b0a76022bf8'
down_revision: Union[str, None] = ('c7e9a1b3d5f0', 'd9e3b5c7a1f4')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
