"""The stock ledger names the packs a movement was (2026-10-08).

Adds `stk_ledger.pack_text` — "2 Box + 5 Strip = 25 TAB" — written by putaway, bulk
receipt and material issue, snapshotted like every other name on the row. NULL on
every row written before, and on movements nobody packed.

Idempotent: checks the live schema first.

Revision ID: f3b5d7f9a1c4
Revises: e2a4c6e8f0b3
Create Date: 2026-10-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f3b5d7f9a1c4"
down_revision: Union[str, Sequence[str], None] = "e2a4c6e8f0b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "stk_ledger"


def _columns() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if "pack_text" not in _columns():
        op.add_column(TABLE, sa.Column("pack_text", sa.String(300), nullable=True))


def downgrade() -> None:
    if "pack_text" in _columns():
        op.drop_column(TABLE, "pack_text")
