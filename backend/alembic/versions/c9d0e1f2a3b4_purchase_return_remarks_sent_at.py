"""purchase return vendor-send: remarks and sent_at

ADDED for the Purchase Return to Vendor flow (Draft -> SENT_TO_VENDOR).

Two nullable columns on `pro_returns`, no backfill and no default:

  * `remarks`  — free-text notes captured beside the reason on the return form.
  * `sent_at`  — when a DRAFT was sent to the vendor. Null until sent; written in
    the same transaction as the DRAFT -> SENT_TO_VENDOR flip so the two can
    never disagree, and read back on the detail for the review screen.

Every existing row keeps NULL in both, which reads as "never sent, no notes" —
true of every purchase return raised before today. Idempotent per column: a
database built by `scripts.bootstrap` gets the whole schema from the models and
therefore already has these.

Revision ID: c9d0e1f2a3b4
Revises: a7b8c9d0e1f2
Create Date: 2026-09-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c9d0e1f2a3b4"
down_revision: Union[str, Sequence[str], None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "pro_returns"
_COLUMNS = (
    ("remarks", sa.Text()),
    ("sent_at", sa.DateTime()),
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
