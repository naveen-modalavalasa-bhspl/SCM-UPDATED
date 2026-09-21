"""purchase return: what the supplier is refunding

ADDED 2026-09-11, on top of `b9f1c3d5e7a2`. That migration let the supplier answer a
purchase return with ACCEPTED, RETURNED or REPLACED. ACCEPTED turned out to be half an
answer: it said the supplier was keeping the goods and said nothing about what we get
back for them, so a return could sit settled with neither money nor replacement goods
owed by anybody. The buyer chased it by telephone, which is the same hole the portal was
built to close.

`REFUNDED` splits that half-answer in two (`enums.VendorReturnResponse`) — the supplier
keeps the goods and credits their value — and this column carries the figure.

STORED, not derived from `pro_returns.total_value`. A partial credit is the normal case,
not an exception: freight deducted, a restocking charge kept back, or one line of the
consignment disputed. Reading the refund off the return's own value would have been
correct until the first short credit arrived and then silently wrong, with nothing on the
document to show the two numbers had ever differed. `Numeric(16, 2)`, matching `MONEY`
and therefore `total_value`, so the two are compared and displayed in the same scale.

No enum type to alter: `vendor_response` is a plain `String(30)`, so `REFUNDED` needs no
schema change of its own. Only the amount is new.

NULLABLE with no default, so every existing row reads exactly as it did. NULL is
meaningful and not missing data — it is "this return was not settled in money", which is
true of every RETURNED and REPLACED answer, of the legacy ACCEPTED rows, and of every
return still waiting on its supplier.

Revision ID: d1f3b5a7c9e2
Revises: b9f1c3d5e7a2
Create Date: 2026-09-11

NOTE ON THE ID, inherited from `b9f1c3d5e7a2`: the house sequence collides with older
files that declare `revision` WITHOUT the `: str` annotation, and Alembic only complains
at run time with a cycle error naming forty revisions rather than the duplicate. This id
was checked against both spellings before being taken.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d1f3b5a7c9e2"
down_revision: Union[str, Sequence[str], None] = "b9f1c3d5e7a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_RETURNS = "pro_returns"

#: Mirrors `models.PurchaseReturn.vendor_refund_amount`, whose type is `MONEY`
#: (`Numeric(16, 2)`) — the same scale as `total_value`, which it is capped against.
_COLUMN = ("vendor_refund_amount", sa.Numeric(16, 2), {"nullable": True})

#: No index. Unlike `vendor_response`, which every portal and store screen filters on,
#: this is read only once a single return is already open, and nothing sorts or groups
#: by it. `pro_returns` also carries a JSON-free row, but the rule in CLAUDE.md still
#: applies to anything that might later ORDER BY it: order by `id`, not by this.


def _existing_columns(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(table)}


def upgrade() -> None:
    # Idempotent, exactly as `b9f1c3d5e7a2` and `d0e1f2a3b4c5` are: a database built by
    # `scripts.bootstrap` takes its whole schema from the models and already has this.
    bind = op.get_bind()

    name, type_, kw = _COLUMN
    if name not in _existing_columns(bind, _RETURNS):
        op.add_column(_RETURNS, sa.Column(name, type_, **kw))


def downgrade() -> None:
    bind = op.get_bind()

    # Dropping this loses the refunded figures and nothing else: the ANSWER itself lives
    # in `vendor_response`, so a downgraded database still knows which returns were
    # refunded — it just can no longer say for how much. Rows answered REFUNDED are left
    # as they are rather than rewritten to ACCEPTED, because guessing at a downgrade what
    # the supplier meant is worse than a value the older code words from the served
    # label map anyway.
    name, _type, _kw = _COLUMN
    if name in _existing_columns(bind, _RETURNS):
        op.drop_column(_RETURNS, name)
