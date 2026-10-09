"""Link a purchase order back to the requisition, RFQ and quotation it came from.

Until now `pro_purchase_orders` pointed only at an indent, so a PO raised off an
awarded quotation had nowhere to record which offer it was written against and the
chain indent -> MR -> requisition -> RFQ -> quotation -> PO broke at the last hop.

Idempotent: each column is added only if it is not already there, because the live
schema and the ORM have drifted before and a re-run must not stop on 1060.

Revision ID: e1f2a3b4c5d6
Revises: d7e8f9a0b1c2
"""
from alembic import op
import sqlalchemy as sa

revision = "e1f2a3b4c5d6"
down_revision = "d7e8f9a0b1c2"
branch_labels = None
depends_on = None

TABLE = "pro_purchase_orders"
COLUMNS = [
    ("requisition_id", sa.BigInteger()),
    ("requisition_no", sa.String(30)),
    ("rfq_id", sa.BigInteger()),
    ("rfq_no", sa.String(30)),
    ("quotation_id", sa.BigInteger()),
    ("quotation_no", sa.String(50)),
]
INDEXES = [
    ("ix_pro_po_requisition_id", "requisition_id"),
    ("ix_pro_po_rfq_id", "rfq_id"),
    ("ix_pro_po_quotation_id", "quotation_id"),
]


def _existing(bind, table: str) -> set[str]:
    return {c["name"] for c in sa.inspect(bind).get_columns(table)}


def upgrade() -> None:
    bind = op.get_bind()
    present = _existing(bind, TABLE)
    for name, type_ in COLUMNS:
        if name not in present:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))
    have = {i["name"] for i in sa.inspect(bind).get_indexes(TABLE)}
    for index_name, column in INDEXES:
        if index_name not in have:
            op.create_index(index_name, TABLE, [column])


def downgrade() -> None:
    bind = op.get_bind()
    have = {i["name"] for i in sa.inspect(bind).get_indexes(TABLE)}
    for index_name, _column in INDEXES:
        if index_name in have:
            op.drop_index(index_name, table_name=TABLE)
    present = _existing(bind, TABLE)
    for name, _type in COLUMNS:
        if name in present:
            op.drop_column(TABLE, name)
