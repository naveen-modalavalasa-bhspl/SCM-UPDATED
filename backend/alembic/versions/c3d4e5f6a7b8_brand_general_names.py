"""Map brands to general names.

A brand already carries its manufacturers inline (mst_brand_manufacturers), which is
what lets the item form narrow Manufacturer once a Brand is chosen. This adds the
rung above it, so the same form can narrow Brand once a General Name is chosen:

    Category -> General Name -> Brand -> Manufacturer

Additive only. No existing table is altered and no row is touched, so an item
created before this migration keeps every value it had.

Revision ID: c3d4e5f6a7b8
Revises: b8c9d0e1f2a3
Create Date: 2026-08-06
"""
import sqlalchemy as sa
from alembic import op

revision = "c3d4e5f6a7b8"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None

# f9b0c1d2e3f4 set the database default, so a new table inherits this anyway. Stated
# explicitly because inheriting it silently is exactly how the last drift happened.
COLLATION = "utf8mb4_unicode_ci"


def upgrade() -> None:
    op.create_table(
        "mst_brand_general_names",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("general_name_id", sa.BigInteger(), nullable=False),
        # Snapshots, same reason as mst_brand_manufacturers: the general-names list
        # renders its brands without joining mst_brands.
        sa.Column("general_name_code", sa.String(10), nullable=True),
        sa.Column("general_name_name", sa.String(200), nullable=True),
        sa.Column("brand_id", sa.BigInteger(), nullable=False),
        sa.Column("brand_code", sa.String(10), nullable=True),
        sa.Column("brand_name", sa.String(200), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["general_name_id"], ["mst_general_names.id"]),
        sa.ForeignKeyConstraint(["brand_id"], ["mst_brands.id"]),
        sa.UniqueConstraint("general_name_id", "brand_id",
                            name="uq_general_name_brand"),
        mysql_charset="utf8mb4",
        mysql_collate=COLLATION,
    )
    op.create_index("ix_mst_brand_general_names_general_name_id",
                    "mst_brand_general_names", ["general_name_id"])
    op.create_index("ix_mst_brand_general_names_brand_id",
                    "mst_brand_general_names", ["brand_id"])


def downgrade() -> None:
    op.drop_index("ix_mst_brand_general_names_brand_id",
                  table_name="mst_brand_general_names")
    op.drop_index("ix_mst_brand_general_names_general_name_id",
                  table_name="mst_brand_general_names")
    op.drop_table("mst_brand_general_names")
