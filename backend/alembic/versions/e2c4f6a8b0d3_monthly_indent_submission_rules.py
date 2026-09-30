"""monthly indent submission limits and deadlines

Revision ID: e2c4f6a8b0d3
Revises: c2e5a8b1d7f3
Create Date: 2026-09-25
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e2c4f6a8b0d3"
down_revision: Union[str, Sequence[str], None] = "c2e5a8b1d7f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _tables() -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(
        "SELECT TABLE_NAME FROM information_schema.TABLES "
        "WHERE TABLE_SCHEMA = DATABASE()"
    ))}


def upgrade() -> None:
    if "mi_submission_rules" in _tables():
        return
    op.create_table(
        "mi_submission_rules",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="1", nullable=False),
        sa.Column("target_type", sa.String(length=30), nullable=False),
        sa.Column("target_ref_id", sa.BigInteger(), nullable=False),
        sa.Column("target_name", sa.String(length=200), nullable=True),
        sa.Column("max_submissions", sa.Integer(), server_default="1", nullable=False),
        sa.Column("deadline_day", sa.Integer(), server_default="31", nullable=False),
        sa.Column("allow_after_deadline", sa.Boolean(), server_default="0", nullable=False),
        sa.Column("created_by_id", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("target_type", "target_ref_id", name="uq_mi_submission_target"),
    )
    op.create_index(
        "ix_mi_submission_active_target",
        "mi_submission_rules",
        ["is_active", "target_type", "target_ref_id"],
    )


def downgrade() -> None:
    if "mi_submission_rules" not in _tables():
        return
    op.drop_index("ix_mi_submission_active_target", table_name="mi_submission_rules")
    op.drop_table("mi_submission_rules")
