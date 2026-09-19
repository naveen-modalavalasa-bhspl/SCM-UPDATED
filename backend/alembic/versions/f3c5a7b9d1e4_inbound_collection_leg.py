"""inbound receipt: does it come to us, or do we fetch it

ADDED 2026-09-11, on top of `e2b4d6f8a1c3`. That migration let a supplier promising a
replacement say WHEN it would reach our warehouse, which assumed the supplier was the
one sending it. Frequently they are not: the goods are ready on their dock and they ask
us to send a vehicle. The portal had no way to say so, so a collection was recorded as a
delivery and then waited for at a gate nobody was driving to.

`inbound_transport_mode` is the axis that was missing: `SUPPLIER_DELIVERS` or
`WE_COLLECT` (`schemas.INBOUND_TRANSPORT_MODES`).

WHY NOT `TransportMode`, which already exists. That enum — DIRECT, COURIER, OWN_VEHICLE,
THIRD_PARTY — answers "how does it travel and who is paid", and every one of its values
describes a leg arranged by whoever is SENDING. On goods coming towards us the first
question is whether anything is coming at all, and `OWN_VEHICLE` cannot answer it
because "own vehicle" is ambiguous between the supplier's truck and ours. The two axes
are independent; collapsing them loses the answer the store acts on.

The other two columns are a collection's own facts:

`pickup_address`    where our vehicle goes. `inb_receipts` held no address at all —
                    every other receipt describes goods that came to us.
`goods_ready_date`  when it can be collected. Deliberately NOT `expected_delivery`:
                    the supplier is promising the goods will be ready on their dock, not
                    that they will be at our gate, and writing a ready date into the
                    arrival column would have the receiving queue expecting a lorry on a
                    day nothing is coming. `expected_delivery` stays NULL on a
                    collection until somebody here schedules the vehicle.

No pickup CONTACT columns on purpose: `mst_vendors` already holds the supplier's contact
person and phone and the portal already serves them onto the return, so a second copy
here would only go stale.

All three NULLABLE with no default. Null is meaningful rather than missing — it is "this
receipt was not raised in advance of the goods", which is true of every row before today
and of every receipt written at the gate, where the goods are already standing in front
of the storekeeper and the question is moot.

Revision ID: f3c5a7b9d1e4
Revises: e2b4d6f8a1c3
Create Date: 2026-09-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f3c5a7b9d1e4"
down_revision: Union[str, Sequence[str], None] = "e2b4d6f8a1c3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_RECEIPTS = "inb_receipts"

_COLUMNS = (
    ("inbound_transport_mode", sa.String(30), {"nullable": True}),
    ("pickup_address", sa.String(500), {"nullable": True}),
    ("goods_ready_date", sa.Date(), {"nullable": True}),
)

#: No index, for the same reason `expected_delivery` has none: the receiving queue is
#: scoped by `ix_inb_receipts_status_wh` before any of this is read, and `inb_receipts`
#: carries no JSON column, so the CLAUDE.md filesort trap does not apply. A screen that
#: lists "collections outstanding" across every warehouse would want one on
#: `inbound_transport_mode`; nothing does that today.


def _existing_columns(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(table)}


def upgrade() -> None:
    # Idempotent per column, as every migration in this chain is: a database built by
    # `scripts.bootstrap` takes its schema from the models and already has these.
    bind = op.get_bind()

    present = _existing_columns(bind, _RECEIPTS)
    for name, type_, kw in _COLUMNS:
        if name not in present:
            op.add_column(_RECEIPTS, sa.Column(name, type_, **kw))


def downgrade() -> None:
    bind = op.get_bind()

    # Dropping these loses how an expected consignment was going to travel, and nothing
    # about what actually arrived: `received_qty` and `gate_entry_at` are untouched. A
    # downgraded database reads every pending inbound as a delivery, which is exactly the
    # state it was in before this migration.
    present = _existing_columns(bind, _RECEIPTS)
    for name, _type, _kw in reversed(_COLUMNS):
        if name in present:
            op.drop_column(_RECEIPTS, name)
