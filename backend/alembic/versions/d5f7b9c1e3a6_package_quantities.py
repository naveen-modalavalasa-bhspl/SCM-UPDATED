"""Quantities by the PACKAGE through QC, packing and receipt (2026-10-26).

`whs_inspection_items.pack_rejections` — on a line issued in packages, how many units
were rejected out of each package that was otherwise kept ({code: qty}); whole
packages rejected are simply not in the accepted codes. `out_dispatch_items.box_code`
— the package (box / strip) a consignment row carries, so a carton knows exactly which
packages are in it. Idempotent.

Revision ID: d5f7b9c1e3a6
Revises: c3e5a7b9d1f4
Create Date: 2026-10-26
"""
import sqlalchemy as sa
from alembic import op

revision = "d5f7b9c1e3a6"
down_revision = "c3e5a7b9d1f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    cols = {c["name"] for c in inspector.get_columns("whs_inspection_items")}
    if "pack_rejections" not in cols:
        op.add_column("whs_inspection_items",
                      sa.Column("pack_rejections", sa.JSON(), nullable=True))
    cols = {c["name"] for c in inspector.get_columns("out_dispatch_items")}
    if "box_code" not in cols:
        op.add_column("out_dispatch_items",
                      sa.Column("box_code", sa.String(120), nullable=True))
        op.create_index("ix_out_dispatch_items_box_code", "out_dispatch_items", ["box_code"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    cols = {c["name"] for c in inspector.get_columns("out_dispatch_items")}
    if "box_code" in cols:
        op.drop_index("ix_out_dispatch_items_box_code", table_name="out_dispatch_items")
        op.drop_column("out_dispatch_items", "box_code")
    cols = {c["name"] for c in inspector.get_columns("whs_inspection_items")}
    if "pack_rejections" in cols:
        op.drop_column("whs_inspection_items", "pack_rejections")
