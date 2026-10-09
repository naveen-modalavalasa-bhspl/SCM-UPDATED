"""tell purchase returns apart by where the material came from

ADDED 2026-09-08, for the returns flow.

A purchase return recorded which warehouse was sending stock back and never
recorded where that stock had come from, and those are different questions.
Material rejected on the inspection bench the day it arrived is a supplier
quality problem; the same item coming back off a branch shelf six weeks later
is a field problem. They are chased differently, argued with the vendor
differently and reported separately — and until now the only place the
difference was written down was free text in `reason`, which no filter and no
report can read.

Three nullable columns, no backfill and no default:

  * `source_category` — FROM_WAREHOUSE / FROM_LIP_MDB / QC_REJECTED_GRN, named
    by `app.modules.returns.enums.PurchaseReturnSource`. Indexed because the
    register filters on it.
  * `source_return_id` / `source_return_no` — the branch stock return that
    produced this one, where the warehouse's acknowledgement of a returned load
    raised it automatically. A SOFT link on purpose: `inv_sto` is inventory's
    table and a purchase return outlives the transfer that caused it, so a
    foreign key here would make deleting the transfer impossible rather than
    making the history correct.

Every existing row keeps NULL in all three, which reads as "raised by hand at
the warehouse, source not stated" — true of every purchase return raised before
today. Nothing in the warehouse module reads the columns, so no existing route
changes behaviour.

Revision ID: a7b8c9d0e1f2
Revises: a4c8e2b7d1f9
Create Date: 2026-09-08
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, Sequence[str], None] = "a4c8e2b7d1f9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "pro_returns"
_COLUMNS = (
    ("source_category", sa.String(length=30)),
    ("source_return_id", sa.BigInteger()),
    ("source_return_no", sa.String(length=50)),
)


def _existing(bind) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(_TABLE)}


def _index_names(bind) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_indexes(_TABLE)}


def upgrade() -> None:
    # Idempotent per column: a database built by `scripts.bootstrap` gets the whole
    # schema from the models and therefore already has these, and CLAUDE.md documents
    # that as the supported way to build a new one.
    bind = op.get_bind()
    present = _existing(bind)
    for name, type_ in _COLUMNS:
        if name not in present:
            op.add_column(_TABLE, sa.Column(name, type_, nullable=True))

    indexes = _index_names(bind)
    for name in ("source_category", "source_return_id"):
        index_name = f"ix_{_TABLE}_{name}"
        if index_name not in indexes:
            op.create_index(index_name, _TABLE, [name])


def downgrade() -> None:
    bind = op.get_bind()
    indexes = _index_names(bind)
    for name in ("source_return_id", "source_category"):
        index_name = f"ix_{_TABLE}_{name}"
        if index_name in indexes:
            op.drop_index(index_name, table_name=_TABLE)

    present = _existing(bind)
    for name, _ in reversed(_COLUMNS):
        if name in present:
            op.drop_column(_TABLE, name)
