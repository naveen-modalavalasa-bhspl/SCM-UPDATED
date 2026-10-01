"""Vendor categories and which vendors are in them (2026-10-01).

`mst_vendor_categories` is a master (Glassware, Reagents ...), and
`mst_vendor_category_members` tags vendors to it, many-to-many. The vendor material
mapping screen groups its suppliers by these.

Guarded by the inspector: a database built by ``bootstrap`` already has both.

Revision ID: f2b4d6e8a1c3
Revises: f1b3d5e7a9c2
Create Date: 2026-10-01
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f2b4d6e8a1c3"
down_revision: Union[str, Sequence[str], None] = "f1b3d5e7a9c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = sa.inspect(op.get_bind()).get_table_names()
    if "mst_vendor_categories" not in tables:
        op.create_table(
            "mst_vendor_categories",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(10), nullable=False, unique=True),
            sa.Column("name", sa.String(150), nullable=False),
            sa.Column("description", sa.String(300), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if "mst_vendor_category_members" not in tables:
        op.create_table(
            "mst_vendor_category_members",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("category_id", sa.BigInteger(),
                      sa.ForeignKey("mst_vendor_categories.id", ondelete="CASCADE"),
                      nullable=False),
            sa.Column("vendor_id", sa.BigInteger(),
                      sa.ForeignKey("mst_vendors.id", ondelete="CASCADE"), nullable=False),
            sa.UniqueConstraint("category_id", "vendor_id", name="uq_vendor_category_member"),
        )
        op.create_index("ix_mst_vendor_category_members_category_id",
                        "mst_vendor_category_members", ["category_id"])
        op.create_index("ix_mst_vendor_category_members_vendor_id",
                        "mst_vendor_category_members", ["vendor_id"])


def downgrade() -> None:
    tables = sa.inspect(op.get_bind()).get_table_names()
    if "mst_vendor_category_members" in tables:
        op.drop_table("mst_vendor_category_members")
    if "mst_vendor_categories" in tables:
        op.drop_table("mst_vendor_categories")
