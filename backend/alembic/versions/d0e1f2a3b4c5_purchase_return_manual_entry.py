"""purchase return: manual entry of the vendor and the lines

ADDED 2026-09-10, asked for by the business owner. Until now a purchase return could
only be raised against a purchase transaction the system already held: the vendor was
read off the GRN/PO and could not be typed (`_assert_vendor_locked`), and every line
came from that source's own lines. That is the right default and it stays the default —
but a warehouse holding goods to send back whose paperwork never reached this system
had no way to raise the document at all.

So a return may now be marked MANUAL, and a manual return carries its own vendor and
its own lines. Nothing about the sourced path changes: `is_manual` defaults to false and
every existing row reads exactly as it did.

`pro_returns`
  * `is_manual`             — this document's vendor and lines were typed, not read.
  * `manual_vendor_*`       — the vendor as typed. Kept in columns of their OWN rather
                              than in the `vendor_*` names the API serves, because
                              `_enrich_return_with_vendor` ASSIGNS those on every read
                              from `mst_vendors` and callers commit afterwards — a
                              manual vendor written there would be wiped by the next
                              `get_return`. The serializer reads these where
                              `is_manual`, so the API contract is unchanged.
  * `source_ref_no`         — the document number the storekeeper typed for their own
                              reference when the system holds no such document.

`pro_return_items`
  * `is_manual`             — this line was typed, so no cap can be computed for it.
  * `original_qty`,
    `previously_returned`,
    `returnable_qty`        — purchased / already returned / available AS TYPED. On a
                              sourced line these three are derived on read from the GRN
                              and stay NULL here; on a manual line there is nothing to
                              derive them from and they are the storekeeper's figures.
  * `item_id` -> NULLABLE   — a manual line names an item that need not exist in
                              `mst_items`. Widening only: every existing row keeps its
                              value and every reader that filters on `item_id` already
                              guards for a missing one.

Revision ID: d0e1f2a3b4c5
Revises: c9d0e1f2a3b4
Create Date: 2026-09-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d0e1f2a3b4c5"
down_revision: Union[str, Sequence[str], None] = "c9d0e1f2a3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_RETURNS = "pro_returns"
_ITEMS = "pro_return_items"

_RETURN_COLUMNS = (
    ("is_manual", sa.Boolean(), {"nullable": False, "server_default": sa.text("0")}),
    ("source_ref_no", sa.String(100), {"nullable": True}),
    ("manual_vendor_code", sa.String(50), {"nullable": True}),
    ("manual_vendor_contact_person", sa.String(200), {"nullable": True}),
    ("manual_vendor_phone", sa.String(50), {"nullable": True}),
    ("manual_vendor_email", sa.String(200), {"nullable": True}),
    ("manual_vendor_address", sa.String(500), {"nullable": True}),
    ("manual_vendor_city", sa.String(100), {"nullable": True}),
    ("manual_vendor_state", sa.String(100), {"nullable": True}),
    ("manual_vendor_pincode", sa.String(20), {"nullable": True}),
    ("manual_vendor_gstin", sa.String(20), {"nullable": True}),
)

_ITEM_COLUMNS = (
    ("is_manual", sa.Boolean(), {"nullable": False, "server_default": sa.text("0")}),
    ("original_qty", sa.Numeric(18, 3), {"nullable": True}),
    ("previously_returned", sa.Numeric(18, 3), {"nullable": True}),
    ("returnable_qty", sa.Numeric(18, 3), {"nullable": True}),
)


def _existing(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(table)}


def upgrade() -> None:
    # Idempotent per column: a database built by `scripts.bootstrap` gets the whole
    # schema from the models and therefore already has these.
    bind = op.get_bind()

    present = _existing(bind, _RETURNS)
    for name, type_, kw in _RETURN_COLUMNS:
        if name not in present:
            op.add_column(_RETURNS, sa.Column(name, type_, **kw))

    present = _existing(bind, _ITEMS)
    for name, type_, kw in _ITEM_COLUMNS:
        if name not in present:
            op.add_column(_ITEMS, sa.Column(name, type_, **kw))

    # NOT NULL -> NULL. Widening, so no row can fail it, and it is what lets a manual
    # line name an item the masters do not hold.
    op.alter_column(_ITEMS, "item_id", existing_type=sa.BigInteger(), nullable=True)


def downgrade() -> None:
    bind = op.get_bind()

    # Manual lines have no `item_id` and the column is about to demand one, so they go
    # first — a downgrade that left them would fail on the ALTER and roll back with the
    # new columns already dropped.
    op.execute(sa.text(f"DELETE FROM {_ITEMS} WHERE item_id IS NULL"))
    op.alter_column(_ITEMS, "item_id", existing_type=sa.BigInteger(), nullable=False)

    present = _existing(bind, _ITEMS)
    for name, _, _kw in reversed(_ITEM_COLUMNS):
        if name in present:
            op.drop_column(_ITEMS, name)

    present = _existing(bind, _RETURNS)
    for name, _, _kw in reversed(_RETURN_COLUMNS):
        if name in present:
            op.drop_column(_RETURNS, name)
