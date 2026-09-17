"""a sent purchase return is decided, and the material is brought back

ADDED 2026-09-11, on top of `a4d8e2f6b0c9`.

A purchase return stopped dead at SENT_TO_VENDOR. The consignment was in the vendor's
hands, the review screen went read-only, and two facts the business works from every day
had nowhere to live: whether anybody had AGREED the return, and whose vehicle was
bringing the material back to the warehouse. Both were settled on the phone and the
system held neither, so "where is that return" could only be answered by asking the
person who made the call.

So a sent return is now answered Approve or Reject, and an approval opens the one fork
the inbound leg has — the vendor puts it on their own vehicle, or the warehouse asks
Logistics for one, who arrange and assign a vehicle, collect from the vendor and deliver
to the warehouse.

    SENT_TO_VENDOR --Reject--> REJECTED
                   --Approve-> VENDOR_APPROVED
                                 |- Vendor arranges  -> AWAITING_VENDOR_VEHICLE
                                 |                   -> IN_TRANSIT
                                 '- Warehouse asks   -> VEHICLE_REQUESTED   (leg raised)
                                                     -> IN_TRANSIT          (leg released)
                               -> RECEIVED_AT_WAREHOUSE -> COMPLETED

No new table and no new status column: `pro_returns.status` is a plain `String(30)` with
no database ENUM behind it, so the six new rungs are `enums.ReturnStatus` members and
need nothing here. What this migration adds is the facts those rungs are about.

THE DECISION, answered once:

`vendor_decision`           APPROVED / REJECTED,
`vendor_decision_at`        when,
`vendor_decision_by_id`     and by whom — a soft, indexed link to `hcm_employees`, like
`vendor_decision_by_name`   every other actor column here, with the name snapshotted
                            beside it so a decision still reads after a cutover re-keys
                            the mirror.
`vendor_decision_note`      why. Required on a rejection, optional on an approval.

Stored beside `status` rather than derived from it because the status moves on
afterwards — through the arrangement, the vehicle and the arrival — and "who agreed
this, and when" has to stay readable at every one of those rungs.

WHO PROVIDES THE VEHICLE:

`vehicle_arrangement`       VENDOR_ARRANGES / WAREHOUSE_REQUESTS
`vehicle_arrangement_at`    (`enums.ReturnVehicleArrangement`), and who picked it. A
`vehicle_arrangement_by_name` plain String, like `status` and `vendor_response` beside
                            it, so the column outlives any renaming of the enum.

THE LOGISTICS LEG, on a warehouse-requested vehicle only:

`inbound_tr_id`             the `lgs_transport_requests` row raised to go and fetch it,
`inbound_tr_no`             with its number snapshotted beside it.
`inbound_pickup_address`    where that vehicle collects from, and
`inbound_ready_date`        the earliest it may go.

ITS OWN PAIR, deliberately NOT the `collection_tr_*` pair `a4d8e2f6b0c9` added. The two
trips look alike — both run the vendor's dock to our warehouse on our own vehicle — but
they settle differently: `_collection_arrived` matches an acknowledged leg to
`collection_tr_id` and raises an inbound RECEIPT against the supplier's stored REPLACED
answer. A return that got here through the decision desk has no such answer, so sharing
the column would have that settlement fire on a document it was never written for.
Separate columns is what makes the two provably independent.

THE VEHICLE ITSELF, on a vendor-arranged leg only:

`arranged_vehicle_no`       what the vendor said is coming, and who is driving it.
`arranged_driver_name`
`arranged_driver_phone`
`arranged_transporter_name`
`arranged_lr_no`
`arranged_expected_date`
`arranged_dispatched_at`    when it left the vendor.

Named `arranged_*` and NOT `inbound_*`, which is the shape the API serves, for the same
reason `manual_vendor_*` is not `vendor_*`: the served names are assigned as transient
attributes on every read — filled from the transport request where there is one — and
several callers commit straight afterwards. A vendor-stated vehicle stored under the
served names would be silently overwritten with logistics' copy on the next load.

On a warehouse-requested leg nothing is stored here at all: the vehicle and the driver
belong to the transport request logistics assigned them on and are READ off it, exactly
as `dispatch_no` already is. A second copy would go stale the first time the desk
re-assigned a truck, and the return would then name a vehicle that was never coming.

THE ARRIVAL:

`received_at`               when the material was signed in at the gate,
`received_by_name`          by whom, and
`received_remarks`          anything said about it.

A signature at the gate, and nothing more: NO STOCK MOVES on any of this. What the goods
are worth to us is still `complete_return`'s question, still guarded on its own statuses,
and still the only path that calls `move_stock_out` (rule 7). `RECEIVED_AT_WAREHOUSE`
joins the statuses that press accepts; the three that were already there are untouched,
so every return in flight under the older flow closes exactly as it did.

Every column NULLABLE with no default. Null is meaningful rather than missing: it is "the
sent return has not been decided", which is true of every row raised before today and is
the state a new one starts in. Nothing already in flight reads differently, and a
database that has this migration but not the code behind it simply has nineteen unread
columns.

Revision ID: b7e3c1a9d5f2
Revises: a4d8e2f6b0c9
Create Date: 2026-09-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b7e3c1a9d5f2"
down_revision: Union[str, Sequence[str], None] = "a4d8e2f6b0c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_RETURNS = "pro_returns"

_COLUMNS = (
    # The decision on a sent return.
    ("vendor_decision", sa.String(20), {"nullable": True}),
    ("vendor_decision_at", sa.DateTime(), {"nullable": True}),
    ("vendor_decision_by_id", sa.BigInteger(), {"nullable": True}),
    ("vendor_decision_by_name", sa.String(200), {"nullable": True}),
    ("vendor_decision_note", sa.Text(), {"nullable": True}),
    # Who provides the vehicle.
    ("vehicle_arrangement", sa.String(30), {"nullable": True}),
    ("vehicle_arrangement_at", sa.DateTime(), {"nullable": True}),
    ("vehicle_arrangement_by_name", sa.String(200), {"nullable": True}),
    # The Logistics leg, on a warehouse-requested vehicle.
    ("inbound_tr_id", sa.BigInteger(), {"nullable": True}),
    ("inbound_tr_no", sa.String(50), {"nullable": True}),
    ("inbound_pickup_address", sa.String(500), {"nullable": True}),
    ("inbound_ready_date", sa.Date(), {"nullable": True}),
    # The vehicle, on a vendor-arranged leg.
    ("arranged_vehicle_no", sa.String(50), {"nullable": True}),
    ("arranged_driver_name", sa.String(200), {"nullable": True}),
    ("arranged_driver_phone", sa.String(30), {"nullable": True}),
    ("arranged_transporter_name", sa.String(200), {"nullable": True}),
    ("arranged_lr_no", sa.String(50), {"nullable": True}),
    ("arranged_expected_date", sa.Date(), {"nullable": True}),
    ("arranged_dispatched_at", sa.DateTime(), {"nullable": True}),
    # The arrival.
    ("received_at", sa.DateTime(), {"nullable": True}),
    ("received_by_name", sa.String(200), {"nullable": True}),
    ("received_remarks", sa.Text(), {"nullable": True}),
)

#: Two lookups that have to be fast.
#:
#: `ix_pro_returns_inbound_tr` — the release and the acknowledgement hooks both ask "is a
#: purchase return waiting on this leg?" on EVERY shipment in the system, not only on
#: returns. Without an index that is a full scan of `pro_returns` per press.
#:
#: `ix_pro_returns_vendor_decision_by` — the same soft-link-plus-index shape every other
#: actor column here has (`created_by_id`), so "what has this person decided" is
#: answerable without a scan.
#:
#: `pro_returns` carries NO JSON column, so the filesort trap in CLAUDE.md does not apply
#: to it — these are about keeping the questions above cheap, nothing more.
#:
#: NAMED EXACTLY AS SQLAlchemy NAMES THEM (`ix_<table>_<column>`), because both columns
#: carry `index=True` on the model and a `scripts.bootstrap` database therefore already
#: has them under those names. Inventing a shorter name here would leave such a database
#: with two identical indexes on one column — the idempotency check above matches on the
#: NAME, so a different one is not recognised as already present.
_INDEXES = (
    ("ix_pro_returns_inbound_tr_id", _RETURNS, ["inbound_tr_id"]),
    ("ix_pro_returns_vendor_decision_by_id", _RETURNS, ["vendor_decision_by_id"]),
)


def _existing_columns(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(table)}


def _existing_indexes(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    # Idempotent per column, as every migration in this chain is: a database built by
    # `scripts.bootstrap` takes its schema from the models and already has these.
    bind = op.get_bind()

    present = _existing_columns(bind, _RETURNS)
    for name, type_, kw in _COLUMNS:
        if name not in present:
            op.add_column(_RETURNS, sa.Column(name, type_, **kw))

    existing = _existing_indexes(bind, _RETURNS)
    for name, table, cols in _INDEXES:
        if name not in existing:
            op.create_index(name, table, cols)


def downgrade() -> None:
    bind = op.get_bind()

    existing = _existing_indexes(bind, _RETURNS)
    for name, table, _cols in _INDEXES:
        if name in existing:
            op.drop_index(name, table_name=table)

    # Dropping these loses the decision on every sent return and the link to the leg
    # bringing its material back. Nothing about stock: no balance and no ledger row is
    # derived from any of it, because none of these columns was ever allowed to move
    # stock. A downgraded database reads every sent return as one nobody has answered,
    # which is the state it would have been in before this migration — and any return
    # already carrying one of the new statuses keeps it, since `status` is a plain
    # String and this migration never touched it.
    present = _existing_columns(bind, _RETURNS)
    for name, _type, _kw in reversed(_COLUMNS):
        if name in present:
            op.drop_column(_RETURNS, name)
