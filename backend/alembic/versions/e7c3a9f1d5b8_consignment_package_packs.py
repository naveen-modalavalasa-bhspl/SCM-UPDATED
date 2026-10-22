"""Packs inside each consignment package (2026-10-22).

`out_dispatch_packages.item_packs` — per issue line packed into the carton, the
hierarchy and the packs that carton holds of it, decided (or changed) by the packer.
The acknowledgement shows them and the destination shelves them. JSON, because a
carton holds several lines and the rows of a coded item are one per unit.

Idempotent: checks the live schema first.

Revision ID: e7c3a9f1d5b8
Revises: a0c2e4f6b8d1
Create Date: 2026-10-22
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e7c3a9f1d5b8"
down_revision: Union[str, Sequence[str], None] = "a0c2e4f6b8d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE, COLUMN = "out_dispatch_packages", "item_packs"


def _columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if TABLE not in inspector.get_table_names():
        return set()
    return {c["name"] for c in inspector.get_columns(TABLE)}


def upgrade() -> None:
    present = _columns()
    if present and COLUMN not in present:
        op.add_column(TABLE, sa.Column(COLUMN, sa.JSON(), nullable=True))


def downgrade() -> None:
    if COLUMN in _columns():
        op.drop_column(TABLE, COLUMN)
