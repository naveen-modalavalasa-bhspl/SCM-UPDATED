"""monthly indent custom approval switch

Revision ID: a7c9e1f2b4d6
Revises: f4b6c8d0e2a5
Create Date: 2026-09-21
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a7c9e1f2b4d6"
down_revision: Union[str, Sequence[str], None] = "f4b6c8d0e2a5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "mi_settings",
        sa.Column("approval_flow_enabled", sa.Boolean(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("mi_settings", "approval_flow_enabled")
