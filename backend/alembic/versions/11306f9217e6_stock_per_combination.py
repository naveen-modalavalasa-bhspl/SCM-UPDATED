"""Stock per combination: brand, variant, model on stk_balance and stk_ledger
(2026-10-23).

The combination becomes part of the stock row's key — 100 of Brand A and 50 of Brand B
are two rows. Existing rows keep 0 ("none named"): nothing is re-tagged here, because
paths that take stock out by an exact bin and batch must still find the row they did
yesterday. Re-tagging existing stock to each item's brand is a separate, later script.

Idempotent: adds only what is missing, and swaps the unique key only if the old one
is still the one in place.

Revision ID: 11306f9217e6
Revises: 3a9f7a787776
Create Date: 2026-10-23
"""
import sqlalchemy as sa
from alembic import op

revision = "11306f9217e6"
down_revision = "3a9f7a787776"
branch_labels = None
depends_on = None

COLUMNS = ("brand_id", "variant_id", "model_id")
OLD_KEY = "uq_stk_balance_item_wh_bin_batch_proj"
NEW_KEY = "uq_stk_balance_item_wh_bin_batch_proj_combo"
KEY_COLUMNS = ["item_id", "warehouse_id", "bin_id", "batch_id", "project_id", *COLUMNS]


def _columns(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if table not in inspector.get_table_names():
        return set()
    return {c["name"] for c in inspector.get_columns(table)}


def _unique_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    names = {u["name"] for u in inspector.get_unique_constraints(table)}
    names |= {i["name"] for i in inspector.get_indexes(table) if i.get("unique")}
    return names


def upgrade() -> None:
    for table in ("stk_balance", "stk_ledger"):
        present = _columns(table)
        if not present:
            continue
        for column in COLUMNS:
            if column not in present:
                op.add_column(table, sa.Column(column, sa.BigInteger(), nullable=False,
                                               server_default="0"))
    keys = _unique_names("stk_balance")
    if NEW_KEY not in keys:
        op.create_unique_constraint(NEW_KEY, "stk_balance", KEY_COLUMNS)
    if OLD_KEY in keys:
        op.drop_constraint(OLD_KEY, "stk_balance", type_="unique")


def downgrade() -> None:
    keys = _unique_names("stk_balance")
    if NEW_KEY in keys:
        op.drop_constraint(NEW_KEY, "stk_balance", type_="unique")
    for table in ("stk_balance", "stk_ledger"):
        for column in COLUMNS:
            if column in _columns(table):
                op.drop_column(table, column)
