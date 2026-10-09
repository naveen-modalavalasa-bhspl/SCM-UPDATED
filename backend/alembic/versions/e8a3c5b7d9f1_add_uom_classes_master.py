"""mst_uom_classes — the kinds of unit, as a master instead of an enum (2026-10-01).

The UOM form's "What it measures" list (Count, Weight, Volume ...) was the UomClass
enum, so adding a kind meant a release. Seeded with every value the enum had, plus
any `mst_uom.uom_class` the data already uses, so nothing in use is left unlisted.

Guarded by the inspector: a database built by ``bootstrap`` already has the table.

Revision ID: e8a3c5b7d9f1
Revises: d4f2a6c8e1b3
Create Date: 2026-10-01
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e8a3c5b7d9f1"
down_revision: Union[str, Sequence[str], None] = "d4f2a6c8e1b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLE = "mst_uom_classes"
STANDARD = ("COUNT", "LENGTH", "AREA", "VOLUME", "WEIGHT", "TEMPERATURE", "TIME",
            "PRESSURE", "ENERGY", "PACKAGING")


def upgrade() -> None:
    bind = op.get_bind()
    if TABLE not in sa.inspect(bind).get_table_names():
        op.create_table(
            TABLE,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("code", sa.String(30), nullable=False, unique=True),
            sa.Column("name", sa.String(100), nullable=False),
            sa.Column("description", sa.String(300), nullable=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    have = {r[0] for r in bind.execute(sa.text(f"SELECT code FROM {TABLE}"))}
    used = {r[0] for r in bind.execute(sa.text(
        "SELECT DISTINCT uom_class FROM mst_uom WHERE uom_class IS NOT NULL"))}
    for code in [*STANDARD, *sorted(used - set(STANDARD))]:
        if code and code not in have:
            bind.execute(sa.text(
                f"INSERT INTO {TABLE} (code, name, is_active) VALUES (:c, :n, 1)"),
                {"c": code, "n": code.replace("_", " ").title()})


def downgrade() -> None:
    if TABLE in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table(TABLE)
