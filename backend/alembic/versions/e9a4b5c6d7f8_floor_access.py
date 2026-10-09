"""additional floor access for HCM floor in-charges

Revision ID: e9a4b5c6d7f8
Revises: d8f3a7c1e9b4
"""
from alembic import op
import sqlalchemy as sa

revision = "e9a4b5c6d7f8"
down_revision = "d8f3a7c1e9b4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "inv_position_location_access",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("position_id", sa.BigInteger(), nullable=True),
        sa.Column("warehouse_id", sa.BigInteger(), nullable=False),
        sa.Column("location_id", sa.BigInteger(), nullable=False),
        sa.Column("granted_by_id", sa.BigInteger(), nullable=True),
        sa.Column("is_active", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(["warehouse_id"], ["whs_warehouses.id"],
                                ondelete="CASCADE"),
        sa.UniqueConstraint("position_id", "location_id",
                            name="uq_inv_position_location_access"),
    )
    op.create_index("ix_inv_position_location_access_warehouse_id",
                    "inv_position_location_access", ["warehouse_id"])
    op.create_index("ix_inv_position_location_access_location_id",
                    "inv_position_location_access", ["location_id"])


def downgrade():
    op.drop_table("inv_position_location_access")
