"""trays on a material issue line (MoM 2026-11-18, point 14)

`out_issue_items.trays` — JSON, the trays a pick is put into: tray number, quantity
and the codes in it. Idempotent.

Revision ID: d7f9b1c3e5a8
Revises: c6e8a0b2d4f7
Create Date: 2026-11-20
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d7f9b1c3e5a8"
down_revision: Union[str, None] = "c6e8a0b2d4f7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("out_issue_items") and "trays" not in {
            c["name"] for c in inspector.get_columns("out_issue_items")}:
        op.add_column("out_issue_items", sa.Column("trays", sa.JSON, nullable=True))


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("out_issue_items") and "trays" in {
            c["name"] for c in inspector.get_columns("out_issue_items")}:
        op.drop_column("out_issue_items", "trays")
