"""Logistics: the consignment -> dispatch -> acknowledgement flow on one document.

Dispatch stopped being a second document in Logistics. A transport request now carries
the whole leg — the warehouse consignment it moves, the carrier's own answer to the
award, the gate pass it left the yard on, and the signature the receiving site gave it.
So `lgs_transport_requests` grows the columns those four stages write:

  * `consignment_no`            — snapshot of the `out_dispatches` number (`dispatch_id`
                                  already existed; it is a soft pointer, and warehouse
                                  sits after logistics in the import chain)
  * `carrier_accepted_at` / `carrier_declined_at` / `carrier_decline_reason` /
    `carrier_reference` / `carrier_confirmed_by_name`
                                — an award is an offer; a booking is what the carrier
                                  confirms in their portal (status AWAITING_CARRIER)
  * `gate_pass_no`, `dispatched_by_name`
                                — the dispatch leg, written beside the LR it travels on
  * `acknowledged_at` / `acknowledged_by_id` / `acknowledged_by_name` /
    `ack_condition` / `ack_remarks`
                                — doc A6: delivered is the carrier's word, acknowledged
                                  is the site's, and only the second closes the loop

Additive only. No existing column changes type, nothing is dropped, and every step is
guarded on what is already there — safe to re-run, and safe on a database built by
`scripts.bootstrap` (which creates tables from the models, so these already exist).

Revision ID: a1c2e3d4f5b6
Revises: d7e8f9a0b1c2
"""
import sqlalchemy as sa
from alembic import op

revision = "a1c2e3d4f5b6"
down_revision = "d7e8f9a0b1c2"
branch_labels = None
depends_on = None

TABLE = "lgs_transport_requests"

NEW_COLUMNS: tuple[tuple[str, sa.types.TypeEngine], ...] = (
    ("consignment_no", sa.String(50)),
    ("carrier_accepted_at", sa.DateTime),
    ("carrier_declined_at", sa.DateTime),
    ("carrier_decline_reason", sa.String(500)),
    ("carrier_reference", sa.String(100)),
    ("carrier_confirmed_by_name", sa.String(200)),
    ("gate_pass_no", sa.String(50)),
    ("dispatched_by_name", sa.String(200)),
    ("acknowledged_at", sa.DateTime),
    ("acknowledged_by_id", sa.BigInteger),
    ("acknowledged_by_name", sa.String(200)),
    ("ack_condition", sa.String(20)),
    ("ack_remarks", sa.Text),
)


def _columns(table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def upgrade() -> None:
    if TABLE not in set(sa.inspect(op.get_bind()).get_table_names()):
        # Nothing to widen: a database that predates the transport tables gets them
        # from d7e8f9a0b1c2 (or from bootstrap), already with these columns.
        return

    existing = _columns(TABLE)
    for name, type_ in NEW_COLUMNS:
        if name not in existing:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    if TABLE not in set(sa.inspect(op.get_bind()).get_table_names()):
        return
    existing = _columns(TABLE)
    for name, _ in NEW_COLUMNS:
        if name in existing:
            op.drop_column(TABLE, name)
