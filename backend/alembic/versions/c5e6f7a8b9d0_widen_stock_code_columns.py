"""Widen the asset / consumable code columns on stk_balance.

They were varchar(40), which no generated code fits: the item code alone runs to about
40 characters before the formula adds anything, so every write failed with "Data too
long" and the columns stayed empty. `whs_serial_numbers` already uses 100 — this is the
two tables agreeing on the width of the same value.

`serial_number` is left alone: it is already `json` on the live table (the ORM had it
wrong as String(50), fixed in the model), and it holds the list of units in the lot.

Revision ID: c5e6f7a8b9d0
Revises: b3d5f7a9c1e2
Create Date: 2026-08-12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c5e6f7a8b9d0"
down_revision: Union[str, None] = "b3d5f7a9c1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for column in ("asset_code", "consumable_code"):
        op.alter_column("stk_balance", column,
                        existing_type=sa.String(length=40),
                        type_=sa.String(length=100),
                        existing_nullable=True)


def downgrade() -> None:
    # Narrowing back would truncate real codes, so the values are cleared first rather
    # than silently cut in half.
    for column in ("asset_code", "consumable_code"):
        op.execute(f"UPDATE stk_balance SET {column} = NULL "
                   f"WHERE CHAR_LENGTH({column}) > 40")
        op.alter_column("stk_balance", column,
                        existing_type=sa.String(length=100),
                        type_=sa.String(length=40),
                        existing_nullable=True)
