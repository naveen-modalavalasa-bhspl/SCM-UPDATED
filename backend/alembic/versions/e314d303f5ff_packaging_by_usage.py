"""Packaging by usage (2026-10-23).

* `mst_pack_hierarchies.brand_id` / `brand_name` — a ladder belongs to an item AND a
  brand; NULL reads as "All brands".
* `mst_item_container_usage` — which container types of an item serve indent,
  purchase, storage, issue and consumption.

Idempotent: adds only what is missing.

Revision ID: e314d303f5ff
Revises: 3d02a9438e86
Create Date: 2026-10-23
"""
import sqlalchemy as sa
from alembic import op

revision = "e314d303f5ff"
down_revision = "3d02a9438e86"
branch_labels = None
depends_on = None


def upgrade() -> None:
    insp = sa.inspect(op.get_bind())
    cols = {c["name"] for c in insp.get_columns("mst_pack_hierarchies")}
    if "brand_id" not in cols:
        op.add_column("mst_pack_hierarchies", sa.Column("brand_id", sa.BigInteger(), nullable=True))
        op.create_index("ix_mst_pack_hierarchies_brand_id", "mst_pack_hierarchies", ["brand_id"])
    if "brand_name" not in cols:
        op.add_column("mst_pack_hierarchies", sa.Column("brand_name", sa.String(200), nullable=True))
    if "mst_item_container_usage" not in insp.get_table_names():
        op.create_table(
            "mst_item_container_usage",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("item_id", sa.BigInteger(),
                      sa.ForeignKey("mst_items.id", ondelete="CASCADE"), nullable=False),
            sa.Column("package_id", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("usage", sa.String(20), nullable=False),
            sa.Column("created_at", sa.DateTime(), nullable=False,
                      server_default=sa.func.now()),
            sa.UniqueConstraint("item_id", "package_id", "usage",
                                name="uq_item_container_usage"),
        )
        op.create_index("ix_mst_item_container_usage_item_id",
                        "mst_item_container_usage", ["item_id"])


def downgrade() -> None:
    insp = sa.inspect(op.get_bind())
    if "mst_item_container_usage" in insp.get_table_names():
        op.drop_table("mst_item_container_usage")
    cols = {c["name"] for c in insp.get_columns("mst_pack_hierarchies")}
    if "brand_name" in cols:
        op.drop_column("mst_pack_hierarchies", "brand_name")
    if "brand_id" in cols:
        op.drop_index("ix_mst_pack_hierarchies_brand_id", "mst_pack_hierarchies")
        op.drop_column("mst_pack_hierarchies", "brand_id")
