"""Store the quantity allocated to each vendor for each RFQ item.

Revision ID: c4f6b8d0e2a3
Revises: b3e5a7c9d1f2
Create Date: 2026-09-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c4f6b8d0e2a3"
down_revision: Union[str, Sequence[str], None] = "b3e5a7c9d1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "pro_rfq_vendors",
        sa.Column("item_quantities", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("pro_rfq_vendors", "item_quantities")
