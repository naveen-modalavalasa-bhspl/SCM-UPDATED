"""Snapshot the RFQ items assigned to each invited vendor.

Revision ID: a2d4f6b8c0e1
Revises: f7a1c3e5d9b2
Create Date: 2026-09-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a2d4f6b8c0e1"
down_revision: Union[str, Sequence[str], None] = "f7a1c3e5d9b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("pro_rfq_vendors", sa.Column("mapped_item_ids", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("pro_rfq_vendors", "mapped_item_ids")
