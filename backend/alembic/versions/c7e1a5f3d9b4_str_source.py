"""A Stock Transfer Request names its SOURCE point, and every move of it is recorded
(2026-11-04).

`ind_indents.source_warehouse_id` (soft FK to whs_warehouses) + name/code snapshot,
and `ind_str_source_changes` — append-only, one row per approver re-pointing an STR
onto a point in their own scope. Idempotent.

Revision ID: c7e1a5f3d9b4
Revises: f5b7d9e1a3c6
Create Date: 2026-11-04
"""
import sqlalchemy as sa
from alembic import op

revision = "c7e1a5f3d9b4"
down_revision = "f5b7d9e1a3c6"
branch_labels = None
depends_on = None


def _cols(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    have = _cols("ind_indents")
    if "source_warehouse_id" not in have:
        op.add_column("ind_indents", sa.Column("source_warehouse_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_ind_indents_source_warehouse_id", "ind_indents", ["source_warehouse_id"])
    if "source_warehouse_name" not in have:
        op.add_column("ind_indents", sa.Column("source_warehouse_name", sa.String(200), nullable=True))
    if "source_warehouse_code" not in have:
        op.add_column("ind_indents", sa.Column("source_warehouse_code", sa.String(50), nullable=True))

    if not sa.inspect(op.get_bind()).has_table("ind_str_source_changes"):
        op.create_table(
            "ind_str_source_changes",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("indent_id", sa.BigInteger(),
                      sa.ForeignKey("ind_indents.id", ondelete="CASCADE"), nullable=False),
            sa.Column("from_warehouse_id", sa.BigInteger(), nullable=True),
            sa.Column("from_warehouse_name", sa.String(200), nullable=True),
            sa.Column("to_warehouse_id", sa.BigInteger(), nullable=False),
            sa.Column("to_warehouse_name", sa.String(200), nullable=True),
            sa.Column("stage_name", sa.String(200), nullable=True),
            sa.Column("reason", sa.String(500), nullable=True),
            sa.Column("changed_by_id", sa.BigInteger(), nullable=True),
            sa.Column("changed_by_name", sa.String(200), nullable=True),
            sa.Column("position_name", sa.String(200), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.func.now()),
        )
        op.create_index("ix_ind_str_source_changes_indent_id", "ind_str_source_changes", ["indent_id"])
        op.create_index("ix_ind_str_source_changes_changed_by_id", "ind_str_source_changes", ["changed_by_id"])


def downgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("ind_str_source_changes"):
        op.drop_table("ind_str_source_changes")
    have = _cols("ind_indents")
    for col in ("source_warehouse_code", "source_warehouse_name"):
        if col in have:
            op.drop_column("ind_indents", col)
    if "source_warehouse_id" in have:
        op.drop_index("ix_ind_indents_source_warehouse_id", table_name="ind_indents")
        op.drop_column("ind_indents", "source_warehouse_id")
