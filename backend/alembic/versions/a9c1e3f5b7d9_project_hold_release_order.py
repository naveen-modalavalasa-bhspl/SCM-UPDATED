"""`stk_project_holds`: a release is a Stock Movement Order — the order in flight and
what it moves (2026-10-06). Idempotent.

Revision ID: a9c1e3f5b7d9
Revises: f8b0d2e4a6c8
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a9c1e3f5b7d9"
down_revision: Union[str, Sequence[str], None] = "f8b0d2e4a6c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "stk_project_holds"
COLUMNS = [
    sa.Column("release_order_id", sa.BigInteger, nullable=True),
    sa.Column("release_order_no", sa.String(50), nullable=True),
    sa.Column("release_qty", sa.Numeric(16, 3), nullable=True),
    sa.Column("release_serials", sa.JSON, nullable=True),
    sa.Column("release_destination", sa.String(100), nullable=True),
    sa.Column("pending_release_reason", sa.String(500), nullable=True),
    sa.Column("pending_lend_project_id", sa.BigInteger, nullable=True),
    sa.Column("pending_lend_project_name", sa.String(200), nullable=True),
]


def _have() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    have = _have()
    for column in COLUMNS:
        if column.name not in have:
            op.add_column(TABLE, column.copy())
    indexes = {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(TABLE)}
    if "ix_stk_project_holds_release_order_id" not in indexes:
        op.create_index("ix_stk_project_holds_release_order_id", TABLE, ["release_order_id"])


def downgrade() -> None:
    have = _have()
    indexes = {i["name"] for i in sa.inspect(op.get_bind()).get_indexes(TABLE)}
    if "ix_stk_project_holds_release_order_id" in indexes:
        op.drop_index("ix_stk_project_holds_release_order_id", TABLE)
    for column in COLUMNS:
        if column.name in have:
            op.drop_column(TABLE, column.name)
