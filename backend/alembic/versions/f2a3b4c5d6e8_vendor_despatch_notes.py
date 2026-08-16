"""The vendor's own statement of a delivery, filed before it arrives.

Doc B12 makes the invoice and e-way bill mandatory before dispatch. Until now that
paperwork reached us on paper and a storekeeper retyped it at the gate — including a
batch and an expiry per line, which cannot be derived from the order and drive FEFO
picking for the rest of the item's life.

Two new tables, nothing altered: a despatch note is a claim, never a stock movement,
so no existing table changes shape.

Revision ID: f2a3b4c5d6e8
Revises: e1f2a3b4c5d6
"""
from alembic import op
import sqlalchemy as sa

revision = "f2a3b4c5d6e8"
down_revision = "e1f2a3b4c5d6"
branch_labels = None
depends_on = None

NOTES = "pro_despatch_notes"
ITEMS = "pro_despatch_note_items"
RECEIPTS = "inb_receipts"
RECEIPT_COLUMNS = [
    ("despatch_note_id", sa.BigInteger()),
    ("despatch_note_no", sa.String(30)),
]


def _tables(bind) -> set[str]:
    return set(sa.inspect(bind).get_table_names())


def upgrade() -> None:
    bind = op.get_bind()
    present = _tables(bind)

    # The receipt's pointer back at the note it was received against. Added only if the
    # table is there — a fresh database builds it from the models instead.
    if RECEIPTS in present:
        have = {c["name"] for c in sa.inspect(bind).get_columns(RECEIPTS)}
        for name, type_ in RECEIPT_COLUMNS:
            if name not in have:
                op.add_column(RECEIPTS, sa.Column(name, type_, nullable=True))
        indexes = {i["name"] for i in sa.inspect(bind).get_indexes(RECEIPTS)}
        if "ix_inb_receipts_despatch_note_id" not in indexes:
            op.create_index("ix_inb_receipts_despatch_note_id", RECEIPTS,
                            ["despatch_note_id"])

    if NOTES not in present:
        op.create_table(
            NOTES,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("dn_no", sa.String(30), nullable=False, unique=True),
            sa.Column("dn_date", sa.Date(), nullable=True),
            sa.Column("po_id", sa.BigInteger(), nullable=False),
            sa.Column("po_no", sa.String(30), nullable=True),
            sa.Column("vendor_id", sa.BigInteger(), nullable=False),
            sa.Column("vendor_name", sa.String(200), nullable=True),
            sa.Column("invoice_no", sa.String(50), nullable=True),
            sa.Column("invoice_date", sa.Date(), nullable=True),
            sa.Column("invoice_amount", sa.Numeric(16, 2), nullable=True),
            sa.Column("eway_bill_no", sa.String(50), nullable=True),
            sa.Column("vehicle_no", sa.String(50), nullable=True),
            sa.Column("transporter_name", sa.String(200), nullable=True),
            sa.Column("lr_no", sa.String(50), nullable=True),
            sa.Column("expected_date", sa.Date(), nullable=True),
            sa.Column("status", sa.String(30), nullable=False, server_default="DRAFT"),
            sa.Column("remarks", sa.Text(), nullable=True),
            sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=True),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
        op.create_index(f"ix_{NOTES}_po_id", NOTES, ["po_id"])
        op.create_index(f"ix_{NOTES}_vendor_id", NOTES, ["vendor_id"])
        op.create_index(f"ix_{NOTES}_status", NOTES, ["status"])
        op.create_index("ix_pro_dn_po_status", NOTES, ["po_id", "status"])

    if ITEMS not in present:
        op.create_table(
            ITEMS,
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column("despatch_note_id", sa.BigInteger(), nullable=False),
            sa.Column("line_no", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("po_item_id", sa.BigInteger(), nullable=True),
            sa.Column("item_id", sa.BigInteger(), nullable=False),
            sa.Column("item_code", sa.String(50), nullable=True),
            sa.Column("item_name", sa.String(300), nullable=True),
            sa.Column("uom_code", sa.String(20), nullable=True),
            sa.Column("despatched_qty", sa.Numeric(16, 3), nullable=False,
                      server_default="0"),
            sa.Column("batch_no", sa.String(50), nullable=True),
            sa.Column("mfg_date", sa.Date(), nullable=True),
            sa.Column("expiry_date", sa.Date(), nullable=True),
            sa.Column("remarks", sa.String(500), nullable=True),
            sa.ForeignKeyConstraint(["despatch_note_id"], [f"{NOTES}.id"],
                                    ondelete="CASCADE"),
        )
        op.create_index(f"ix_{ITEMS}_note", ITEMS, ["despatch_note_id"])
        op.create_index(f"ix_{ITEMS}_item_id", ITEMS, ["item_id"])


def downgrade() -> None:
    bind = op.get_bind()
    present = _tables(bind)
    if ITEMS in present:
        op.drop_table(ITEMS)
    if NOTES in present:
        op.drop_table(NOTES)
