"""Stock Transfer: an STO names the STR it serves and the issue that executes it.

`inv_sto` gains `str_id` / `str_no` (the Stock Transfer Request, an `ind_indents`
row of type STR — NULL on an STO raised directly) and `issue_id` / `issue_no` (the
warehouse material issue that posts the stock out). Idempotent.

Revision ID: b5d7f9a1c3e6
Revises: a4c6e8f0b2d3
"""
from alembic import op
import sqlalchemy as sa

revision = "b5d7f9a1c3e6"
down_revision = "a4c6e8f0b2d3"
branch_labels = None
depends_on = None

_COLUMNS = (
    ("str_id", sa.BigInteger()),
    ("str_no", sa.String(50)),
    ("issue_id", sa.BigInteger()),
    ("issue_no", sa.String(50)),
)
_INDEXES = (("ix_inv_sto_str_id", "str_id"), ("ix_inv_sto_issue_id", "issue_id"))


def _inspector():
    return sa.inspect(op.get_bind())


def upgrade() -> None:
    have = {c["name"] for c in _inspector().get_columns("inv_sto")}
    for name, type_ in _COLUMNS:
        if name not in have:
            op.add_column("inv_sto", sa.Column(name, type_, nullable=True))
    indexes = {i["name"] for i in _inspector().get_indexes("inv_sto")}
    for name, column in _INDEXES:
        if name not in indexes:
            op.create_index(name, "inv_sto", [column])


def downgrade() -> None:
    indexes = {i["name"] for i in _inspector().get_indexes("inv_sto")}
    for name, _column in _INDEXES:
        if name in indexes:
            op.drop_index(name, table_name="inv_sto")
    have = {c["name"] for c in _inspector().get_columns("inv_sto")}
    for name, _type in _COLUMNS:
        if name in have:
            op.drop_column("inv_sto", name)
