"""purchase return internal refund stamp

ADDED for the Refund leg of the post-send workflow (VENDOR_APPROVED -> REFUNDED).

Three nullable columns on `pro_returns`, no backfill and no default:

  * `refunded_at`      — when the desk settled the return in money.
  * `refunded_by_name` — who recorded it (snapshot, like every `*_by_name` here).
  * `refund_remarks`   — anything said beside the amount.

The AMOUNT itself reuses `vendor_refund_amount` rather than taking a column: a
credit is a credit whichever desk recorded it, and the supplier-answer card
already reads that one. These three are the stamp that says THIS desk settled
it, so a desk-recorded refund can never read as an answer the supplier gave on
their portal.

Every existing row keeps NULL in all three, which reads as "never refunded" —
true of every purchase return raised before today.

Revision ID: e2f4a6b8c0d1
Revises: b7e3c1a9d5f2
Create Date: 2026-09-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e2f4a6b8c0d1"
down_revision: Union[str, Sequence[str], None] = "b7e3c1a9d5f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "pro_returns"
_COLUMNS = (
    ("refunded_at", sa.DateTime()),
    ("refunded_by_name", sa.String(length=200)),
    ("refund_remarks", sa.Text()),
)


def _existing(bind) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(_TABLE)}


def upgrade() -> None:
    # Idempotent per column: a database built by `scripts.bootstrap` gets the whole
    # schema from the models and therefore already has these, and CLAUDE.md documents
    # that as the supported way to build a new one.
    bind = op.get_bind()
    present = _existing(bind)
    for name, type_ in _COLUMNS:
        if name not in present:
            op.add_column(_TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    present = _existing(bind)
    for name, _ in reversed(_COLUMNS):
        if name in present:
            op.drop_column(_TABLE, name)
