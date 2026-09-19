"""inbound receipt: when the goods are expected

ADDED 2026-09-11, on top of `d1f3b5a7c9e2`. A supplier answering a purchase return with
REPLACED has always raised a DRAFT inbound receipt at the warehouse that sent the goods,
so the store knew WHAT to expect — and never when. The storekeeper found out when the
lorry appeared at the gate. The supplier now states the arrival date in the same press
that promises the replacement, and this is where it lands.

WHY A NEW COLUMN, when `inb_receipts` already carries three dates. None of them can say
"a vehicle is coming on the 20th":

  `grn_date`      this document's own date, NOT NULL, set when the row is raised.
  `invoice_date`  the supplier's paperwork, which may predate despatch by days.
  `gate_entry_at` the moment a vehicle ACTUALLY turned up — the opposite of a promise.

Overloading any of them would corrupt its meaning for every existing reader, and the
receiving queue has to SORT by the expectation, so it cannot live in `remarks`.

The transporter, vehicle and LR the supplier also states needed nothing: `transporter_
name`, `vehicle_no` and `lr_no` were already on this table, which is why only the date
is here.

NULLABLE with no default, and null is meaningful rather than missing: a receipt written
AT the gate describes goods already standing there, and every row raised before today is
in exactly that state.

Revision ID: e2b4d6f8a1c3
Revises: d1f3b5a7c9e2
Create Date: 2026-09-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e2b4d6f8a1c3"
down_revision: Union[str, Sequence[str], None] = "d1f3b5a7c9e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_RECEIPTS = "inb_receipts"
_COLUMN = ("expected_delivery", sa.Date(), {"nullable": True})

#: No index. The receiving queue is already scoped by `ix_inb_receipts_status_wh` (status
#: plus warehouse) before any date ordering applies, and `inb_receipts` carries no JSON
#: column, so the CLAUDE.md filesort trap does not bite here. Add one if a screen ever
#: orders the whole table by this.


def _existing_columns(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(table)}


def upgrade() -> None:
    # Idempotent per column, as every migration in this chain is: a database built by
    # `scripts.bootstrap` takes its schema from the models and already has this.
    bind = op.get_bind()

    name, type_, kw = _COLUMN
    if name not in _existing_columns(bind, _RECEIPTS):
        op.add_column(_RECEIPTS, sa.Column(name, type_, **kw))


def downgrade() -> None:
    bind = op.get_bind()

    # Losing this loses only the PROMISED date. What physically arrived is recorded by
    # `received_qty` and `gate_entry_at`, so a downgraded database still knows what came
    # in — it just cannot say when it had been expected.
    name, _type, _kw = _COLUMN
    if name in _existing_columns(bind, _RECEIPTS):
        op.drop_column(_RECEIPTS, name)
