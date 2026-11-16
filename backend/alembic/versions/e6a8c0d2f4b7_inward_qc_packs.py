"""Inward QC decides by the PACK (2026-10-27).

`inb_inspection_items.accepted_pack_breakdown` / `rejected_pack_breakdown` — on a
receipt line counted in packs, which packs QC kept and which it rejected (a pack
rejected whole, or the units taken out of a pack that was otherwise kept). Putaway
shelves the accepted packs, so a rejected carton never reaches a bin. Idempotent.

Revision ID: e6a8c0d2f4b7
Revises: d5f7b9c1e3a6
Create Date: 2026-10-27
"""
import sqlalchemy as sa
from alembic import op

revision = "e6a8c0d2f4b7"
down_revision = "d5f7b9c1e3a6"
branch_labels = None
depends_on = None

COLUMNS = ("accepted_pack_breakdown", "rejected_pack_breakdown")


def upgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("inb_inspection_items")}
    for name in COLUMNS:
        if name not in cols:
            op.add_column("inb_inspection_items", sa.Column(name, sa.JSON(), nullable=True))


def downgrade() -> None:
    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("inb_inspection_items")}
    for name in COLUMNS:
        if name in cols:
            op.drop_column("inb_inspection_items", name)
