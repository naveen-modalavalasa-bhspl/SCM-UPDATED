"""purchase return: the supplier's receipt and their answer

ADDED 2026-09-11. A purchase return could be SENT to a supplier and read by them on
the portal, and there it stopped — the supplier had no way to say the lorry had
actually arrived, and no way to say what they were doing about the goods. The store
found out by telephone or not at all.

Two separate facts, in two separate groups of columns, because they are answered at
two different moments by two different acts:

`vendor_receipt_*`  — the physical handover. Signed once, when the consignment is put
                      into the supplier's hands. Carries who signed, the vehicle it
                      came off and the moment, which is what an acknowledgement receipt
                      has to show. Independent of the answer below: goods can be
                      received and not yet judged, and (by the business owner's
                      instruction on 2026-09-11) judged without having been signed for.

`vendor_response*`  — the decision: ACCEPTED, RETURNED or REPLACED. Answered once.
                      RETURNED and REPLACED both mean goods are travelling back to us,
                      so each raises a DRAFT inbound receipt and the two columns below
                      remember which one, so the answer can never be given twice and
                      the document it produced is always reachable from the return.

`vendor_followup_receipt_id/_no`
                    — the `inb_receipts` row raised by that answer. A soft link, and
                      nullable: an ACCEPTED return raises nothing at all.

Every column is NULLABLE with no default, so all 2 existing rows and every row raised
before today read exactly as they did — a return with no answer yet is one where all
of these are NULL, which is precisely the state they start in.

Revision ID: b9f1c3d5e7a2
Revises: d0e1f2a3b4c5
Create Date: 2026-09-11

NOTE ON THE ID. The obvious next id in the house sequence (`e1f2a3b4c5d6`) was already
taken by `e1f2a3b4c5d6_po_buying_chain_links.py`, which declares it without the `: str`
annotation the later files use — so a grep for the annotated form misses it and Alembic
only complains at run time, with a cycle error that names forty revisions and not the
duplicate. Check `revision` with and without the annotation before picking one.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b9f1c3d5e7a2"
down_revision: Union[str, Sequence[str], None] = "d0e1f2a3b4c5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_RETURNS = "pro_returns"

_RETURN_COLUMNS = (
    ("vendor_receipt_confirmed_at", sa.DateTime(), {"nullable": True}),
    ("vendor_receipt_by_name", sa.String(200), {"nullable": True}),
    ("vendor_receipt_vehicle_no", sa.String(50), {"nullable": True}),
    ("vendor_receipt_remarks", sa.Text(), {"nullable": True}),
    ("vendor_response", sa.String(30), {"nullable": True}),
    ("vendor_response_at", sa.DateTime(), {"nullable": True}),
    ("vendor_response_note", sa.Text(), {"nullable": True}),
    ("vendor_followup_receipt_id", sa.BigInteger(), {"nullable": True}),
    ("vendor_followup_receipt_no", sa.String(50), {"nullable": True}),
)

#: Answered-or-not is the filter every portal and store screen runs ("which returns are
#: still waiting on the supplier"), so it gets the one index. The rest are read only
#: once a single document is already open.
_INDEX = ("ix_pro_returns_vendor_response", _RETURNS, ["vendor_response"])


def _existing_columns(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_columns(table)}


def _existing_indexes(bind, table: str) -> set[str]:
    return {row["name"] for row in sa.inspect(bind).get_indexes(table)}


def upgrade() -> None:
    # Idempotent per column, exactly as `d0e1f2a3b4c5` is: a database built by
    # `scripts.bootstrap` takes the whole schema from the models and already has these.
    bind = op.get_bind()

    present = _existing_columns(bind, _RETURNS)
    for name, type_, kw in _RETURN_COLUMNS:
        if name not in present:
            op.add_column(_RETURNS, sa.Column(name, type_, **kw))

    name, table, cols = _INDEX
    if name not in _existing_indexes(bind, table):
        op.create_index(name, table, cols)


def downgrade() -> None:
    bind = op.get_bind()

    name, table, _cols = _INDEX
    if name in _existing_indexes(bind, table):
        op.drop_index(name, table_name=table)

    present = _existing_columns(bind, _RETURNS)
    for name, _type, _kw in reversed(_RETURN_COLUMNS):
        if name in present:
            op.drop_column(_RETURNS, name)
