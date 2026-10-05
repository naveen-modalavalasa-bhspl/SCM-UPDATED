"""`inv_material_request_items.received_quantity` (2026-10-04).

One material request carried six lines of BHS/104/2026-27/IND0072; two were bought and
put away. A request closes only when EVERY line has arrived, so it stayed open and all
six lines kept counting as "on order" — the fulfilment desk offered 0 of the 1,100
slides and cover slips sitting on the shelf. The column records what of each line has
reached stock, so "on order" is per line. Idempotent.

Backfill the rows already received with
    .venv/Scripts/python -m scripts.sync_po_receipts --apply

Revision ID: b4d6f8a0c2e4
Revises: a3c5e7f9b1d2
Create Date: 2026-10-04
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b4d6f8a0c2e4"
down_revision: Union[str, Sequence[str], None] = "a3c5e7f9b1d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "inv_material_request_items"
COLUMN = "received_quantity"


def _has_column() -> bool:
    return COLUMN in {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    if not _has_column():
        op.add_column(TABLE, sa.Column(COLUMN, sa.Numeric(16, 3), nullable=False,
                                       server_default="0"))


def downgrade() -> None:
    if _has_column():
        op.drop_column(TABLE, COLUMN)
