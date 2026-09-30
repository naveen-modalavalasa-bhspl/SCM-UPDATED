"""monthly indent window may span months, and names the month it serves

Revision ID: c2e5a8b1d7f3
Revises: a7c9e1f2b4d6
Create Date: 2026-09-21

`end_day < start_day` was the only way to say "this window runs past the end of its
own month", which caps a cycle at one month: "the 1st of this month to the 31st of
next" could not be configured at all. `end_month_offset` states the closing month
outright and `serves_month_offset` separates which month the indents are FOR from
where the window sits, so collecting through October for November is one setting
rather than a window pushed into the future.

Both default to 0, which is exactly the behaviour every existing row already has.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c2e5a8b1d7f3"
down_revision: Union[str, Sequence[str], None] = "a7c9e1f2b4d6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns() -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mi_settings'"
    ))}


def upgrade() -> None:
    have = _columns()
    if "end_month_offset" not in have:
        op.add_column("mi_settings", sa.Column(
            "end_month_offset", sa.Integer(), server_default="0", nullable=False))
    if "serves_month_offset" not in have:
        op.add_column("mi_settings", sa.Column(
            "serves_month_offset", sa.Integer(), server_default="0", nullable=False))


def downgrade() -> None:
    have = _columns()
    if "serves_month_offset" in have:
        op.drop_column("mi_settings", "serves_month_offset")
    if "end_month_offset" in have:
        op.drop_column("mi_settings", "end_month_offset")
