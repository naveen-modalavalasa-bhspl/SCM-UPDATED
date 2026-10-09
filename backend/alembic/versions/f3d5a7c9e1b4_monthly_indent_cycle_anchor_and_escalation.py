"""monthly indent: a fixed cycle anchor, the submitter allow-list, stepped escalation

Revision ID: f3d5a7c9e1b4
Revises: e2c4f6a8b0d3
Create Date: 2026-09-25

`mi_settings.anchor_month` is backfilled from the offset each row already had,
read against TODAY — which is exactly the window the screen was showing when this
ran, so nothing an administrator is looking at moves.
"""
from datetime import date
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3d5a7c9e1b4"
down_revision: Union[str, Sequence[str], None] = "e2c4f6a8b0d3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns(table: str) -> set[str]:
    bind = op.get_bind()
    return {row[0] for row in bind.execute(sa.text(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t"
    ), {"t": table})}


def _add_months(value: date, months: int) -> date:
    month = value.month - 1 + months
    return date(value.year + month // 12, month % 12 + 1, 1)


def upgrade() -> None:
    settings = _columns("mi_settings")
    if settings:
        if "anchor_month" not in settings:
            op.add_column("mi_settings", sa.Column("anchor_month", sa.Date(), nullable=True))
        if "restrict_to_rules" not in settings:
            op.add_column("mi_settings", sa.Column(
                "restrict_to_rules", sa.Boolean(), server_default="0", nullable=False))
        bind = op.get_bind()
        this_month = date.today().replace(day=1)
        rows = bind.execute(sa.text(
            "SELECT id, cycle_month_offset FROM mi_settings WHERE anchor_month IS NULL"
        )).all()
        for row_id, offset in rows:
            bind.execute(sa.text(
                "UPDATE mi_settings SET anchor_month = :a WHERE id = :i"
            ), {"a": _add_months(this_month, int(offset or 0)), "i": row_id})

    rules = _columns("mi_notification_rules")
    if rules:
        if "escalation_after_days" not in rules:
            op.add_column("mi_notification_rules", sa.Column(
                "escalation_after_days", sa.Integer(), nullable=True))
        if "escalation_levels" not in rules:
            op.add_column("mi_notification_rules", sa.Column(
                "escalation_levels", sa.Integer(), server_default="1", nullable=False))


def downgrade() -> None:
    rules = _columns("mi_notification_rules")
    for name in ("escalation_levels", "escalation_after_days"):
        if name in rules:
            op.drop_column("mi_notification_rules", name)
    settings = _columns("mi_settings")
    for name in ("restrict_to_rules", "anchor_month"):
        if name in settings:
            op.drop_column("mi_settings", name)
