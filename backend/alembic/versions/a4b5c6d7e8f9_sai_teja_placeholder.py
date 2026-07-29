"""Sai Teja placeholder

Revision ID: a4b5c6d7e8f9
Revises: f3a4b5c6d7e8
Create Date: 2026-07-27
"""

from alembic import op
import sqlalchemy as sa


revision = "a4b5c6d7e8f9"
down_revision = "f3a4b5c6d7e8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ind_indents",
        sa.Column("is_bookmarked", sa.String(length=3), nullable=False, server_default="NO"),
    )


def downgrade() -> None:
    op.drop_column("ind_indents", "is_bookmarked")
