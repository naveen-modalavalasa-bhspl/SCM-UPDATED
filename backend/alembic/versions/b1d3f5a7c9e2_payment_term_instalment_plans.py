"""Payment terms: every stage may be paid in EQUAL or CUSTOM instalments (2026-10-06).

Adds, per stage (advance, delivery, installation, warranty), `<stage>_split`
(ONE / EQUAL / CUSTOM), `<stage>_instalment_days` and `<stage>_instalment_pcts`.
The old `delivery_schedule` -- equal instalments of the delivery share only -- is
carried across as `delivery_split = EQUAL` with the same days, then dropped.

Idempotent: every step checks the live schema first.

Revision ID: b1d3f5a7c9e2
Revises: a9c1e3f5b7d9
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b1d3f5a7c9e2"
down_revision: Union[str, Sequence[str], None] = "a9c1e3f5b7d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "mst_payment_terms"
STAGES = ("advance", "delivery", "installation", "warranty")


def _columns() -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    have = _columns()
    for stage in STAGES:
        if f"{stage}_split" not in have:
            op.add_column(TABLE, sa.Column(f"{stage}_split", sa.String(10),
                                           nullable=False, server_default="ONE"))
        for suffix in ("instalment_days", "instalment_pcts"):
            if f"{stage}_{suffix}" not in have:
                op.add_column(TABLE, sa.Column(f"{stage}_{suffix}", sa.String(120),
                                               nullable=True))
    if "delivery_schedule" in have:
        # Only a schedule of two or more days was ever instalments; a single day was
        # one payment on that day.
        op.execute(sa.text(f"""
            UPDATE {TABLE}
               SET delivery_split = 'EQUAL',
                   delivery_instalment_days = delivery_schedule,
                   delivery_days = CAST(SUBSTRING_INDEX(delivery_schedule, ',', 1)
                                        AS UNSIGNED)
             WHERE delivery_schedule LIKE '%,%' AND delivery_pct > 0"""))
        op.execute(sa.text(f"""
            UPDATE {TABLE}
               SET delivery_days = CAST(delivery_schedule AS UNSIGNED)
             WHERE delivery_schedule IS NOT NULL AND delivery_schedule <> ''
               AND delivery_schedule NOT LIKE '%,%'"""))
        op.drop_column(TABLE, "delivery_schedule")


def downgrade() -> None:
    have = _columns()
    if "delivery_schedule" not in have:
        op.add_column(TABLE, sa.Column("delivery_schedule", sa.String(60), nullable=True))
        if "delivery_instalment_days" in have:
            # A CUSTOM split has no equal-instalment equivalent; its days survive and
            # the shares are lost, which is what a downgrade is.
            op.execute(sa.text(f"""
                UPDATE {TABLE} SET delivery_schedule = LEFT(delivery_instalment_days, 60)
                 WHERE delivery_split <> 'ONE'"""))
    for stage in STAGES:
        for suffix in ("split", "instalment_days", "instalment_pcts"):
            if f"{stage}_{suffix}" in have:
                op.drop_column(TABLE, f"{stage}_{suffix}")
