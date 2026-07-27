"""inventory sto cycle counts and stock adjustments

Hand-written alembic migration for STO, Cycle Count, and Stock Adjustments.

Revision ID: d9e8f7a6b5c4
Revises: b5c6d7e8f9a0
Create Date: 2026-07-27

Written against c8d2e3f4a5b6; re-pointed at the tip of the per-developer
placeholder chain on merge so the repo keeps a single alembic head.
"""
import sqlalchemy as sa
from alembic import op

revision = "d9e8f7a6b5c4"
down_revision = "b5c6d7e8f9a0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. inv_adjustments & inv_adjustment_items
    op.create_table(
        "inv_adjustments",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("adjustment_no", sa.String(30), nullable=False),
        sa.Column("warehouse_id", sa.BigInteger(), nullable=False),
        sa.Column("warehouse_name", sa.String(200), nullable=True),
        sa.Column("reason", sa.String(50), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.BigInteger(), nullable=True),
        sa.Column("created_by_name", sa.String(200), nullable=True),
        sa.Column("approved_by_id", sa.BigInteger(), nullable=True),
        sa.Column("approved_by_name", sa.String(200), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("adjustment_no"),
    )
    op.create_index("ix_inv_adjustments_wh_status", "inv_adjustments", ["warehouse_id", "status"])

    op.create_table(
        "inv_adjustment_items",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("adjustment_id", sa.BigInteger(), nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("item_code", sa.String(50), nullable=True),
        sa.Column("item_name", sa.String(300), nullable=True),
        sa.Column("uom_code", sa.String(20), nullable=True),
        sa.Column("bin_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("batch_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("project_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("direction", sa.String(3), nullable=False),
        sa.Column("quantity", sa.Numeric(16, 3), nullable=False),
        sa.Column("unit_cost", sa.Numeric(16, 2), nullable=True, server_default="0.00"),
        sa.Column("remarks", sa.String(500), nullable=True),
        sa.ForeignKeyConstraint(["adjustment_id"], ["inv_adjustments.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_inv_adj_items_adj_id", "inv_adjustment_items", ["adjustment_id"])

    # 2. inv_sto & inv_sto_items
    op.create_table(
        "inv_sto",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("sto_no", sa.String(30), nullable=False),
        sa.Column("from_warehouse_id", sa.BigInteger(), nullable=False),
        sa.Column("from_warehouse_name", sa.String(200), nullable=True),
        sa.Column("to_warehouse_id", sa.BigInteger(), nullable=False),
        sa.Column("to_warehouse_name", sa.String(200), nullable=True),
        sa.Column("from_project_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("to_project_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("requested_by_id", sa.BigInteger(), nullable=True),
        sa.Column("requested_by_name", sa.String(200), nullable=True),
        sa.Column("approved_by_name", sa.String(200), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("dispatched_at", sa.DateTime(), nullable=True),
        sa.Column("received_at", sa.DateTime(), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("sto_no"),
    )
    op.create_index("ix_inv_sto_status", "inv_sto", ["status"])

    op.create_table(
        "inv_sto_items",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("sto_id", sa.BigInteger(), nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("item_code", sa.String(50), nullable=True),
        sa.Column("item_name", sa.String(300), nullable=True),
        sa.Column("uom_code", sa.String(20), nullable=True),
        sa.Column("requested_qty", sa.Numeric(16, 3), nullable=False),
        sa.Column("dispatched_qty", sa.Numeric(16, 3), nullable=False, server_default="0"),
        sa.Column("received_qty", sa.Numeric(16, 3), nullable=False, server_default="0"),
        sa.Column("remarks", sa.String(500), nullable=True),
        sa.ForeignKeyConstraint(["sto_id"], ["inv_sto.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_inv_sto_items_sto_id", "inv_sto_items", ["sto_id"])

    # 3. inv_cycle_counts & inv_cycle_count_items
    op.create_table(
        "inv_cycle_counts",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("count_no", sa.String(30), nullable=False),
        sa.Column("warehouse_id", sa.BigInteger(), nullable=False),
        sa.Column("warehouse_name", sa.String(200), nullable=True),
        sa.Column("count_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("planned_by_name", sa.String(200), nullable=True),
        sa.Column("posted_by_name", sa.String(200), nullable=True),
        sa.Column("posted_at", sa.DateTime(), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("count_no"),
    )
    op.create_index("ix_inv_cycle_counts_wh_status", "inv_cycle_counts", ["warehouse_id", "status"])

    op.create_table(
        "inv_cycle_count_items",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("cycle_count_id", sa.BigInteger(), nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("item_code", sa.String(50), nullable=True),
        sa.Column("item_name", sa.String(300), nullable=True),
        sa.Column("uom_code", sa.String(20), nullable=True),
        sa.Column("bin_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("batch_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("snapshot_qty", sa.Numeric(16, 3), nullable=False, server_default="0"),
        sa.Column("counted_qty", sa.Numeric(16, 3), nullable=True),
        sa.Column("variance_qty", sa.Numeric(16, 3), nullable=True),
        sa.Column("remarks", sa.String(500), nullable=True),
        sa.ForeignKeyConstraint(["cycle_count_id"], ["inv_cycle_counts.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_inv_cc_items_cc_id", "inv_cycle_count_items", ["cycle_count_id"])


def downgrade() -> None:
    op.drop_table("inv_cycle_count_items")
    op.drop_table("inv_cycle_counts")
    op.drop_table("inv_sto_items")
    op.drop_table("inv_sto")
    op.drop_table("inv_adjustment_items")
    op.drop_table("inv_adjustments")
