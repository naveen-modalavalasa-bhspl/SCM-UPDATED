"""goods rejected at delivery: ind_indent_items.rejected_qty

Revision ID: c7e9a1b3d5f0
Revises: f8b0d2e4a6c9
Create Date: 2026-11-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c7e9a1b3d5f0"
down_revision: Union[str, Sequence[str], None] = "f8b0d2e4a6c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    return column in {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    # Idempotent: `bootstrap` adds any column the models have and the database lacks, so
    # on a database that has already been through it this is a no-op.
    if not _has_column("ind_indent_items", "rejected_qty"):
        op.add_column("ind_indent_items", sa.Column(
            "rejected_qty", sa.Numeric(16, 3), nullable=False, server_default="0"))


def downgrade() -> None:
    if _has_column("ind_indent_items", "rejected_qty"):
        op.drop_column("ind_indent_items", "rejected_qty")
