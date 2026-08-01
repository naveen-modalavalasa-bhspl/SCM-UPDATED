"""allocation decision tables

Hand-written for the same reason as the previous revision: autogenerate diffs
Base.metadata against the 83-table live schema and emits drops for everything the ORM
does not map.

Revision ID: c8d2e3f4a5b6
Revises: b7c1d2e3f4a5
Create Date: 2026-07-26
"""
import sqlalchemy as sa
from alembic import op

revision = "c8d2e3f4a5b6"
down_revision = "b7c1d2e3f4a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "inv_allocations",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("allocation_no", sa.String(30), nullable=False),
        sa.Column("indent_id", sa.BigInteger(), nullable=False),
        sa.Column("indent_no", sa.String(30), nullable=True),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("allocated_by_id", sa.BigInteger(), nullable=True),
        sa.Column("allocated_by_name", sa.String(200), nullable=True),
        sa.Column("department_id", sa.BigInteger(), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("current_approver_name", sa.String(200), nullable=True),
        sa.Column("approved_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("allocation_no"),
    )
    op.create_index("ix_inv_allocations_indent_id", "inv_allocations", ["indent_id"])
    op.create_index("ix_inv_allocations_status_created", "inv_allocations",
                    ["status", "created_at"])

    op.create_table(
        "inv_allocation_items",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("allocation_id", sa.BigInteger(), nullable=False),
        sa.Column("indent_item_id", sa.BigInteger(), nullable=False),
        sa.Column("item_id", sa.BigInteger(), nullable=False),
        sa.Column("item_code", sa.String(50), nullable=True),
        sa.Column("item_name", sa.String(300), nullable=True),
        sa.Column("uom_code", sa.String(20), nullable=True),
        sa.Column("requested_qty", sa.Numeric(16, 3), nullable=False,
                  server_default="0"),
        sa.Column("quantity", sa.Numeric(16, 3), nullable=False, server_default="0"),
        sa.Column("warehouse_id", sa.BigInteger(), nullable=True),
        sa.Column("warehouse_name", sa.String(200), nullable=True),
        sa.Column("project_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("remarks", sa.String(500), nullable=True),
        sa.ForeignKeyConstraint(["allocation_id"], ["inv_allocations.id"],
                                ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["item_id"], ["mst_items.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_inv_allocation_items_allocation_id", "inv_allocation_items",
                    ["allocation_id"])
    op.create_index("ix_inv_allocation_items_indent_item_id", "inv_allocation_items",
                    ["indent_item_id"])
    op.create_index("ix_inv_allocation_items_item_id", "inv_allocation_items",
                    ["item_id"])


def downgrade() -> None:
    op.drop_table("inv_allocation_items")
    op.drop_table("inv_allocations")
