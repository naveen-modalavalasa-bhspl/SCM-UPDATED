"""expected delivery window: a start date beside the existing (end) date

`expected_delivery` stays the END of the window, so every reader that sorts or
compares on it keeps its meaning; `expected_delivery_from` is the new START. Added on
the consignment (`out_dispatches`) and on the shipment that carries it
(`lgs_transport_requests`). Nullable: rows written before this only ever stated one
date, and that date is read as the end.

Revision ID: e2a4c6b8d0f3
Revises: da110162fdb7
Create Date: 2026-11-19
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e2a4c6b8d0f3"
down_revision: Union[str, None] = "da110162fdb7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLES = ("out_dispatches", "lgs_transport_requests")
_COLUMN = "expected_delivery_from"


def _has(table: str) -> tuple[bool, bool]:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(table):
        return False, False
    return True, any(c["name"] == _COLUMN for c in inspector.get_columns(table))


def upgrade() -> None:
    for table in _TABLES:
        exists, has_column = _has(table)
        if exists and not has_column:
            op.add_column(table, sa.Column(_COLUMN, sa.Date(), nullable=True))


def downgrade() -> None:
    for table in _TABLES:
        exists, has_column = _has(table)
        if exists and has_column:
            op.drop_column(table, _COLUMN)
