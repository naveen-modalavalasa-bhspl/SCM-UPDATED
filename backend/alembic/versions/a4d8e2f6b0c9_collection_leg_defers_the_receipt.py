"""a vendor collection raises the TRIP first and the receipt afterwards

ADDED 2026-09-11, on top of `f3c5a7b9d1e4`. That migration taught the supplier portal to
say WE_COLLECT — the replacement is ready on the supplier's dock and one of our vehicles
has to fetch it — and raised the same DRAFT `inb_receipts` row for it that a delivery
gets, only without a date.

That row was the wrong document at the wrong moment. A receipt is a WAREHOUSE document,
and on a collection there is nothing for the warehouse to do yet: no vehicle has been
sent, no date exists, and nobody knows when the goods will be in the building. What the
answer actually creates is a TRIP, and the trip belongs to the logistics desk. Raising
the receipt there and then put a dateless draft in the store's queue for goods nobody
had gone to collect, and left the collection itself recorded nowhere anybody works from.

So on a collection the receipt is now raised when the leg is ACKNOWLEDGED — when our
vehicle has actually brought the goods back — and these columns are what carries the
answer across that gap.

ON `pro_returns`, the collection's own facts and the leg it raised:

`collection_tr_id`         the `lgs_transport_requests` row raised to go and fetch it,
`collection_tr_no`         with its number snapshotted beside it. A SOFT link and an
                           index, never a foreign key: logistics sits BEFORE warehouse in
                           the import chain (rule 5) and a return outlives a leg somebody
                           may cancel. The id is what `transport_acknowledged` matches on
                           to find the return behind a leg that has landed.
`collection_pickup_address` where our vehicle goes, and
`collection_ready_date`     the earliest it may go. These lived on `inb_receipts` and
                           still do for a delivery; on a collection there is no receipt
                           yet to hold them, and they are what the supplier was promised
                           we would act on.

ON `pro_return_items`, what the SUPPLIER said is in each carton:

`replacement_batch_no`     the lot number,
`replacement_mfg_date`     and the two dates printed on it.
`replacement_expiry_date`

These are asked for, and REFUSED if missing, at the moment the supplier answers — a
batch-tracked line with no batch and an expiry-tracked line with no expiry both stop the
GRN later, and only the supplier can read them off a carton standing in their own
warehouse. That validation does not move. What moves is the receipt those answers used
to be written straight onto, so the answers have to be kept somewhere until it exists.
The return line is that somewhere: it is already one row per item, already the thing the
receipt line is built from, and it outlives every document either side of it.

A SUPPLIER_DELIVERS replacement and a RETURNED consignment are untouched by all of this
and still raise their receipt the instant the supplier answers. Their goods are already
on a vehicle heading towards us; there is no trip to arrange and nothing to wait for.

Every column NULLABLE with no default. Null is meaningful rather than missing: on
`pro_returns` it is "no collection was ever asked for", which is true of every row before
today, and on `pro_return_items` it is "the supplier stated nothing about this line",
which is true of every line that is not a replacement.

Revision ID: a4d8e2f6b0c9
Revises: f3c5a7b9d1e4
Create Date: 2026-09-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a4d8e2f6b0c9"
down_revision: Union[str, Sequence[str], None] = "f3c5a7b9d1e4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_RETURNS = "pro_returns"
_RETURN_ITEMS = "pro_return_items"

_RETURN_COLUMNS = (
    ("collection_tr_id", sa.BigInteger(), {"nullable": True}),
    ("collection_tr_no", sa.String(50), {"nullable": True}),
    ("collection_pickup_address", sa.String(500), {"nullable": True}),
    ("collection_ready_date", sa.Date(), {"nullable": True}),
)

_ITEM_COLUMNS = (
    ("replacement_batch_no", sa.String(50), {"nullable": True}),
    ("replacement_mfg_date", sa.Date(), {"nullable": True}),
    ("replacement_expiry_date", sa.Date(), {"nullable": True}),
)

#: The one lookup that has to be fast: `transport_acknowledged` runs on every shipment
#: signature in the system and asks "is there a purchase return waiting on this leg?".
#: Without an index that is a full scan of `pro_returns` per acknowledgement.
#:
#: `pro_returns` carries NO JSON column, so the filesort trap in CLAUDE.md does not apply
#: here — but the index is still what keeps the question cheap.
_INDEX = ("ix_pro_returns_collection_tr", _RETURNS, ["collection_tr_id"])


def _existing_columns(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(table)}


def _existing_indexes(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    # Idempotent per column, as every migration in this chain is: a database built by
    # `scripts.bootstrap` takes its schema from the models and already has these.
    bind = op.get_bind()

    present = _existing_columns(bind, _RETURNS)
    for name, type_, kw in _RETURN_COLUMNS:
        if name not in present:
            op.add_column(_RETURNS, sa.Column(name, type_, **kw))

    present = _existing_columns(bind, _RETURN_ITEMS)
    for name, type_, kw in _ITEM_COLUMNS:
        if name not in present:
            op.add_column(_RETURN_ITEMS, sa.Column(name, type_, **kw))

    name, table, cols = _INDEX
    if name not in _existing_indexes(bind, table):
        op.create_index(name, table, cols)


def downgrade() -> None:
    bind = op.get_bind()

    name, table, _cols = _INDEX
    if name in _existing_indexes(bind, table):
        op.drop_index(name, table_name=table)

    # Dropping these loses the link from a return to the leg fetching its replacement,
    # and what the supplier said was in the cartons. Nothing about stock: no balance and
    # no ledger row is derived from any of it. A downgraded database reads every
    # collection as a return whose receipt was never raised, which is the state it would
    # have been in before this migration.
    present = _existing_columns(bind, _RETURN_ITEMS)
    for name, _type, _kw in reversed(_ITEM_COLUMNS):
        if name in present:
            op.drop_column(_RETURN_ITEMS, name)

    present = _existing_columns(bind, _RETURNS)
    for name, _type, _kw in reversed(_RETURN_COLUMNS):
        if name in present:
            op.drop_column(_RETURNS, name)
