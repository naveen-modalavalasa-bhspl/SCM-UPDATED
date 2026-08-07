"""inv_position_locations — tag a position to the stocking points it draws from

Purely additive: one new table, no existing table altered and no column retyped. The
tier (WAREHOUSE / MDP / LIP) is NOT stored here — it is derived from the
`whs_warehouses.warehouse_type` the live rows already carry, so there is only ever
one copy of that fact.

`project_id` is snapshotted on the tag because a stocking point has no project of its
own: whs_warehouses carries office and facility, and HCM keeps the project on the
employee. It is what the cross-project rule compares to decide whether a transfer
needs the Inventory Manager.

Revision ID: e6f7a8b9c0d1
Revises: d5e6f7a8b9c0
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e6f7a8b9c0d1"
down_revision: Union[str, None] = "d5e6f7a8b9c0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "inv_position_locations",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        # Soft FK: hcm_* is a read-only mirror, so it never carries a hard constraint.
        sa.Column("position_id", sa.BigInteger(), nullable=True),
        sa.Column("warehouse_id", sa.BigInteger(), nullable=False),
        sa.Column("project_id", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("project_name", sa.String(length=200), nullable=True),
        sa.Column("is_primary", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(), nullable=False,
                  server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.ForeignKeyConstraint(["warehouse_id"], ["whs_warehouses.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        # One tag per (position, point): a repeated tag is the same fact twice.
        sa.UniqueConstraint("position_id", "warehouse_id", name="uq_inv_position_location"),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index("ix_inv_position_locations_position_id",
                    "inv_position_locations", ["position_id"])
    op.create_index("ix_inv_position_locations_warehouse_id",
                    "inv_position_locations", ["warehouse_id"])
    op.create_index("ix_inv_position_locations_project_id",
                    "inv_position_locations", ["project_id"])
    op.create_index("ix_inv_position_locations_active",
                    "inv_position_locations", ["position_id", "is_active"])


def downgrade() -> None:
    op.drop_table("inv_position_locations")
