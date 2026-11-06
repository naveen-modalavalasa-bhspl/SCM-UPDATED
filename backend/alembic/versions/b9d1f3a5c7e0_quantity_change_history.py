"""Every quantity change on a material request or requisition is kept (2026-11-03).

`inv_mr_qty_changes` and `pro_requisition_qty_changes`: append-only, one row per line
whose quantity an approver or the raiser lowered after it was asked for — from, to,
the ceiling, the stage, who, their position, when and why. Idempotent.

Revision ID: b9d1f3a5c7e0
Revises: a7c9e1b3d5f8
Create Date: 2026-11-03
"""
import sqlalchemy as sa
from alembic import op

revision = "b9d1f3a5c7e0"
down_revision = "a7c9e1b3d5f8"
branch_labels = None
depends_on = None


def _common() -> list:
    return [
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("item_code", sa.String(100), nullable=True),
        sa.Column("item_name", sa.String(300), nullable=True),
        sa.Column("uom_code", sa.String(30), nullable=True),
        sa.Column("from_qty", sa.Numeric(16, 3), nullable=False),
        sa.Column("to_qty", sa.Numeric(16, 3), nullable=False),
        sa.Column("ceiling_qty", sa.Numeric(16, 3), nullable=True),
        sa.Column("stage", sa.String(20), nullable=False),
        sa.Column("comments", sa.String(500), nullable=True),
        sa.Column("changed_by_id", sa.BigInteger(), nullable=True),
        sa.Column("changed_by_name", sa.String(200), nullable=True),
        sa.Column("changed_by_position", sa.String(200), nullable=True),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "inv_mr_qty_changes" not in tables:
        op.create_table(
            "inv_mr_qty_changes",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("mr_id", sa.BigInteger(),
                      sa.ForeignKey("inv_material_requests.id", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("mr_item_id", sa.BigInteger(), nullable=True),
            *_common(),
        )
        op.create_index("ix_inv_mr_qty_changes_mr_id", "inv_mr_qty_changes", ["mr_id"])
    if "pro_requisition_qty_changes" not in tables:
        op.create_table(
            "pro_requisition_qty_changes",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("requisition_id", sa.BigInteger(),
                      sa.ForeignKey("pro_requisitions.id", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("combination", sa.String(300), nullable=True),
            *_common(),
        )
        op.create_index("ix_pro_requisition_qty_changes_requisition_id",
                        "pro_requisition_qty_changes", ["requisition_id"])


def downgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "pro_requisition_qty_changes" in tables:
        op.drop_table("pro_requisition_qty_changes")
    if "inv_mr_qty_changes" in tables:
        op.drop_table("inv_mr_qty_changes")
